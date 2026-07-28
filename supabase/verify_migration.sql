-- GrantLume — post-migration health check. Returns one row per check.
-- Everything should say PASS.  Uses has_*_privilege() so the answer is
-- authoritative regardless of which role runs it.

SELECT 'Salary hidden from app users' AS check_name,
       CASE WHEN NOT has_column_privilege('authenticated','public.persons','annual_salary','SELECT')
            THEN 'PASS' ELSE 'FAIL' END AS result
UNION ALL
SELECT 'Overhead rate hidden',
       CASE WHEN NOT has_column_privilege('authenticated','public.persons','overhead_rate','SELECT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'DocuSign private key hidden',
       CASE WHEN NOT has_column_privilege('authenticated','public.organisations','docusign_rsa_private_key','SELECT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'Staff names still readable (must stay PASS)',
       CASE WHEN has_column_privilege('authenticated','public.persons','full_name','SELECT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'Org name still readable (must stay PASS)',
       CASE WHEN has_column_privilege('authenticated','public.organisations','name','SELECT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'docusign_key_configured readable (must stay PASS)',
       CASE WHEN has_column_privilege('authenticated','public.organisations','docusign_key_configured','SELECT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'persons_secure view exists',
       CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                         WHERE n.nspname='public' AND c.relname='persons_secure' AND c.relkind='v')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'persons_masked enforces RLS',
       CASE WHEN EXISTS (SELECT 1 FROM pg_class WHERE relname='persons_masked'
                         AND 'security_invoker=true' = ANY(COALESCE(reloptions,'{}')))
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'No self-insert into org_members',
       CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                             AND tablename='org_members' AND policyname LIKE 'orgmem_insert_self%')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'grant-uploads bucket is private',
       CASE WHEN EXISTS (SELECT 1 FROM storage.buckets WHERE id='grant-uploads' AND public=false)
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'project-documents bucket is private',
       CASE WHEN EXISTS (SELECT 1 FROM storage.buckets WHERE id='project-documents' AND public=false)
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'Allocation upsert index present',
       CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                         AND tablename='assignments' AND indexname='idx_assignments_upsert_with_wp')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'No wide-open pending-invite policy',
       CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                             AND tablename IN ('project_partners','proposal_partners')
                             AND qual = '(invite_status = ''pending''::text)')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'Stripe webhook dedupe table present',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public'
                         AND table_name='stripe_webhook_events')
            THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;
