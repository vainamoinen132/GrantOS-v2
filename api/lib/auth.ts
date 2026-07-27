import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── CORS ────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://app.grantlume.com',
  'https://www.grantlume.com',
  'http://localhost:5173',
  'http://localhost:3000',
]

export function cors(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string) || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  } else if (
    process.env.VERCEL_ENV === 'preview' &&
    // Only accept preview origins that actually look like Vercel preview URLs,
    // not any arbitrary origin that claims to be a preview.
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
}

// ── Auth ────────────────────────────────────────────────────────────────────

export type OrgRole = 'Admin' | 'Project Manager' | 'Finance Officer' | 'Viewer' | 'External Participant'

export interface OrgMembership {
  orgId: string
  role: OrgRole
}

export interface AuthContext {
  userId: string
  email: string | undefined
  /** The caller's primary organisation (oldest membership), or null. */
  orgId: string | null
  /** The caller's role in that primary organisation, or null. */
  role: OrgRole | null
  /** EVERY organisation the caller belongs to. Authorization must use this. */
  memberships: OrgMembership[]
}

export class AuthError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'AuthError'
  }
}

/** Service-role client. Bypasses RLS — never hand this to a user-supplied id
 *  without an explicit authorization check first. */
export function adminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new AuthError(500, 'Server configuration error: missing Supabase service credentials')
  }
  return createClient(url, key)
}

/**
 * Authenticate a request by verifying the JWT from the Authorization header.
 * Returns the authenticated user's context, or throws an AuthError.
 *
 * Authentication only answers "who is this". It does NOT authorize access to
 * any particular organisation — use requireOrgMember / requireOrgAdmin for
 * that, and never trust an org id taken from the request body.
 */
export async function authenticateRequest(req: VercelRequest): Promise<AuthContext> {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError(401, 'Missing or invalid Authorization header')
  }

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) {
    throw new AuthError(401, 'Empty bearer token')
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new AuthError(500, 'Server configuration error: missing Supabase credentials')
  }

  // Verify the JWT by calling getUser with the token
  const supabase = createClient(supabaseUrl, supabaseAnonKey)
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    throw new AuthError(401, 'Invalid or expired token')
  }

  // Look up org memberships using the service role (bypasses RLS).
  // A missing service key is a hard failure: without it we cannot authorize
  // anything, and silently returning "no org" would let callers through on
  // endpoints that treat a null org as "skip the check".
  const admin = adminClient()
  const { data: members, error: memberErr } = await admin
    .from('org_members')
    .select('org_id, role, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  if (memberErr) {
    throw new AuthError(500, 'Failed to resolve organisation membership')
  }

  const memberships: OrgMembership[] = (members ?? []).map((m: any) => ({
    orgId: m.org_id,
    role: m.role as OrgRole,
  }))

  return {
    userId: user.id,
    email: user.email,
    orgId: memberships[0]?.orgId ?? null,
    role: memberships[0]?.role ?? null,
    memberships,
  }
}

// ── Authorization ───────────────────────────────────────────────────────────

/**
 * Assert the caller belongs to `orgId` and return their role there.
 * Throws 400 if no org id was supplied, 403 if they are not a member.
 *
 * Always call this before using a client-supplied organisation id in any
 * service-role query.
 */
export function requireOrgMember(auth: AuthContext, orgId: unknown): OrgRole {
  if (typeof orgId !== 'string' || !orgId) {
    throw new AuthError(400, 'Missing organisation id')
  }
  const membership = auth.memberships.find(m => m.orgId === orgId)
  if (!membership) {
    // Deliberately identical to the "not a member" case so this cannot be used
    // to probe which organisation ids exist.
    throw new AuthError(403, 'You do not have access to this organisation')
  }
  return membership.role
}

/** Assert the caller is an Admin of `orgId`. */
export function requireOrgAdmin(auth: AuthContext, orgId: unknown): void {
  const role = requireOrgMember(auth, orgId)
  if (role !== 'Admin') {
    throw new AuthError(403, 'This action requires an Admin role')
  }
}

/** Assert the caller holds one of `roles` in `orgId`. */
export function requireOrgRole(auth: AuthContext, orgId: unknown, roles: OrgRole[]): void {
  const role = requireOrgMember(auth, orgId)
  if (!roles.includes(role)) {
    throw new AuthError(403, `This action requires one of: ${roles.join(', ')}`)
  }
}

/**
 * Resolve the organisation that owns a row, then assert the caller belongs to
 * it. Use for endpoints that take a project/proposal/person id rather than an
 * org id.
 */
export async function requireOrgForRow(
  auth: AuthContext,
  admin: SupabaseClient,
  table: string,
  rowId: unknown,
  orgColumn = 'org_id',
): Promise<string> {
  if (typeof rowId !== 'string' || !rowId) {
    throw new AuthError(400, `Missing ${table} id`)
  }
  const { data, error } = await admin
    .from(table)
    .select(orgColumn)
    .eq('id', rowId)
    .maybeSingle()

  if (error) throw new AuthError(500, `Failed to resolve ${table}`)
  if (!data) throw new AuthError(404, 'Not found')

  const orgId = (data as any)[orgColumn] as string | null
  if (!orgId) throw new AuthError(403, 'You do not have access to this record')

  requireOrgMember(auth, orgId)
  return orgId
}

/**
 * Handle auth/authorization errors in API routes.
 * Never leaks internal error text for non-AuthError failures.
 */
export function handleAuthError(err: unknown, res: VercelResponse) {
  if (err instanceof AuthError) {
    return res.status(err.status).json({ error: err.message })
  }
  console.error('[GrantLume] Unexpected auth error:', err)
  return res.status(500).json({ error: 'Internal server error' })
}
