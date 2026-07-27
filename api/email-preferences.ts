import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit } from './lib/rateLimit.js'

/**
 * Public API endpoint for managing email preferences via unsubscribe token.
 * No authentication required — the token itself is the proof of identity.
 *
 * GET  /api/email-preferences?token=<uuid>         → returns current preferences
 * POST /api/email-preferences?token=<uuid>         → updates preferences
 * POST /api/email-preferences?token=<uuid>&action=unsubscribe-all  → disables all emails
 */

const ALLOWED_ORIGINS = [
  'https://app.grantlume.com',
  'https://www.grantlume.com',
  'http://localhost:5173',
  'http://localhost:3000',
]

/** Email preference columns that can be toggled */
const EMAIL_COLUMNS = [
  'email_timesheet_reminders',
  'email_timesheet_submitted',
  'email_project_alerts',
  'email_budget_alerts',
  'email_period_locked',
  'email_role_changes',
  'email_invitations',
  'email_welcome',
  'email_trial_expiring',
  'email_substitute_notifications',
  'email_absence_notifications',
  'email_collab_notifications',
] as const

function cors(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string) || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  } else if (
    process.env.VERCEL_ENV === 'preview' &&
    // Only reflect origins that actually look like Vercel preview URLs, not
    // any arbitrary origin claiming to be a preview.
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Rate limit: 30 requests per 60s per IP
  if (!checkRateLimit(req, res, { limit: 30, windowSeconds: 60, prefix: 'email-prefs' })) return

  const token = (req.query.token as string) || ''
  if (!token || token.length < 30) {
    return res.status(400).json({ error: 'Missing or invalid token' })
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  try {
    // Look up preferences by unsubscribe token
    const { data: prefs, error: fetchErr } = await supabase
      .from('user_preferences')
      .select('*')
      .eq('unsubscribe_token', token)
      .single()

    if (fetchErr || !prefs) {
      return res.status(404).json({ error: 'Invalid or expired preferences link. Please use the latest link from a recent email.' })
    }

    // GET — return current preferences
    if (req.method === 'GET') {
      // Look up the user's email for display
      const { data: userData } = await supabase.auth.admin.getUserById(prefs.user_id)
      const userEmail = userData?.user?.email ?? null

      // Look up org name
      const { data: orgData } = await supabase
        .from('organisations')
        .select('name')
        .eq('id', prefs.org_id)
        .single()

      const response: Record<string, any> = {
        email: userEmail ? maskEmail(userEmail) : null,
        orgName: orgData?.name ?? null,
      }
      for (const col of EMAIL_COLUMNS) {
        response[col] = prefs[col] ?? true
      }
      return res.status(200).json(response)
    }

    // POST — update preferences
    const action = (req.query.action as string) || ''

    if (action === 'unsubscribe-all') {
      // Disable all optional emails
      const updates: Record<string, any> = { updated_at: new Date().toISOString() }
      for (const col of EMAIL_COLUMNS) {
        updates[col] = false
      }
      const { error: updateErr } = await supabase
        .from('user_preferences')
        .update(updates)
        .eq('id', prefs.id)

      if (updateErr) {
        console.error('[email-preferences] unsubscribe-all error:', updateErr)
        return res.status(500).json({ error: 'Failed to update preferences' })
      }
      return res.status(200).json({ success: true, message: 'Unsubscribed from all optional emails' })
    }

    // Normal update — expect { email_timesheet_reminders: true, ... }
    const body = req.body ?? {}
    const updates: Record<string, any> = { updated_at: new Date().toISOString() }
    let hasUpdates = false

    for (const col of EMAIL_COLUMNS) {
      if (col in body && typeof body[col] === 'boolean') {
        updates[col] = body[col]
        hasUpdates = true
      }
    }

    if (!hasUpdates) {
      return res.status(400).json({ error: 'No valid preference fields provided' })
    }

    const { error: updateErr } = await supabase
      .from('user_preferences')
      .update(updates)
      .eq('id', prefs.id)

    if (updateErr) {
      console.error('[email-preferences] update error:', updateErr)
      return res.status(500).json({ error: 'Failed to update preferences' })
    }

    return res.status(200).json({ success: true })
  } catch (err: any) {
    console.error('[email-preferences] Unexpected error:', err)
    return res.status(500).json({ error: err.message || 'Internal error' })
  }
}

/** Mask email for privacy: jo***@example.com */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '***'
  const visible = local.slice(0, 2)
  return `${visible}***@${domain}`
}
