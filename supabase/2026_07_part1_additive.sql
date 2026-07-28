-- ============================================================================
-- GrantLume — CRITICAL security fixes, PART 1 of 2 : ADDITIVE
-- ============================================================================
--
--   ►  RUN THIS FIRST. It is safe to run while the CURRENT (old) code is live.
--   ►  Nothing in this file breaks the running application.
--
-- It closes the worst holes immediately — org takeover, the persons_masked
-- RLS bypass, the grant-uploads bucket, the leaky invite-token policy — and
-- creates everything the new code needs (persons_secure, get_personnel_costs,
-- the email/user-lookup RPCs, the notification CHECK, the upsert indexes).
--
-- The three changes that would break the old client are deferred to
-- PART 2 (2026_07_part2_lockdown.sql):
--     1. REVOKE SELECT on persons          (hides salary)
--     2. REVOKE SELECT on organisations    (hides the DocuSign private key)
--     3. project-documents bucket → private
--
-- DEPLOY ORDER
--   1. Back up / create a restore point.
--   2. Run THIS file.                       ← app keeps working, old or new
--   3. Deploy the application code.
--   4. Run PART 2.                          ← finishes the lockdown
--   5. Run the verification queries at the end of PART 2.
--
-- FRESH OR STAGING DATABASE (no live users)?
--   Just run PART 1 then PART 2 back to back. The split only exists to avoid
--   a breakage window against a running old client.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

-- ============================================================================
-- C0. Shared helper functions
-- ============================================================================
-- All of these are SECURITY DEFINER with a pinned search_path so they can read
-- org_members (which is itself under RLS) without recursion, and so a hostile
-- schema on the search path cannot hijack resolution.

-- The caller's organisation. Deterministic ordering so a user who ends up in
-- two organisations always resolves to the same one (their oldest membership)
-- instead of an arbitrary row. See BACKLOG.md B20 for the proper multi-org fix.
CREATE OR REPLACE FUNCTION auth_org_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT org_id
  FROM public.org_members
  WHERE user_id = auth.uid()
  ORDER BY created_at ASC, id ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION auth_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT role
  FROM public.org_members
  WHERE user_id = auth.uid()
  ORDER BY created_at ASC, id ASC
  LIMIT 1;
$$;

-- Legacy aliases used by some migrations. Kept in sync so both names behave
-- identically. (BACKLOG B29 tracks consolidating on one pair.)
CREATE OR REPLACE FUNCTION get_user_org_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$ SELECT public.auth_org_id(); $$;

CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$ SELECT public.auth_role(); $$;

-- Is the caller a member of this specific organisation? Used instead of
-- `org_id = auth_org_id()` where multi-org correctness matters.
CREATE OR REPLACE FUNCTION is_org_member(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_members
    WHERE user_id = auth.uid() AND org_id = p_org_id
  );
$$;

CREATE OR REPLACE FUNCTION is_org_admin(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_members
    WHERE user_id = auth.uid() AND org_id = p_org_id AND role = 'Admin'
  );
$$;

-- Salary visibility. Admins always qualify. Everyone else must have
-- can_see_salary_info = TRUE in their org's role_permissions row. If the
-- role_permissions table has no row for that role we fail CLOSED.
CREATE OR REPLACE FUNCTION can_see_salary()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org  UUID := public.auth_org_id();
  v_role TEXT := public.auth_role();
  v_ok   BOOLEAN;
BEGIN
  IF v_org IS NULL OR v_role IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_role = 'Admin' THEN
    RETURN TRUE;
  END IF;

  SELECT rp.can_see_salary_info INTO v_ok
  FROM public.role_permissions rp
  WHERE rp.org_id = v_org AND rp.role = v_role;

  RETURN COALESCE(v_ok, FALSE);
END;
$$;

-- Financial-detail visibility, same shape as can_see_salary().
CREATE OR REPLACE FUNCTION can_see_financial_details()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org  UUID := public.auth_org_id();
  v_role TEXT := public.auth_role();
  v_ok   BOOLEAN;
BEGIN
  IF v_org IS NULL OR v_role IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_role IN ('Admin', 'Finance Officer') THEN
    RETURN TRUE;
  END IF;

  SELECT rp.can_see_financial_details INTO v_ok
  FROM public.role_permissions rp
  WHERE rp.org_id = v_org AND rp.role = v_role;

  RETURN COALESCE(v_ok, FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION auth_org_id()                TO authenticated;
GRANT EXECUTE ON FUNCTION auth_role()                  TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_org_id()            TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_role()              TO authenticated;
GRANT EXECUTE ON FUNCTION is_org_member(UUID)          TO authenticated;
GRANT EXECUTE ON FUNCTION is_org_admin(UUID)           TO authenticated;
GRANT EXECUTE ON FUNCTION can_see_salary()             TO authenticated;
GRANT EXECUTE ON FUNCTION can_see_financial_details()  TO authenticated;


-- ============================================================================
-- C1. TENANT TAKEOVER — org_members self-insert
-- ============================================================================
-- Before: WITH CHECK (user_id = auth.uid()) — it checked WHO but never WHICH
-- ORGANISATION. Any authenticated user could insert themselves as Admin of any
-- org whose UUID they knew, then read and modify everything in it.
--
-- After: self-insert is only permitted into an organisation that has no
-- members yet (the genuine onboarding case). Every other path to membership
-- goes through create_organisation() or an Admin, both of which are checked.

-- The policy is REMOVED outright rather than narrowed.
--
-- Nothing in the client inserts into org_members. There are exactly two ways
-- a membership is created, and neither needs this policy:
--   1. Onboarding  → create_organisation() below, SECURITY DEFINER.
--   2. Invitations → /api/members?action=invite-member, service role, gated
--                    by requireOrgAdmin().
-- Admins managing existing members are covered by "orgmem_all_admin".
--
-- A narrower "only if the org has no members yet" policy was considered and
-- rejected: a subquery on org_members inside an org_members policy re-enters
-- the same policy and Postgres raises "infinite recursion detected in policy".
DROP POLICY IF EXISTS "orgmem_insert_self" ON org_members;
DROP POLICY IF EXISTS "orgmem_insert_self_bootstrap_only" ON org_members;

-- Admins may still manage members of their own org. Re-stated with an explicit
-- WITH CHECK so an Admin cannot move a row into a different organisation.
DROP POLICY IF EXISTS "orgmem_all_admin" ON org_members;
CREATE POLICY "orgmem_all_admin"
  ON org_members FOR ALL
  TO authenticated
  USING      (is_org_admin(org_id))
  WITH CHECK (is_org_admin(org_id));

-- Read policies: own row, plus everyone in your own org.
DROP POLICY IF EXISTS "orgmem_select_own" ON org_members;
CREATE POLICY "orgmem_select_own"
  ON org_members FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "orgmem_select_org" ON org_members;
CREATE POLICY "orgmem_select_org"
  ON org_members FOR SELECT
  TO authenticated
  USING (is_org_member(org_id));

-- Organisations: creation now goes exclusively through create_organisation(),
-- which is SECURITY DEFINER and enforces "one org per user". Drop the blanket
-- INSERT policy that let any authenticated user spam organisation rows.
DROP POLICY IF EXISTS "org_insert_authenticated" ON organisations;

DROP POLICY IF EXISTS "org_select_members" ON organisations;
CREATE POLICY "org_select_members"
  ON organisations FOR SELECT
  TO authenticated
  USING (is_org_member(id));

DROP POLICY IF EXISTS "org_update_admin" ON organisations;
CREATE POLICY "org_update_admin"
  ON organisations FOR UPDATE
  TO authenticated
  USING      (is_org_admin(id))
  WITH CHECK (is_org_admin(id));

-- Make sure create_organisation() is present and hardened (it is the only
-- remaining way to create an organisation from the client).
CREATE OR REPLACE FUNCTION create_organisation(
  p_name     TEXT,
  p_currency TEXT DEFAULT 'EUR'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id  UUID;
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Organisation name is required';
  END IF;

  IF EXISTS (SELECT 1 FROM public.org_members WHERE user_id = v_user_id) THEN
    RAISE EXCEPTION 'User already belongs to an organisation';
  END IF;

  INSERT INTO public.organisations (name, currency, plan, trial_ends_at)
  VALUES (btrim(p_name), COALESCE(p_currency, 'EUR'), 'trial', NOW() + INTERVAL '30 days')
  RETURNING id INTO v_org_id;

  INSERT INTO public.org_members (user_id, org_id, role)
  VALUES (v_user_id, v_org_id, 'Admin');

  RETURN v_org_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_organisation(TEXT, TEXT) TO authenticated;


-- ============================================================================
-- C2. persons_masked bypassed RLS entirely
-- ============================================================================
-- A PostgreSQL view runs with the VIEW OWNER's privileges unless
-- security_invoker is set. persons_masked was created by the `postgres` role,
-- which has BYPASSRLS — so `select * from persons_masked` returned every
-- person in EVERY organisation. staffService used this view as the default
-- read path for any user without salary permission.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'persons_masked' AND c.relkind = 'v'
  ) THEN
    EXECUTE 'ALTER VIEW public.persons_masked SET (security_invoker = true)';
  END IF;
END $$;


-- ============================================================================
-- C3. Salary and overhead readable by every org member
-- ============================================================================
-- RLS is row-level only, so the "masked view" pattern did nothing to stop a
-- direct `select('*')` on persons. Revoke the sensitive columns outright, and
-- expose them through a view that checks can_see_salary().
--
-- Note: revoking SELECT on a column does NOT affect UPDATE/INSERT on it, so
-- Admins can still edit salaries — they just cannot read them back in a
-- RETURNING clause. The client has been updated to select explicit columns.

-- >>> The REVOKE that actually hides the salary columns lives in PART 2.
--     It is deferred because it breaks the OLD client's `select('*')` on
--     persons. Everything above (the persons_secure view, can_see_salary())
--     is additive and safe to run while the old code is still live.

-- persons_secure: the single read path for staff data.
--   * NOT security_invoker — it must be able to read the revoked columns.
--   * Therefore it enforces org scoping in its own WHERE clause.
--   * Salary/overhead come back NULL unless can_see_salary() is true.
DROP VIEW IF EXISTS persons_secure;
CREATE VIEW persons_secure AS
SELECT
  p.id,
  p.org_id,
  p.full_name,
  p.email,
  p.department,
  p.role,
  p.employment_type,
  p.fte,
  p.start_date,
  p.end_date,
  p.country,
  p.region,
  p.is_active,
  p.avatar_url,
  p.vacation_days_per_year,
  p.user_id,
  p.invite_status,
  p.invite_role,
  p.created_at,
  p.updated_at,
  CASE WHEN can_see_salary() THEN p.annual_salary ELSE NULL END AS annual_salary,
  CASE WHEN can_see_salary() THEN p.overhead_rate ELSE NULL END AS overhead_rate
FROM persons p
WHERE p.org_id = auth_org_id();

GRANT SELECT ON persons_secure TO authenticated;

-- Aggregate personnel cost, so the financials module never has to pull
-- individual salaries into the browser. Returns nothing unless the caller has
-- financial-detail permission.
CREATE OR REPLACE FUNCTION get_personnel_costs(
  p_org_id UUID,
  p_year   INT,
  p_type   TEXT DEFAULT 'actual'
)
RETURNS TABLE (project_id UUID, total_cost NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_org_member(p_org_id) THEN
    RAISE EXCEPTION 'Not a member of this organisation';
  END IF;
  IF NOT can_see_financial_details() THEN
    RAISE EXCEPTION 'Insufficient permissions to view financial details';
  END IF;

  RETURN QUERY
  SELECT a.project_id,
         ROUND(SUM(a.pms * (COALESCE(pe.annual_salary, 0) / 12.0))::numeric, 2) AS total_cost
  FROM assignments a
  JOIN persons pe ON pe.id = a.person_id
  WHERE a.org_id = p_org_id
    AND a.year   = p_year
    AND a.type   = p_type
  GROUP BY a.project_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_personnel_costs(UUID, INT, TEXT) TO authenticated;


-- ============================================================================
-- C4. DocuSign RSA private key readable by every org member
-- ============================================================================
-- organisations.docusign_rsa_private_key was downloaded into every user's
-- browser by settingsService's `select('*')`. Revoke read access; keep write
-- access so an Admin can still save a new key (write-only field in the UI).

-- A read-safe flag so the settings screen can show "key configured" without
-- ever seeing the key. Maintained by trigger. Added BEFORE the grant rebuild
-- below so it is included in the permitted column list.
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS docusign_key_configured BOOLEAN NOT NULL DEFAULT FALSE;

-- >>> The REVOKE that actually hides docusign_rsa_private_key lives in
--     PART 2, for the same reason: it breaks the OLD client's `select('*')`
--     on organisations. The docusign_key_configured column and its trigger
--     above are additive.

CREATE OR REPLACE FUNCTION sync_docusign_key_configured()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.docusign_key_configured :=
    (NEW.docusign_rsa_private_key IS NOT NULL AND btrim(NEW.docusign_rsa_private_key) <> '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_docusign_key_configured ON organisations;
CREATE TRIGGER trg_sync_docusign_key_configured
  BEFORE INSERT OR UPDATE OF docusign_rsa_private_key ON organisations
  FOR EACH ROW EXECUTE FUNCTION sync_docusign_key_configured();

-- Backfill for existing rows.
UPDATE organisations
   SET docusign_key_configured =
       (docusign_rsa_private_key IS NOT NULL AND btrim(docusign_rsa_private_key) <> '')
 WHERE docusign_key_configured IS DISTINCT FROM
       (docusign_rsa_private_key IS NOT NULL AND btrim(docusign_rsa_private_key) <> '');


-- ============================================================================
-- C7. Notification type CHECK rejected every cron and billing notification
-- ============================================================================
-- The app inserts types like 'trial_expiring', 'subscription_upgraded' and
-- 'collab_report_reminder'. All of them violated the CHECK constraint, and
-- every insert site swallowed the error — so those notifications never
-- appeared, silently.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    -- generic
    'info', 'success', 'warning', 'alert', 'system',
    -- workflow
    'assignment', 'approval', 'invitation',
    -- billing / lifecycle
    'trial_expiring', 'trial_expired',
    'subscription_upgraded', 'subscription_cancelled', 'payment_failed',
    -- collaboration reminders
    'collab_report_reminder', 'collab_deliverable_reminder',
    'collab_milestone_reminder', 'collab_report_status',
    -- timesheets
    'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_ready_to_sign', 'timesheet_signed',
    -- periods / projects
    'period_locked', 'project_alert', 'budget_alert'
  ));

-- Server-side inserts (cron, Stripe webhook, DocuSign webhook) use the service
-- role and bypass RLS. Client inserts stay restricted to the caller's own org.
DROP POLICY IF EXISTS "Org members can insert notifications" ON notifications;
CREATE POLICY "Org members can insert notifications"
  ON notifications FOR INSERT
  TO authenticated
  WITH CHECK (is_org_member(org_id));


-- ============================================================================
-- C8. Timesheet state machine — applied to the table that actually exists
-- ============================================================================
-- The previous attempt guarded a table called `timesheet_envelopes`, which has
-- never existed in this schema. The real table is `timesheet_entries`.
--
-- Only envelope rows (project_id IS NULL) are governed; legacy per-project
-- rows from the old data model are left alone.
--
-- The critical guarantee: a timesheet cannot be Approved unless it was first
-- Submitted, Signed or Confirmed. Everything else stays permissive so existing
-- recall / revise / re-submit flows keep working.

CREATE OR REPLACE FUNCTION enforce_timesheet_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ok BOOLEAN := FALSE;
BEGIN
  -- Legacy per-project rows are not part of the envelope workflow.
  IF NEW.project_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  CASE OLD.status
    WHEN 'Draft'     THEN ok := NEW.status IN ('Submitted', 'Confirmed');
    WHEN 'Submitted' THEN ok := NEW.status IN ('Signing', 'Signed', 'Approved', 'Rejected', 'Draft');
    WHEN 'Signing'   THEN ok := NEW.status IN ('Signed', 'Rejected', 'Submitted', 'Draft');
    WHEN 'Signed'    THEN ok := NEW.status IN ('Approved', 'Rejected', 'Draft');
    WHEN 'Confirmed' THEN ok := NEW.status IN ('Approved', 'Rejected', 'Draft');
    WHEN 'Approved'  THEN ok := NEW.status IN ('Rejected', 'Draft');
    WHEN 'Rejected'  THEN ok := NEW.status IN ('Draft', 'Submitted');
    ELSE ok := FALSE;
  END CASE;

  IF NOT ok THEN
    RAISE EXCEPTION 'Invalid timesheet status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_timesheet_status_transition ON timesheet_entries;
CREATE TRIGGER trg_timesheet_status_transition
  BEFORE UPDATE OF status ON timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_timesheet_status_transition();

-- Approval metadata must belong to a real org member, and cannot be forged
-- into a different organisation.
CREATE OR REPLACE FUNCTION enforce_timesheet_approver()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'Approved' AND NEW.approved_by IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.org_members
      WHERE user_id = NEW.approved_by AND org_id = NEW.org_id
    ) THEN
      RAISE EXCEPTION 'Approver is not a member of this organisation'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_timesheet_approver ON timesheet_entries;
CREATE TRIGGER trg_timesheet_approver
  BEFORE INSERT OR UPDATE ON timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_timesheet_approver();


-- ============================================================================
-- C9. Bulk allocation upsert had no usable ON CONFLICT target
-- ============================================================================
-- fix_assignment_upsert.sql replaced the plain unique constraint with an
-- expression index on COALESCE(work_package_id, ...). PostgREST's `on_conflict`
-- can only infer a plain-column index, so the bulk save either errored with
-- 42P10 ("no unique or exclusion constraint matching") or hit a duplicate-key
-- violation on the expression index.
--
-- Fix: keep the COALESCE index (it is what actually prevents NULL duplicates)
-- and add a partial plain-column unique index that ON CONFLICT can infer for
-- the rows that DO have a work package. The client now routes NULL-work-package
-- rows through a separate, conflict-free path.

-- Clean out any duplicates that accumulated before doing anything else.
DELETE FROM assignments a
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY person_id, project_id,
                        COALESCE(work_package_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        year, month, type
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id
         ) AS rn
  FROM assignments
) dup
WHERE a.id = dup.id AND dup.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_unique_combo
  ON assignments (
    person_id, project_id,
    COALESCE(work_package_id, '00000000-0000-0000-0000-000000000000'::uuid),
    year, month, type
  );

-- Inferable arbiter for rows WITH a work package.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_upsert_with_wp
  ON assignments (person_id, project_id, work_package_id, year, month, type)
  WHERE work_package_id IS NOT NULL;

-- Same treatment for pm_budgets.
DELETE FROM pm_budgets b
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY project_id,
                        COALESCE(work_package_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        year, type
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id
         ) AS rn
  FROM pm_budgets
) dup
WHERE b.id = dup.id AND dup.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_budgets_unique_combo
  ON pm_budgets (
    project_id,
    COALESCE(work_package_id, '00000000-0000-0000-0000-000000000000'::uuid),
    year, type
  );


-- ============================================================================
-- C10. Failed-login audit entries could never be written
-- ============================================================================
-- writeSecurityAudit('login_failed') runs from the browser BEFORE the user is
-- authenticated, so the RLS check org_id = auth_org_id() always failed and
-- nothing was recorded. Your security log had no failed logins in it.
--
-- Route it through a SECURITY DEFINER function that anon may call, and which
-- resolves the organisation server-side from the attempted email.

CREATE OR REPLACE FUNCTION log_failed_login(
  p_email   TEXT,
  p_details TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_org_id  UUID;
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN;
  END IF;

  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(btrim(p_email)) LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    SELECT org_id INTO v_org_id
    FROM public.org_members
    WHERE user_id = v_user_id
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  -- Unknown email: record it against no organisation rather than leaking
  -- whether the account exists.
  INSERT INTO public.audit_log (org_id, user_id, user_email, entity_type, action, entity_id, details)
  VALUES (
    v_org_id,
    v_user_id,
    lower(btrim(p_email)),
    'security',
    'login_failed',
    COALESCE(v_user_id::text, 'unknown'),
    left(COALESCE(p_details, 'Failed login attempt'), 500)
  );
END;
$$;

-- audit_log.org_id may be NOT NULL in the base schema; allow NULL so failed
-- logins for unknown emails can still be recorded.
ALTER TABLE audit_log ALTER COLUMN org_id DROP NOT NULL;

GRANT EXECUTE ON FUNCTION log_failed_login(TEXT, TEXT) TO anon, authenticated;

-- Nobody may rewrite or erase the audit trail from the client.
DROP POLICY IF EXISTS "auditlog_update"  ON audit_log;
DROP POLICY IF EXISTS "auditlog_delete"  ON audit_log;
DROP POLICY IF EXISTS "auditchg_update"  ON audit_changes;
DROP POLICY IF EXISTS "auditchg_delete"  ON audit_changes;


-- ============================================================================
-- C10a. Server-side user lookup helpers (service role only)
-- ============================================================================
-- api/members.ts and api/send-email.ts previously called
-- `auth.admin.listUsers({ perPage: 1000 })` and scanned the result in memory:
--   * it breaks completely past 1,000 users
--   * send-email did it once PER RECIPIENT
-- These functions do the lookup in the database instead. EXECUTE is granted to
-- service_role only — they are never reachable from the browser.

CREATE OR REPLACE FUNCTION find_user_id_by_email(p_email TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
  SELECT id FROM auth.users
  WHERE lower(email) = lower(btrim(p_email))
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_user_emails(p_user_ids UUID[])
RETURNS TABLE (user_id UUID, email TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
  SELECT u.id, u.email::text
  FROM auth.users u
  WHERE u.id = ANY(p_user_ids);
$$;

REVOKE ALL ON FUNCTION find_user_id_by_email(TEXT)  FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION get_user_emails(UUID[])      FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION find_user_id_by_email(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION get_user_emails(UUID[])     TO service_role;


-- ============================================================================
-- C10b. Stripe webhook idempotency
-- ============================================================================
-- Stripe retries webhooks. Without a dedupe table, a retry re-ran every side
-- effect — most visibly, a second "Welcome to Pro" notification for each admin.
-- The webhook records each event id here and short-circuits on a duplicate.
--
-- No RLS policies: this table is service-role only. RLS is enabled so that a
-- leaked anon key cannot read or write it.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processed
  ON stripe_webhook_events (processed_at);

REVOKE ALL ON stripe_webhook_events FROM anon, authenticated;


-- ============================================================================
-- C11. Belt-and-braces: re-drop the leaky pending-invite policy
-- ============================================================================
-- merge_projects_modules.sql creates a policy that lets ANY caller read EVERY
-- pending partner invite — including the invite tokens — across all
-- organisations. proposals_workflow_redesign.sql drops it, but only if it ran
-- afterwards, and re-running the merge file re-opens the hole.

DROP POLICY IF EXISTS "Anyone with token sees partner" ON project_partners;
DROP POLICY IF EXISTS "Anyone with token sees partner" ON proposal_partners;

COMMIT;


-- ============================================================================
-- C5 + C6. STORAGE BUCKETS
-- ============================================================================
-- Run outside the main transaction: storage.buckets writes and policy changes
-- on storage.objects are safer applied independently.
--
-- C5: grant-uploads allowed ANY authenticated user to read and DELETE ANY file
--     in the bucket. Grant agreements contain budgets, salaries and consortium
--     data. Scope every operation to a folder named after the caller's org.
--
-- C6: project-documents had no migration at all and is served through
--     getPublicUrl(), which only works on a PUBLIC bucket — meaning every
--     project document was reachable by anyone with the URL, forever. Make it
--     private; the client now uses time-limited signed URLs.
--
-- Path convention for both buckets:  {org_id}/{...}
-- ============================================================================

-- ── grant-uploads ──────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('grant-uploads', 'grant-uploads', FALSE, 26214400)  -- 25 MB
ON CONFLICT (id) DO UPDATE SET public = FALSE, file_size_limit = 26214400;

DROP POLICY IF EXISTS "Authenticated users can upload grant files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read grant files"   ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete grant files" ON storage.objects;
DROP POLICY IF EXISTS "Org members manage grant uploads"           ON storage.objects;

CREATE POLICY "Org members manage grant uploads"
  ON storage.objects FOR ALL
  TO authenticated
  USING (
    bucket_id = 'grant-uploads'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  )
  WITH CHECK (
    bucket_id = 'grant-uploads'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  );

-- ── project-documents ──────────────────────────────────────────────────────
-- Create it if it is somehow missing, but DO NOT flip `public` yet — the old
-- client still serves documents through permanent public URLs. PART 2 makes it
-- private once the new signed-URL code is live.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('project-documents', 'project-documents', FALSE, 52428800)  -- 50 MB
ON CONFLICT (id) DO UPDATE SET file_size_limit = 52428800;

DROP POLICY IF EXISTS "Org members read project documents"    ON storage.objects;
DROP POLICY IF EXISTS "Org members write project documents"   ON storage.objects;
DROP POLICY IF EXISTS "Org members manage project documents"  ON storage.objects;
DROP POLICY IF EXISTS "Anyone can read project documents"     ON storage.objects;
DROP POLICY IF EXISTS "Public read project documents"         ON storage.objects;

CREATE POLICY "Org members manage project documents"
  ON storage.objects FOR ALL
  TO authenticated
  USING (
    bucket_id = 'project-documents'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  )
  WITH CHECK (
    bucket_id = 'project-documents'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  );

-- ── avatars ────────────────────────────────────────────────────────────────
-- Stays public for <img> use, but writes are now scoped so one user cannot
-- overwrite or delete another organisation's avatars.
DROP POLICY IF EXISTS "Authenticated users can upload avatars" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update avatars" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete avatars" ON storage.objects;
DROP POLICY IF EXISTS "Org members manage avatars"             ON storage.objects;

CREATE POLICY "Org members manage avatars"
  ON storage.objects FOR ALL
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  );
-- "Anyone can read avatars" (public SELECT) is intentionally left in place.


-- ============================================================================
-- PART 1 COMPLETE
-- ============================================================================
-- Quick sanity checks (full verification is at the end of PART 2):
--
--   -- persons_secure must exist and be readable
--   SELECT count(*) FROM persons_secure;
--
--   -- persons_masked must now enforce RLS
--   SELECT relname, reloptions FROM pg_class WHERE relname = 'persons_masked';
--   -- expect reloptions to contain security_invoker=true
--
--   -- no self-insert policy on org_members
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'org_members';
--
-- Next: deploy the application code, then run
--       supabase/2026_07_part2_lockdown.sql
-- ============================================================================
