import { supabase } from '@/lib/supabase'
import { writeAudit } from './auditWriter'
import type { FundingScheme, Organisation } from '@/types'

/**
 * Every organisation column EXCEPT `docusign_rsa_private_key`.
 *
 * That column is a signing key. `select('*')` pulled it into every user's
 * browser — a Viewer could read their company's DocuSign private key straight
 * out of a network response. SELECT on it is now revoked at the database level
 * (see supabase/2026_07_critical_security_fixes.sql), so `*` would fail
 * outright; we list the safe columns explicitly instead.
 *
 * `docusign_key_configured` is a boolean maintained by trigger, so the
 * Integrations screen can still show whether a key is saved.
 */
const ORG_SAFE_COLUMNS = [
  'id', 'name', 'country', 'currency',
  'working_hours_per_day', 'working_days_per_year',
  'default_overhead_rate', 'average_personnel_rate_pm',
  'departments', 'default_vacation_days', 'ai_enabled',
  'timesheets_drive_allocations', 'private_absence_types',
  'plan', 'trial_ends_at', 'is_active',
  'stripe_customer_id', 'stripe_subscription_id', 'subscription_status',
  'docusign_integration_key', 'docusign_user_id', 'docusign_account_id',
  'docusign_base_url', 'docusign_oauth_base_url', 'docusign_key_configured',
  'created_at', 'updated_at',
].join(', ')

export const settingsService = {
  // Funding Schemes
  async listFundingSchemes(orgId: string | null): Promise<FundingScheme[]> {
    let query = supabase
      .from('funding_schemes')
      .select('*')
      .order('name')

    if (orgId) {
      query = query.eq('org_id', orgId)
    }

    const { data, error } = await query

    if (error) throw error
    return (data ?? []) as FundingScheme[]
  },

  async createFundingScheme(
    scheme: Omit<FundingScheme, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FundingScheme> {
    const { data, error } = await supabase
      .from('funding_schemes')
      .insert(scheme)
      .select()
      .single()

    if (error) throw error
    writeAudit({ orgId: scheme.org_id, entityType: 'funding_scheme', action: 'create', entityId: (data as FundingScheme).id, details: `Created funding scheme ${scheme.name}` })
    return data as FundingScheme
  },

  async updateFundingScheme(id: string, updates: Partial<FundingScheme>): Promise<FundingScheme> {
    const { data, error } = await supabase
      .from('funding_schemes')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    writeAudit({ orgId: (data as FundingScheme).org_id, entityType: 'funding_scheme', action: 'update', entityId: id, details: `Updated funding scheme ${(data as FundingScheme).name}` })
    return data as FundingScheme
  },

  async removeFundingScheme(id: string): Promise<void> {
    const { error } = await supabase
      .from('funding_schemes')
      .delete()
      .eq('id', id)

    if (error) throw error
  },

  // Organisation
  async getOrganisation(orgId: string): Promise<Organisation | null> {
    const { data, error } = await supabase
      .from('organisations')
      .select(ORG_SAFE_COLUMNS)
      .eq('id', orgId)
      .single()

    if (error) throw error
    return data as unknown as Organisation
  },

  async updateOrganisation(orgId: string, updates: Partial<Organisation>): Promise<Organisation> {
    const { data, error } = await supabase
      .from('organisations')
      .update({ ...updates, updated_at: new Date().toISOString() } as any)
      .eq('id', orgId)
      .select(ORG_SAFE_COLUMNS)
      .single()

    if (error) throw error
    writeAudit({ orgId: orgId, entityType: 'organisation', action: 'update', entityId: orgId, details: 'Updated organisation settings' })
    return data as unknown as Organisation
  },
}
