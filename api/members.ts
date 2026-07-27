import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import {
  cors,
  authenticateRequest,
  requireOrgAdmin,
  requireOrgMember,
  handleAuthError,
  adminClient,
  type AuthContext,
} from './lib/auth.js'
import { checkRateLimit } from './lib/rateLimit.js'
import { appUrl } from './lib/appUrl.js'

/**
 * Consolidated members API.
 *
 * POST /api/members?action=invite-member    — Admin of the target org only
 * POST /api/members?action=resolve-emails   — members of the caller's org only
 * POST /api/members?action=collab-send      — member of the project's org only
 * POST /api/members?action=collab-accept    — authenticated; binds to the JWT
 * POST /api/members?action=collab-lookup    — public (invite preview)
 *
 * SECURITY MODEL
 * --------------
 * Authentication answers "who is this". It is NOT enough on its own. Every
 * handler below that receives an id in the request body must additionally
 * prove the caller has access to THAT organisation — otherwise a logged-in
 * user of company A can act on company B simply by pasting B's uuid.
 */

// Only collab-lookup is truly public — it previews the invite before the user
// signs in. collab-accept requires authentication so we can bind the partner
// row to the JWT's userId (not a self-declared body field).
const PUBLIC_ACTIONS = ['collab-lookup']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const action = (req.query.action as string) || ''

  // Rate limits: slower on the invite-token endpoints to blunt brute-force,
  // but not so slow that a user refreshing the invite page a few times trips
  // the limit.
  if (action === 'collab-lookup' || action === 'collab-accept') {
    if (!checkRateLimit(req, res, { limit: 20, windowSeconds: 60, prefix: 'members-invite' })) return
  } else {
    if (!checkRateLimit(req, res, { limit: 30, windowSeconds: 60, prefix: 'members' })) return
  }

  try {
    let auth: AuthContext | null = null
    if (!PUBLIC_ACTIONS.includes(action)) {
      auth = await authenticateRequest(req)
    }

    const sb = adminClient()

    switch (action) {
      case 'invite-member':
        return await handleInviteMember(req, res, sb, auth!)
      case 'resolve-emails':
        return await handleResolveEmails(req, res, sb, auth!)
      case 'collab-send':
        return await handleCollabSend(req, res, sb, auth!)
      case 'collab-accept':
        return await handleCollabAccept(req, res, sb, auth!)
      case 'collab-lookup':
        return await handleCollabLookup(req, res, sb)
      default:
        return res.status(400).json({ error: `Unknown action: "${action}"` })
    }
  } catch (err) {
    return handleAuthError(err, res)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// invite-member
// ════════════════════════════════════════════════════════════════════════════

const ASSIGNABLE_ROLES = ['Admin', 'Project Manager', 'Finance Officer', 'Viewer', 'External Participant']

async function handleInviteMember(
  req: VercelRequest,
  res: VercelResponse,
  sb: SupabaseClient,
  auth: AuthContext,
) {
  const { email, orgId, role, personId } = req.body ?? {}

  // AUTHORIZATION — without this, any authenticated user could add themselves
  // (or anyone) as Admin of any organisation whose uuid they knew.
  requireOrgAdmin(auth, orgId)

  if (!email || typeof email !== 'string' || !role) {
    return res.status(400).json({ error: 'Missing required fields: email, orgId, role' })
  }
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
  }

  const normalisedEmail = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
    return res.status(400).json({ error: 'Invalid email address' })
  }

  try {
    // Look the user up in the database rather than paging listUsers(), which
    // silently stopped working past 1,000 users.
    const { data: existingId, error: lookupErr } = await sb
      .rpc('find_user_id_by_email', { p_email: normalisedEmail })

    if (lookupErr) {
      console.error('[GrantLume] invite-member: user lookup failed:', lookupErr.message)
      return res.status(500).json({ error: 'Failed to look up user account' })
    }

    let userId: string | null = (existingId as string | null) ?? null
    let isNewUser = false

    if (!userId) {
      const tempPassword = crypto.randomBytes(24).toString('base64url')
      const { data: created, error: createErr } = await sb.auth.admin.createUser({
        email: normalisedEmail,
        password: tempPassword,
        email_confirm: true,
      })

      if (createErr) {
        console.error('[GrantLume] invite-member: createUser failed:', createErr.message)
        return res.status(500).json({ error: 'Failed to create user account' })
      }

      userId = created?.user?.id ?? null
      isNewUser = true
    }

    if (!userId) {
      return res.status(500).json({ error: 'Could not resolve user ID' })
    }

    // Already a member?
    const { data: existingMember } = await sb
      .from('org_members')
      .select('id')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingMember) {
      return res.status(409).json({ error: 'User is already a member of this organisation' })
    }

    // The inviter is taken from the verified JWT, never from the body.
    const { error: insertErr } = await sb.from('org_members').insert({
      user_id: userId,
      org_id: orgId,
      role,
      invited_by: auth.userId,
    })

    if (insertErr) {
      console.error('[GrantLume] invite-member: membership insert failed:', insertErr.message)
      return res.status(500).json({ error: 'Failed to add member to organisation' })
    }

    // Link the person record — scoped to the same organisation so a person id
    // from another company cannot be hijacked.
    if (personId && typeof personId === 'string') {
      await sb.from('persons').update({
        user_id: userId,
        invite_status: 'pending',
        invite_role: role,
        updated_at: new Date().toISOString(),
      }).eq('id', personId).eq('org_id', orgId)
    }

    return res.status(200).json({ success: true, userId, isNewUser })
  } catch (err: any) {
    console.error('[GrantLume] invite-member failed:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// resolve-emails
// ════════════════════════════════════════════════════════════════════════════

async function handleResolveEmails(
  req: VercelRequest,
  res: VercelResponse,
  sb: SupabaseClient,
  auth: AuthContext,
) {
  const { userIds, orgId } = req.body ?? {}

  // AUTHORIZATION — this endpoint used to accept any user ids at all and hand
  // back their email addresses, which made it a directory-enumeration tool.
  requireOrgMember(auth, orgId)

  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'Missing required field: userIds (array)' })
  }
  if (userIds.length > 200) {
    return res.status(400).json({ error: 'Too many userIds (max 200)' })
  }
  const requested = userIds.filter((id: unknown): id is string => typeof id === 'string')

  try {
    // Intersect the request with the caller's own organisation. Ids outside it
    // are dropped silently rather than reported, so this cannot be used to test
    // whether a given user exists.
    const { data: members } = await sb
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .in('user_id', requested)

    const allowedIds = (members ?? []).map((m: any) => m.user_id)
    if (allowedIds.length === 0) {
      return res.status(200).json({ emails: {} })
    }

    const { data: rows, error } = await sb.rpc('get_user_emails', { p_user_ids: allowedIds })
    if (error) {
      console.error('[GrantLume] resolve-emails failed:', error.message)
      return res.status(500).json({ error: 'Failed to resolve emails' })
    }

    const emails: Record<string, string> = {}
    for (const row of (rows ?? []) as { user_id: string; email: string | null }[]) {
      if (row.email) emails[row.user_id] = row.email
    }

    return res.status(200).json({ emails })
  } catch (err: any) {
    console.error('[GrantLume] resolve-emails failed:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// collab-accept
// ════════════════════════════════════════════════════════════════════════════
//
// Security model:
//  - Caller MUST be authenticated (JWT required upstream).
//  - The partner row is bound to `auth.userId` from the JWT. Any `userId`
//    in the body is ignored — otherwise anyone holding the invite URL could
//    bind it to someone else's account.
//  - On success the `invite_token` is rotated to a fresh UUID, which makes
//    the original invite URL single-use even if it's forwarded/leaked.

async function handleCollabAccept(
  req: VercelRequest,
  res: VercelResponse,
  sb: SupabaseClient,
  auth: AuthContext,
) {
  const { token } = req.body ?? {}
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Missing token' })
  if (!auth?.userId) return res.status(401).json({ error: 'Not authenticated' })

  // Look in both project_partners and proposal_partners.
  let context: 'project' | 'proposal' | null = null
  let partner: any = null
  {
    const { data } = await sb
      .from('project_partners')
      .select('id, project_id, org_name, invite_status, user_id')
      .eq('invite_token', token)
      .maybeSingle()
    if (data) { partner = data; context = 'project' }
  }
  if (!partner) {
    const { data } = await sb
      .from('proposal_partners')
      .select('id, proposal_id, org_name, invite_status, user_id')
      .eq('invite_token', token)
      .maybeSingle()
    if (data) { partner = data; context = 'proposal' }
  }

  if (!partner || !context) {
    return res.status(404).json({ error: 'Invitation not found or already used' })
  }

  if (partner.invite_status === 'declined') {
    return res.status(400).json({ error: 'This invitation was declined' })
  }

  if (partner.invite_status === 'accepted') {
    if (partner.user_id && partner.user_id !== auth.userId) {
      return res.status(403).json({ error: 'Invitation already bound to a different account' })
    }
    return res.status(200).json({
      success: true,
      message: 'Already accepted',
      context,
      projectId: context === 'project' ? partner.project_id : undefined,
      proposalId: context === 'proposal' ? partner.proposal_id : undefined,
    })
  }

  const updateData = {
    invite_status: 'accepted',
    user_id: auth.userId,
    invite_token: crypto.randomUUID(),
    updated_at: new Date().toISOString(),
  }

  const tableName = context === 'project' ? 'project_partners' : 'proposal_partners'
  const { data: updated, error: updateErr } = await sb
    .from(tableName)
    .update(updateData)
    .eq('id', partner.id)
    .eq('invite_status', 'pending')
    .select('id')

  if (updateErr) {
    console.error('[GrantLume] collab-accept update failed:', updateErr.message)
    return res.status(500).json({ error: 'Failed to accept invitation' })
  }
  // Zero rows means someone else accepted between our read and our write.
  if (!updated || updated.length === 0) {
    return res.status(409).json({ error: 'This invitation has already been used' })
  }

  return res.status(200).json({
    success: true,
    context,
    projectId: context === 'project' ? partner.project_id : undefined,
    proposalId: context === 'proposal' ? partner.proposal_id : undefined,
    partnerId: partner.id,
    orgName: partner.org_name,
  })
}

// ════════════════════════════════════════════════════════════════════════════
// collab-send
// ════════════════════════════════════════════════════════════════════════════

async function handleCollabSend(
  req: VercelRequest,
  res: VercelResponse,
  sb: SupabaseClient,
  auth: AuthContext,
) {
  const { projectId } = req.body ?? {}
  if (!projectId || typeof projectId !== 'string') {
    return res.status(400).json({ error: 'Missing projectId' })
  }

  const { data: project, error: projErr } = await sb
    .from('projects')
    .select('id, org_id, acronym, title')
    .eq('id', projectId)
    .maybeSingle()

  if (projErr || !project) {
    return res.status(404).json({ error: 'Project not found' })
  }

  // AUTHORIZATION — resolve the org from the project, then check membership.
  requireOrgMember(auth, (project as any).org_id)

  const { data: partners, error: partErr } = await sb
    .from('project_partners')
    .select('id, org_name, contact_email, invite_token, invite_status')
    .eq('project_id', projectId)
    .eq('invite_status', 'pending')

  if (partErr) {
    return res.status(500).json({ error: 'Failed to fetch partners' })
  }

  // The base URL used to be built with a precedence bug that produced
  // "https://undefined/collab/accept" whenever VITE_APP_URL was set but
  // VERCEL_URL was not. appUrl() resolves it correctly in one place.
  const inviteBaseUrl = `${appUrl()}/collab/accept`

  const pending = partners ?? []
  const sent: string[] = []
  const skipped: string[] = []

  for (const p of pending) {
    if (!p.contact_email) {
      skipped.push(p.org_name)
      continue
    }
    sent.push(p.org_name)
  }

  // NOTE: this endpoint deliberately does NOT send email itself — the client
  // sends the branded template through /api/send-email once it has the tokens.
  // Previously it returned `sent` without sending anything and without giving
  // the caller the tokens, so the UI reported success for a no-op.
  return res.status(200).json({
    success: true,
    sent,
    skipped,
    totalPending: pending.length,
    inviteBaseUrl,
    invites: pending
      .filter(p => !!p.contact_email)
      .map(p => ({
        partnerId: p.id,
        orgName: p.org_name,
        contactEmail: p.contact_email,
        inviteUrl: `${inviteBaseUrl}?token=${encodeURIComponent(p.invite_token)}`,
      })),
  })
}

// ════════════════════════════════════════════════════════════════════════════
// collab-lookup  (public — previews an invite before sign-in)
// ════════════════════════════════════════════════════════════════════════════

async function handleCollabLookup(req: VercelRequest, res: VercelResponse, sb: SupabaseClient) {
  const { token } = req.body ?? {}
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Missing token' })

  // Look up the token in BOTH project_partners and proposal_partners —
  // the same invite token can belong to either context. First hit wins.
  let partner: any = null
  let context: 'project' | 'proposal' | null = null

  {
    const { data } = await sb
      .from('project_partners')
      .select(`
        id, org_name, invite_status, role, participant_number,
        project:projects(id, acronym, title, org_id, organisations(name))
      `)
      .eq('invite_token', token)
      .maybeSingle()
    if (data) {
      partner = data
      context = 'project'
    }
  }

  if (!partner) {
    const { data } = await sb
      .from('proposal_partners')
      .select(`
        id, org_name, invite_status, role, participant_number,
        proposal:proposals(id, project_name, call_identifier, org_id, organisations(name))
      `)
      .eq('invite_token', token)
      .maybeSingle()
    if (data) {
      partner = data
      context = 'proposal'
    }
  }

  if (!partner || !context) {
    return res.status(404).json({ error: 'Invitation not found' })
  }

  const shaped = {
    ...partner,
    context,
    collab_projects: (partner as any).project,  // legacy alias for older UI
  }
  return res.status(200).json({ success: true, partner: shaped })
}
