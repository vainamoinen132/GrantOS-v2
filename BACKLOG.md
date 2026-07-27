# GrantLume — Engineering Backlog

Findings from the full-system review (July 2026). Items marked **FIXED** were
addressed in the critical-fix pass; everything else is open work, ordered by
priority within each section.

Reference for the critical pass: `supabase/2026_07_critical_security_fixes.sql`.

---

## Legend

| Tag | Meaning |
|-----|---------|
| 🔴 | Security — data exposure or privilege escalation |
| 🟠 | Broken — feature silently does nothing |
| 💰 | Revenue / plan enforcement |
| 📊 | Calculation correctness |
| 🔧 | Engineering health |

---

## FIXED in the critical pass

| # | Tag | Item |
|---|-----|------|
| 1 | 🔴 | `orgmem_insert_self` let any user become Admin of any organisation |
| 2 | 🔴 | `persons_masked` view bypassed RLS (`security_invoker` not set) — full cross-tenant staff directory readable |
| 3 | 🔴 | `grant-uploads` bucket readable *and deletable* by any authenticated user, cross-tenant |
| 4 | 🔴 | `project-documents` served via permanent public URLs; bucket had no migration |
| 5 | 🔴 | `/api/stripe` checkout + portal had no authentication (billing IDOR) |
| 6 | 🔴 | `/api/members` invite-member / resolve-emails / collab-send had no org authorization |
| 7 | 🔴 | `/api/docusign?action=sign` had no org authorization (cross-tenant signature forgery) |
| 8 | 🔴 | MFA bypassable by refreshing the page (`initialize()` skipped the AAL check) |
| 9 | 🔴 | DocuSign RSA private key readable by every org member |
| 10 | 🔴 | Salary / overhead readable by every org member (masking was client-side only) |
| 11 | 🔴 | `/api/send-email` was an open relay; templates had no HTML escaping |
| 12 | 🔴 | Batch emails leaked the first recipient's unsubscribe token to everyone |
| 13 | 🔴 | `/api/auth-hook` open when `AUTH_HOOK_SECRET` unset (phishing from your domain) |
| 14 | 🔴 | `/api/ai` accepted an arbitrary `storage_path`, read with the service role |
| 15 | 🟠 | Notification `type` CHECK rejected every cron/billing notification |
| 16 | 🟠 | `api/stripe.ts` wrote to a non-existent `body` column |
| 17 | 🟠 | DocuSign webhook crashed on `.catch()` (not a Promise) |
| 18 | 🟠 | Stripe + DocuSign webhook signatures verified against a re-serialised body |
| 19 | 🟠 | Timesheet state machine guarded a table that does not exist |
| 20 | 🟠 | Bulk allocation save broken for rows with no work package |
| 21 | 🟠 | Period-lock and timesheet-submitted emails called an admin API from the browser |
| 22 | 🟠 | `collab-send` reported success without sending anything |
| 23 | 🟠 | Invite base URL produced `https://undefined/...` |
| 24 | 🟠 | Failed-login audit entries were never recorded |
| 25 | 🔧 | Multi-org membership crashed login (`maybeSingle()` on 2+ rows) |

---

## OPEN — High priority (before first paying customer)

### 💰 B1. Plan limits are not enforced server-side
`usePlanLimits` gates buttons in React only. The database has no idea what plan
an org is on, so project/staff/seat caps can be bypassed with direct API calls.
Trial expiry is also computed client-side (`authStore.ts` `effectivePlan`) while
the server still reads `plan = 'trial'`.
**Fix:** enforce caps in RLS or `BEFORE INSERT` triggers; add a scheduled job (or
generated column) that flips `plan` to `free` when `trial_ends_at` passes.

### 💰 B2. AI plan names mismatch between server and client
`api/ai.ts` uses `trial / starter / growth / enterprise`; the product uses
`trial / free / pro`. `AI_PLAN_LIMITS['pro']` is undefined so Pro customers fall
back to trial limits. A correct copy of the table already exists at
`src/types/index.ts` (`AI_PLAN_LIMITS`).
**Note:** deliberately out of scope for the critical pass — the AI quota system
is slated to be simplified. When that happens, delete one of the two tables so
there is a single source of truth.

### 💰 B3. AI quota counting is not atomic
`recordUsage` in `api/ai.ts` does read-then-write. Concurrent requests overwrite
each other's counts. Replace with a single `INSERT ... ON CONFLICT DO UPDATE SET
tokens_in = ai_usage.tokens_in + EXCLUDED.tokens_in` (or an RPC).

### 💰 B4. Any Stripe price grants `pro`
`getPlan()` in `api/stripe.ts` returns `'pro'` for every price ID. And
`handleSubscriptionUpdated` keeps `plan = 'pro'` when Stripe reports `canceled`
or `unpaid` — it only changes `subscription_status`, which the gating code does
not read.
**Fix:** map unknown prices to `free`, and derive `plan` from the status.

### 🔧 B5. CI is fully red
- `npm run lint` fails — `eslint` is not installed and there is no config.
- The unit-test job has `needs: lint-typecheck-build`, so it never runs.
- `npm audit --audit-level=high` fails (see B7).
**Fix:** add `eslint` + `typescript-eslint` + a flat config, or drop the lint
step until it is configured. Add `"test": "vitest run"` to `package.json`.

### 🔧 B6. One unit test fails
`src/lib/permissions.test.ts` expects `/import` in `ROUTE_PERMISSIONS`. The
Import feature has no route (see B12). The test is correct; the app is not.

### 🔧 B7. 27 known vulnerabilities (2 critical, 14 high)
Two matter at runtime:
- **`xlsx`** — prototype pollution + ReDoS, **no npm fix**. Used in the browser
  on user-uploaded spreadsheets. Move to the SheetJS CDN build (0.20.2+) or
  `exceljs`.
- **`dompurify`** via `jspdf` — XSS. `npm audit fix --force` moves to jspdf 4.x
  (breaking).
Most of the rest clear with `npm audit fix`.

### 🔧 B8. Migrations have no ordering and some are destructive
60 flat `.sql` files, no numbering, no version table.
- `rls_policies.sql` drops **every policy in the public schema** and recreates
  only ~19 tables' worth. Running it today would strip the collaboration,
  proposal and expense policies.
- `merge_projects_modules.sql` creates a policy exposing every pending partner
  invite token across all orgs; it is only dropped later by
  `proposals_workflow_redesign.sql`. Re-running the merge file re-opens it.
**Fix:** move to `supabase/migrations/` with timestamped filenames and the
Supabase CLI. Until then, add a header to every destructive file saying so.

### 🟠 B9. DocuSign approver signing is not implemented
`src/services/docusignService.ts` calls `/api/docusign?action=approver-sign`,
but `api/docusign.ts` only handles `sign` and `webhook`. Every call returns
`400 Unknown action`. Either implement the second-signer flow or remove the UI.

---

## OPEN — Medium priority

### 📊 B10. Annual budget split is wrong for projects not starting in January
`src/lib/financialCalcs.ts` `computeAnnualBudgets` divides by the **number of
calendar years touched**. A project running Oct 2024 → Mar 2026 touches 3 years
but is 18 months long, so 2024 gets a third of the budget for 3 months of work.
**Fix:** distribute pro-rata by months (or days) active in each year.

### 📊 B11. Date parsing can shift by a year west of UTC
Same file: `new Date('2024-01-01').getFullYear()` parses as UTC midnight and
reads back in local time — returns 2023 in the Americas.
**Fix:** parse date-only strings manually (`Number(s.slice(0, 4))`) or use
`date-fns/parseISO` consistently.

### 📊 B12. Person-month formula uses calendar months, not productive hours
`src/lib/pmUtils.ts`: 1 PM = weekdays-in-month × hours-per-day, so the same
8-hour day is a different fraction of a PM in February vs March. EU rules
normally use annual productive hours (e.g. 1720 h/year ÷ 12). The comment on
`getWorkingDaysInMonth` claims holidays are excluded — they are not, and
absences are ignored entirely.
**Action:** confirm the intended formula with a funding officer, then make it
configurable per organisation. This is an audit-exposure item for customers.

### 🔧 B13. Dead code — four unreachable features
No route and no import anywhere:
- `src/features/import/ImportPage.tsx` + `BulkImport.tsx` (~850 lines). The
  `canSeeImport` permission toggle in Role Permissions controls nothing.
- `src/features/matrix/MatrixPage.tsx` + `AssignmentMatrix.tsx`
- `src/features/timeline/TimelinePage.tsx` + `GanttChart.tsx`
- `src/features/timesheets/MyTimesheet.tsx`, `TimesheetList.tsx`
- `src/components/common/PermissionGate.tsx`
**Fix:** wire them up or delete them. Whichever, `ROUTE_PERMISSIONS` and the
Role Permissions screen must match reality.

### 🔧 B14. Cron jobs will time out as customer count grows
`api/cron.ts` loops org → members → one `getUserById()` per member,
sequentially, with no `maxDuration` set. There is no record of what was already
sent, so a retry double-sends. Reminder matching uses exact-day equality
(`daysUntilDue !== leadDays`) — one missed run and that reminder never fires.
**Fix:** batch the user lookups, add `export const config = { maxDuration: 300 }`,
add a `sent_reminders` table for idempotency, and match on a date range.

### 🔧 B15. 3.6 MB JavaScript bundle
`src/App.tsx` statically imports all 25 pages. Build output is 3,633 kB
(1,015 kB gzipped) in a single chunk.
**Fix:** `React.lazy()` + `Suspense` per route. Roughly a 70% cut to first load.

### 🔧 B16. Rate limiting is per-instance in memory
`api/lib/rateLimit.ts` uses a `Map` per serverless instance. Vercel runs many
instances, so real limits are much higher than intended.
**Fix:** Upstash Redis (or Vercel KV) before public launch.

### 🔧 B17. 1,000-user ceilings
`api/members.ts` and `api/send-email.ts` use `listUsers({ perPage: 1000 })`.
Everything breaks past 1,000 users, and `send-email` did this once per
recipient. Replace with a direct lookup by email/ID.

### 🔧 B18. Audit log is client-written and forgeable
`src/services/auditWriter.ts` writes from the browser, fire-and-forget. Any
member can insert arbitrary rows, and anyone bypassing the UI leaves no trace.
**Fix:** move to database triggers on the audited tables (`AFTER INSERT OR
UPDATE OR DELETE`), so the trail cannot be skipped or forged.

### 🔧 B19. 1,576 missing translations
German is 480 keys short (~28% of the UI); es/fr/pt/tr are 274 each. It falls
back to English rather than breaking, so users see a bilingual product. Also 412
unused keys and 66 stray keys. Run `npm run check:i18n` for the current list.

### 🔧 B20. Multi-organisation membership is unsupported
`auth_org_id()` uses `LIMIT 1` with no `ORDER BY`, so a user in two orgs gets an
arbitrary one. The login crash is fixed, but the model still can't represent
"this user belongs to A and B."
**Fix:** add an explicit "active organisation" concept (a column on
`user_preferences` plus an org switcher), and make `auth_org_id()` read it.

---

## OPEN — Lower priority

- **B21.** CSP allows `'unsafe-inline'` and `'unsafe-eval'` for scripts
  (`vercel.json`), which removes most of its XSS value. Move to nonces/hashes.
- **B22.** No server-side error tracking. Sentry is browser-only; API failures
  only reach Vercel logs. Add `@sentry/node` to the `/api` handlers.
- **B23.** `escapeValue: false` in `src/lib/i18n.ts` combined with
  `dangerouslySetInnerHTML` in `RolePermissions.tsx:376` and `HelpPage.tsx`.
  Currently safe (fixed values only) but one careless change away from XSS.
  Prefer `<Trans>`.
- **B24.** Test coverage is 24 unit tests and 178 lines of Playwright for 72k
  lines. Nothing tests the money math, timesheet workflow, allocation grid, or
  any permission boundary.
- **B25.** `email-preferences` unsubscribe tokens never rotate and grant
  permanent access to a user's preferences. Consider expiry or per-send tokens.
- **B26.** `parseJsonResponse` in `api/ai.ts` counts braces without respecting
  string literals — a `{` inside an extracted title truncates the JSON.
- **B27.** `ensureEnvelope` in `timesheetService.ts` has a read-then-insert race;
  rely on the partial unique index and handle the conflict.
- **B28.** `injectUnsubscribeUrl` string-matches
  `href="https://app.grantlume.com/profile"` in template HTML. Brittle — pass
  the URL into the template instead.
- **B29.** Duplicate RLS helpers: `auth_org_id()`/`auth_role()` and
  `get_user_org_id()`/`get_user_role()` do the same thing and different
  migrations use different ones. Consolidate on one pair.
- **B30.** `api/lib/rateLimit.ts` registers a `setInterval` at module scope,
  which keeps a timer alive in every serverless instance. Harmless today, but
  prefer lazy cleanup on access.
