import { apiFetch } from '@/lib/apiClient'

/**
 * Resolve org member user-ids to email addresses.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several places used to call `supabase.auth.admin.getUserById()` directly
 * from the browser. That is a GoTrue *admin* API: it requires the service-role
 * key, which the browser does not have and must never have. Every one of those
 * calls returned 403, and because they were all wrapped in `.catch(() => {})`
 * the failure was invisible — the affected emails (period locked, timesheet
 * submitted) were simply never sent.
 *
 * The server endpoint does the lookup with the service role AND checks that
 * the caller actually belongs to the organisation they are asking about.
 */
export const memberDirectory = {
  /**
   * Returns a map of userId → email for the members of `orgId` that the
   * caller is allowed to see. Ids outside the organisation are dropped
   * server-side rather than reported.
   */
  async resolveEmails(orgId: string, userIds: string[]): Promise<Record<string, string>> {
    if (!orgId || userIds.length === 0) return {}

    const res = await apiFetch('/api/members?action=resolve-emails', {
      method: 'POST',
      body: JSON.stringify({ orgId, userIds }),
    })

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}))
      throw new Error(detail?.error || `Failed to resolve member emails (${res.status})`)
    }

    const data = await res.json()
    return (data?.emails ?? {}) as Record<string, string>
  },
}
