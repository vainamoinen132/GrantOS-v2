import { supabase } from '@/lib/supabase'

interface AuditEntry {
  orgId: string
  entityType: string
  action: 'create' | 'update' | 'delete'
  entityId: string
  details?: string
}

type SecurityAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'mfa_enroll'
  | 'mfa_verify'
  | 'mfa_unenroll'
  | 'role_change'
  | 'member_invite'
  | 'member_remove'
  | 'export'
  | 'password_change'

interface SecurityAuditEntry {
  action: SecurityAction
  details?: string
  orgId?: string | null
  targetUserId?: string | null
  targetEmail?: string | null
}

/**
 * Writes an audit log entry. Fire-and-forget — errors are logged but not thrown.
 */
export async function writeAudit({ orgId, entityType, action, entityId, details }: AuditEntry) {
  try {
    const { data: { user } } = await supabase.auth.getUser()

    await (supabase.from as any)('audit_log').insert({
      org_id: orgId,
      user_id: user?.id ?? null,
      user_email: user?.email ?? null,
      entity_type: entityType,
      action,
      entity_id: entityId,
      details: details ?? null,
    })
  } catch (err) {
    console.warn('[GrantLume] Audit write failed:', err)
  }
}

/**
 * Writes field-level change entries. Fire-and-forget.
 */
/**
 * Writes a security-related audit log entry (login, logout, MFA, role changes, exports).
 * Fire-and-forget — errors are logged but not thrown.
 */
export async function writeSecurityAudit(entry: SecurityAuditEntry) {
  try {
    // Failed logins happen BEFORE the user is authenticated, so the RLS check
    // `org_id = auth_org_id()` could never pass and the insert always failed
    // silently — the security log contained no failed logins at all.
    //
    // Route them through a SECURITY DEFINER function that anon may call and
    // that resolves the organisation server-side from the attempted email.
    if (entry.action === 'login_failed') {
      const { error } = await (supabase.rpc as any)('log_failed_login', {
        p_email: entry.targetEmail ?? '',
        p_details: entry.details ?? 'Failed login attempt',
      })
      if (error) console.warn('[GrantLume] Failed-login audit write failed:', error.message)
      return
    }

    const { data: { user } } = await supabase.auth.getUser()

    await (supabase.from as any)('audit_log').insert({
      org_id: entry.orgId ?? user?.app_metadata?.org_id ?? null,
      user_id: user?.id ?? null,
      user_email: user?.email ?? entry.targetEmail ?? null,
      entity_type: 'security',
      action: entry.action,
      entity_id: entry.targetUserId ?? user?.id ?? 'system',
      details: entry.details ?? null,
    })
  } catch (err) {
    console.warn('[GrantLume] Security audit write failed:', err)
  }
}

export async function writeAuditChanges(
  orgId: string,
  entityType: string,
  entityId: string,
  action: string,
  changes: { field: string; oldValue: unknown; newValue: unknown }[],
) {
  try {
    const { data: { user } } = await supabase.auth.getUser()

    const rows = changes.map((c) => ({
      org_id: orgId,
      user_id: user?.id ?? null,
      entity_type: entityType,
      entity_id: entityId,
      field_name: c.field,
      old_value: c.oldValue != null ? String(c.oldValue) : null,
      new_value: c.newValue != null ? String(c.newValue) : null,
      action,
      changed_by_name: user?.email ?? null,
    }))

    if (rows.length > 0) {
      await (supabase.from as any)('audit_changes').insert(rows)
    }
  } catch (err) {
    console.warn('[GrantLume] Audit changes write failed:', err)
  }
}
