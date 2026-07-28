-- ============================================================================
-- GrantLume — CRITICAL security fixes, PART 2 of 2 : LOCKDOWN
-- ============================================================================
--
--   ►  RUN THIS ONLY AFTER THE NEW APPLICATION CODE IS DEPLOYED.
--   ►  Running it while the OLD code is live WILL break the app.
--
-- PART 1 (2026_07_part1_additive.sql) created everything the new code needs
-- and closed the holes that could be closed without a breaking change. This
-- file performs the three changes that the old client cannot survive:
--
--   1. REVOKE SELECT on persons        → salaries become unreadable
--        old code: staffService / reports did `select('*')`
--        new code: reads the persons_secure view
--
--   2. REVOKE SELECT on organisations  → the DocuSign RSA private key
--                                        becomes unreadable
--        old code: settingsService.getOrganisation did `select('*')`
--        new code: selects an explicit safe column list
--
--   3. project-documents bucket → private
--        old code: served documents from permanent public URLs
--        new code: mints 5-minute signed URLs on click
--
-- PREREQUISITES — confirm all three before running:
--   [ ] PART 1 has been run successfully
--   [ ] The new code is deployed and serving traffic
--   [ ] You have a database restore point
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. persons — hide annual_salary and overhead_rate
-- ============================================================================
-- WHY THIS IS A REVOKE-THEN-GRANT, NOT A COLUMN REVOKE
--
-- PostgreSQL only lets you revoke a column-level privilege that was granted at
-- the column level. Supabase grants SELECT on ALL TABLES to `authenticated` at
-- the TABLE level, so the intuitive statement
--     REVOKE SELECT (annual_salary) ON persons FROM authenticated;
-- silently does NOTHING and the salary stays readable. That is the single
-- easiest way to believe this is fixed when it is not.
--
-- The only way to restrict columns is to drop the table-level SELECT and
-- re-grant SELECT on the permitted columns. The permitted list is derived from
-- information_schema, so it can never drift out of sync with the real schema.
--
-- Note: SELECT only. INSERT/UPDATE are untouched, so Admins can still edit
-- salaries — they simply cannot read them back except through persons_secure,
-- which applies can_see_salary().

DO $$
DECLARE
  safe_cols TEXT;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO safe_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'persons'
    AND column_name NOT IN ('annual_salary', 'overhead_rate');

  EXECUTE 'REVOKE SELECT ON public.persons FROM anon, authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.persons TO authenticated', safe_cols);
END $$;


-- ============================================================================
-- 2. organisations — hide docusign_rsa_private_key
-- ============================================================================
-- Same reasoning as above. UPDATE is untouched so an Admin can still SAVE a
-- new key; the Integrations screen now treats the field as write-only and
-- reads the docusign_key_configured boolean (added in PART 1) instead.

DO $$
DECLARE
  safe_cols TEXT;
BEGIN
  -- Guard: the read-safe flag must exist before we revoke, otherwise the
  -- settings screen loses its "is a key configured?" signal.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'organisations'
      AND column_name = 'docusign_key_configured'
  ) THEN
    RAISE EXCEPTION 'docusign_key_configured is missing — run PART 1 first';
  END IF;

  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO safe_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'organisations'
    AND column_name <> 'docusign_rsa_private_key';

  EXECUTE 'REVOKE SELECT ON public.organisations FROM anon, authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.organisations TO authenticated', safe_cols);
END $$;

COMMIT;


-- ============================================================================
-- 3. project-documents — make the bucket private
-- ============================================================================
-- Run outside the transaction above; storage.buckets writes are safer applied
-- independently.
--
-- Until now this bucket was public, which is the only way getPublicUrl() can
-- produce a working link — meaning every grant agreement, contract and
-- financial annex was readable by anyone who had (or guessed) the URL, with no
-- login and no expiry.
--
-- The org-scoped access policies were already created in PART 1, so flipping
-- `public` here is the last step. The new client requests a signed URL at
-- click time via documentService.getDownloadUrl().
--
-- AFTER THIS RUNS, ANY OLD PUBLIC LINK PASTED INTO AN EMAIL OR DOCUMENT WILL
-- STOP WORKING. That is the intended outcome.

UPDATE storage.buckets
   SET public = FALSE
 WHERE id = 'project-documents';


-- ============================================================================
-- VERIFICATION — run each of these and check the expected result
-- ============================================================================
--
-- The first two are the ones that matter most: a column REVOKE against a
-- table-level grant is a silent no-op, so if these return rows the fix did
-- NOT apply even though the migration reported success.

-- 1. Salary must be unreadable by the app roles.       EXPECT: zero rows
SELECT grantee, column_name, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public'
   AND table_name = 'persons'
   AND column_name IN ('annual_salary', 'overhead_rate')
   AND grantee IN ('anon', 'authenticated')
   AND privilege_type = 'SELECT';

-- 2. DocuSign private key must be unreadable.          EXPECT: zero rows
SELECT grantee, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public'
   AND table_name = 'organisations'
   AND column_name = 'docusign_rsa_private_key'
   AND grantee IN ('anon', 'authenticated')
   AND privilege_type = 'SELECT';

-- 3. Safe columns must still be readable.  EXPECT: full_name, email, etc.
SELECT column_name
  FROM information_schema.column_privileges
 WHERE table_schema = 'public' AND table_name = 'persons'
   AND grantee = 'authenticated' AND privilege_type = 'SELECT'
 ORDER BY column_name;

-- 4. Buckets.   EXPECT: grant-uploads = false, project-documents = false,
--               avatars = true (public by design, writes are org-scoped)
SELECT id, public FROM storage.buckets ORDER BY id;

-- 5. No self-insert into org_members.
--    EXPECT: no policy named 'orgmem_insert_self'; the only INSERT path is
--            the Admin-scoped 'orgmem_all_admin'.
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'org_members'
 ORDER BY policyname;

-- 6. persons_masked must enforce RLS.
--    EXPECT: reloptions contains security_invoker=true
SELECT relname, reloptions FROM pg_class WHERE relname = 'persons_masked';

-- 7. Assignment upsert arbiters must both exist.
--    EXPECT: idx_assignments_unique_combo AND idx_assignments_upsert_with_wp
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'assignments'
 ORDER BY indexname;

-- 8. No pending-invite leak.
--    EXPECT: no policy whose qualifier is just (invite_status = 'pending')
SELECT tablename, policyname, qual FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('project_partners', 'proposal_partners')
 ORDER BY tablename, policyname;


-- ============================================================================
-- ROLLBACK (emergency only)
-- ============================================================================
-- If the app breaks and you need to restore the previous read behaviour
-- immediately, this undoes the two revokes. It re-exposes salaries and the
-- DocuSign private key — treat it as a stop-gap while you roll the code back,
-- not as a resting state.
--
--   GRANT SELECT ON public.persons       TO authenticated;
--   GRANT SELECT ON public.organisations TO authenticated;
--   UPDATE storage.buckets SET public = TRUE WHERE id = 'project-documents';
--
-- ============================================================================
