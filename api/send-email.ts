import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import {
  cors,
  authenticateRequest,
  handleAuthError,
  adminClient,
  type AuthContext,
} from './lib/auth.js'
import { checkRateLimit } from './lib/rateLimit.js'
import { appUrl } from './lib/appUrl.js'
import {
  invitationEmail,
  welcomeEmail,
  roleChangedEmail,
  timesheetReminderEmail,
  timesheetSubmittedEmail,
  projectEndingSoonEmail,
  budgetAlertEmail,
  trialExpiringEmail,
  periodLockedEmail,
  signupConfirmationEmail,
  socialWelcomeEmail,
  emailChangedEmail,
  passwordChangedEmail,
  absenceRequestedEmail,
  absenceApprovedEmail,
  absenceRejectedEmail,
  timesheetApprovedEmail,
  timesheetRejectedEmail,
  absenceCancelledEmail,
  projectCreatedEmail,
  staffDeactivatedEmail,
  allocationChangedEmail,
  proposalStatusChangedEmail,
  memberRemovedEmail,
  substituteNotificationEmail,
  collabPartnerInvitationEmail,
  collabReportReminderEmail,
  collabReportStatusEmail,
  collabDeliverableReminderEmail,
  collabMilestoneReminderEmail,
  timesheetReadyToSignEmail,
  timesheetSignedEmail,
  supportRequestEmail,
  renderEmail,
} from './emails/templates.js'
import type { EmailTemplate } from './emails/templates.js'

const TEMPLATE_MAP: Record<string, (params: any) => EmailTemplate> = {
  invitation: invitationEmail,
  welcome: welcomeEmail,
  roleChanged: roleChangedEmail,
  timesheetReminder: timesheetReminderEmail,
  timesheetSubmitted: timesheetSubmittedEmail,
  projectEndingSoon: projectEndingSoonEmail,
  budgetAlert: budgetAlertEmail,
  trialExpiring: trialExpiringEmail,
  periodLocked: periodLockedEmail,
  signupConfirmation: signupConfirmationEmail,
  socialWelcome: socialWelcomeEmail,
  emailChanged: emailChangedEmail,
  passwordChanged: passwordChangedEmail,
  absenceRequested: absenceRequestedEmail,
  absenceApproved: absenceApprovedEmail,
  absenceRejected: absenceRejectedEmail,
  timesheetApproved: timesheetApprovedEmail,
  timesheetRejected: timesheetRejectedEmail,
  absenceCancelled: absenceCancelledEmail,
  projectCreated: projectCreatedEmail,
  staffDeactivated: staffDeactivatedEmail,
  allocationChanged: allocationChangedEmail,
  proposalStatusChanged: proposalStatusChangedEmail,
  memberRemoved: memberRemovedEmail,
  substituteNotification: substituteNotificationEmail,
  collabPartnerInvitation: collabPartnerInvitationEmail,
  collabReportReminder: collabReportReminderEmail,
  collabReportStatus: collabReportStatusEmail,
  collabDeliverableReminder: collabDeliverableReminderEmail,
  collabMilestoneReminder: collabMilestoneReminderEmail,
  timesheetReadyToSign: timesheetReadyToSignEmail,
  timesheetSigned: timesheetSignedEmail,
  supportRequest: supportRequestEmail,
}

/** Maps template name → user_preferences column that controls it */
const PREF_COLUMN_MAP: Record<string, string> = {
  timesheetReminder: 'email_timesheet_reminders',
  timesheetSubmitted: 'email_timesheet_submitted',
  projectEndingSoon: 'email_project_alerts',
  budgetAlert: 'email_budget_alerts',
  periodLocked: 'email_period_locked',
  roleChanged: 'email_role_changes',
  invitation: 'email_invitations',
  welcome: 'email_welcome',
  trialExpiring: 'email_trial_expiring',
  // absenceCancelled — always sent (approver needs to know)
  // staffDeactivated — always sent (courtesy notice)
  // memberRemoved — always sent (access revocation notice)
  timesheetApproved: 'email_timesheet_submitted',
  timesheetRejected: 'email_timesheet_submitted',
  allocationChanged: 'email_project_alerts',
  projectCreated: 'email_project_alerts',
  proposalStatusChanged: 'email_project_alerts',
  substituteNotification: 'email_substitute_notifications',
  absenceRequested: 'email_absence_notifications',
  absenceApproved: 'email_absence_notifications',
  absenceRejected: 'email_absence_notifications',
  collabPartnerInvitation: 'email_collab_notifications',
  collabReportReminder: 'email_collab_notifications',
  collabReportStatus: 'email_collab_notifications',
  collabDeliverableReminder: 'email_collab_notifications',
  collabMilestoneReminder: 'email_collab_notifications',
}

const FROM_ADDRESS = 'GrantLume <notifications@grantlume.com>'

/** The one fixed address the product itself owns. */
const SUPPORT_ADDRESS = 'hello@grantlume.com'

/** Templates that may only ever be sent to SUPPORT_ADDRESS. */
const SUPPORT_ONLY_TEMPLATES = new Set(['supportRequest'])

/** Hard cap on fan-out per request. */
const MAX_RECIPIENTS = 50

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Rate limit: 20 send-email calls per 60s per IP
  if (!checkRateLimit(req, res, { limit: 20, windowSeconds: 60, prefix: 'email' })) return

  let auth: AuthContext
  try {
    auth = await authenticateRequest(req)
  } catch (err) {
    return handleAuthError(err, res)
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY not configured on server' })
  }

  const { template, to, params, replyTo } = req.body ?? {}

  if (!template || !to) {
    return res.status(400).json({ error: 'Missing required fields: template, to' })
  }

  const templateFn = TEMPLATE_MAP[template]
  if (!templateFn) {
    return res.status(400).json({ error: `Unknown template: ${template}` })
  }

  const requested = (Array.isArray(to) ? to : [to])
    .filter((e: unknown): e is string => typeof e === 'string' && e.includes('@'))
    .map((e: string) => e.trim().toLowerCase())

  if (requested.length === 0) {
    return res.status(400).json({ error: 'No valid recipient addresses' })
  }
  if (requested.length > MAX_RECIPIENTS) {
    return res.status(400).json({ error: `Too many recipients (max ${MAX_RECIPIENTS})` })
  }

  const sb = adminClient()

  try {
    // ── AUTHORIZATION ───────────────────────────────────────────────────────
    // This endpoint used to accept ANY recipient with ANY template params from
    // ANY logged-in user — an open relay sending from a verified GrantLume
    // domain. Recipients are now restricted to addresses the caller could
    // legitimately email: themselves, people in their own organisation, and
    // partner contacts on their own projects/proposals.
    const allowed = await filterAllowedRecipients(sb, auth, template, requested)

    if (allowed.length === 0) {
      return res.status(403).json({
        error: 'None of the requested recipients are reachable from your organisation',
      })
    }

    const resend = new Resend(apiKey)
    const results: { email: string; ok: boolean }[] = []
    let skipped = 0

    // Send ONE message per recipient. Batching them into a single `to` array
    // meant (a) every recipient saw the others' addresses, and (b) everybody
    // received the FIRST recipient's unsubscribe token, which let any of them
    // read and change another user's email preferences.
    for (const email of allowed) {
      const { allowed: wantsEmail, unsubscribeToken } = await checkRecipient(sb, email, template)
      if (!wantsEmail) {
        skipped++
        continue
      }

      const prefsUrl = unsubscribeToken
        ? `${appUrl()}/email-preferences?token=${encodeURIComponent(unsubscribeToken)}`
        : undefined

      // renderEmail escapes every param and injects THIS recipient's
      // preferences link — see api/emails/templates.ts.
      const { subject, html } = renderEmail(templateFn, params ?? {}, prefsUrl)

      try {
        const { error } = await resend.emails.send({
          from: FROM_ADDRESS,
          to: email,
          subject,
          html,
          // Only ever reply to a verified address we control the shape of.
          ...(typeof replyTo === 'string' && isPlausibleEmail(replyTo)
            ? { replyTo: replyTo.trim() }
            : {}),
        })
        if (error) {
          console.error('[GrantLume] Resend error:', error.message)
          results.push({ email, ok: false })
        } else {
          results.push({ email, ok: true })
        }
      } catch (err) {
        console.error('[GrantLume] Email send failed for one recipient:', err)
        results.push({ email, ok: false })
      }
    }

    const sent = results.filter(r => r.ok).length
    return res.status(200).json({
      success: sent > 0,
      sent,
      skipped,
      failed: results.length - sent,
      // Not reporting which addresses were dropped — that would turn this into
      // a membership oracle for other organisations.
      filtered: requested.length - allowed.length,
    })
  } catch (err: any) {
    console.error('[GrantLume] Email send failed:', err)
    return res.status(500).json({ error: 'Failed to send email' })
  }
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/**
 * Return the subset of `requested` the caller is permitted to email.
 *
 * Allowed:
 *   - the caller's own address
 *   - the support inbox (for the supportRequest template only)
 *   - any auth user who is a member of one of the caller's organisations
 *   - any `persons.email` in one of the caller's organisations
 *   - any partner contact email on a project or proposal owned by one of them
 */
async function filterAllowedRecipients(
  sb: SupabaseClient,
  auth: AuthContext,
  template: string,
  requested: string[],
): Promise<string[]> {
  // supportRequest is the one template that leaves the customer's own world.
  if (SUPPORT_ONLY_TEMPLATES.has(template)) {
    return requested.filter(e => e === SUPPORT_ADDRESS)
  }
  // …and no other template may target the support inbox.
  const candidates = requested.filter(e => e !== SUPPORT_ADDRESS)
  if (candidates.length === 0) return []

  const allowed = new Set<string>()

  if (auth.email) allowed.add(auth.email.toLowerCase())

  const orgIds = auth.memberships.map(m => m.orgId)

  // A collaboration partner has no org membership but must still be able to
  // email the coordinator's contacts on projects they were invited to.
  const partnerOrgIds = await orgIdsWherePartner(sb, auth.userId)
  const scopeOrgIds = Array.from(new Set([...orgIds, ...partnerOrgIds]))

  if (scopeOrgIds.length === 0) {
    return candidates.filter(e => allowed.has(e))
  }

  // 1. Staff records in scope.
  const { data: persons } = await sb
    .from('persons')
    .select('email')
    .in('org_id', scopeOrgIds)
    .in('email', candidates)
  for (const p of (persons ?? []) as { email: string | null }[]) {
    if (p.email) allowed.add(p.email.toLowerCase())
  }

  // 2. Auth users who are members of an org in scope.
  const { data: members } = await sb
    .from('org_members')
    .select('user_id')
    .in('org_id', scopeOrgIds)
  const memberIds = (members ?? []).map((m: any) => m.user_id)
  if (memberIds.length > 0) {
    const { data: emailRows } = await sb.rpc('get_user_emails', { p_user_ids: memberIds })
    for (const row of (emailRows ?? []) as { email: string | null }[]) {
      if (row.email) allowed.add(row.email.toLowerCase())
    }
  }

  // 3. Partner contacts on projects owned by an org in scope.
  const { data: projects } = await sb.from('projects').select('id').in('org_id', scopeOrgIds)
  const projectIds = (projects ?? []).map((p: any) => p.id)
  if (projectIds.length > 0) {
    const { data: partners } = await sb
      .from('project_partners')
      .select('contact_email')
      .in('project_id', projectIds)
      .in('contact_email', candidates)
    for (const p of (partners ?? []) as { contact_email: string | null }[]) {
      if (p.contact_email) allowed.add(p.contact_email.toLowerCase())
    }
  }

  // 4. Partner contacts on proposals owned by an org in scope.
  const { data: proposals } = await sb.from('proposals').select('id').in('org_id', scopeOrgIds)
  const proposalIds = (proposals ?? []).map((p: any) => p.id)
  if (proposalIds.length > 0) {
    const { data: partners } = await sb
      .from('proposal_partners')
      .select('contact_email')
      .in('proposal_id', proposalIds)
      .in('contact_email', candidates)
    for (const p of (partners ?? []) as { contact_email: string | null }[]) {
      if (p.contact_email) allowed.add(p.contact_email.toLowerCase())
    }
  }

  return candidates.filter(e => allowed.has(e))
}

/** Organisations whose projects/proposals this user is an accepted partner on. */
async function orgIdsWherePartner(sb: SupabaseClient, userId: string): Promise<string[]> {
  const orgIds = new Set<string>()

  const { data: projectPartners } = await sb
    .from('project_partners')
    .select('projects(org_id)')
    .eq('user_id', userId)
    .eq('invite_status', 'accepted')
  for (const row of (projectPartners ?? []) as any[]) {
    const orgId = row.projects?.org_id
    if (orgId) orgIds.add(orgId)
  }

  const { data: proposalPartners } = await sb
    .from('proposal_partners')
    .select('proposals(org_id)')
    .eq('user_id', userId)
    .eq('invite_status', 'accepted')
  for (const row of (proposalPartners ?? []) as any[]) {
    const orgId = row.proposals?.org_id
    if (orgId) orgIds.add(orgId)
  }

  return Array.from(orgIds)
}

/**
 * Check whether a recipient has opted out of a given template, and fetch their
 * own unsubscribe token.
 *
 * Uses a single indexed lookup instead of the old
 * `auth.admin.listUsers({ perPage: 1000 })` scan, which broke past 1,000 users
 * and ran once per recipient.
 */
async function checkRecipient(
  sb: SupabaseClient,
  recipientEmail: string,
  templateName: string,
): Promise<{ allowed: boolean; unsubscribeToken: string | null }> {
  try {
    const { data: userId } = await sb.rpc('find_user_id_by_email', { p_email: recipientEmail })
    if (!userId) return { allowed: true, unsubscribeToken: null }

    const prefCol = PREF_COLUMN_MAP[templateName]
    const selectCols = prefCol ? `${prefCol}, unsubscribe_token` : 'unsubscribe_token'

    const { data: prefs } = await sb
      .from('user_preferences')
      .select(selectCols)
      .eq('user_id', userId as string)

    if (!prefs || prefs.length === 0) return { allowed: true, unsubscribeToken: null }

    const token = (prefs[0] as any)?.unsubscribe_token ?? null

    if (prefCol) {
      const optedOut = prefs.some((p: any) => p[prefCol] === false)
      if (optedOut) return { allowed: false, unsubscribeToken: token }
    }

    return { allowed: true, unsubscribeToken: token }
  } catch {
    return { allowed: true, unsubscribeToken: null }
  }
}
