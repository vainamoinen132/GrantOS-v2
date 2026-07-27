import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Resend } from 'resend'
import {
  cors,
  authenticateRequest,
  requireOrgMember,
  handleAuthError,
  adminClient,
  type AuthContext,
} from './lib/auth.js'
import { checkRateLimit } from './lib/rateLimit.js'
import { readRawBody, parseJsonBody, BodyError } from './lib/rawBody.js'
import { appUrl } from './lib/appUrl.js'
import { escapeHtml } from './lib/html.js'

/**
 * POST /api/docusign?action=sign     — Create DocuSign envelope for signing
 * POST /api/docusign?action=webhook  — DocuSign Connect webhook callback
 *
 * Consolidated into one serverless function to stay within Vercel Hobby plan limits.
 *
 * The body parser is disabled so the webhook can verify DocuSign's HMAC
 * against the exact bytes it sent — see api/lib/rawBody.ts.
 */

export const config = {
  api: { bodyParser: false },
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Rate limit: 10 docusign requests per 60s per IP
  if (!checkRateLimit(req, res, { limit: 10, windowSeconds: 60, prefix: 'docusign' })) return

  const action = (req.query.action as string) || ''

  try {
    switch (action) {
      case 'sign': {
        // Webhooks are called by DocuSign and verified by HMAC. Everything
        // else is a user action and needs a JWT plus an organisation check.
        const auth = await authenticateRequest(req)
        return await handleSign(req, res, auth)
      }
      case 'webhook':
        return await handleWebhook(req, res)
      default:
        return res.status(400).json({ error: `Unknown action: "${action}". Use ?action=sign or ?action=webhook` })
    }
  } catch (err) {
    if (err instanceof BodyError) {
      return res.status(err.status).json({ error: err.message })
    }
    return handleAuthError(err, res)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Action: sign — Create DocuSign envelope + get embedded signing URL
// ════════════════════════════════════════════════════════════════════════════

interface DocuSignConfig {
  integrationKey: string
  userId: string
  accountId: string
  rsaPrivateKey: string
  baseUrl: string
  oauthBaseUrl: string
}

async function getDocuSignAccessToken(config: DocuSignConfig): Promise<string> {
  const { integrationKey, userId, rsaPrivateKey, oauthBaseUrl: oauthBase } = config

  // Build JWT assertion
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: integrationKey,
    sub: userId,
    aud: oauthBase.replace('https://', ''),
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  })).toString('base64url')

  const { createSign } = await import('crypto')
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  const signature = signer.sign(rsaPrivateKey, 'base64url')

  const jwt = `${header}.${payload}.${signature}`

  // Exchange JWT for access token
  const tokenRes = await fetch(`${oauthBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    throw new Error(`DocuSign OAuth failed: ${tokenRes.status} — ${errText}`)
  }

  const tokenData = await tokenRes.json() as any
  return tokenData.access_token
}

function buildTimesheetHtml(params: {
  personName: string
  orgName: string
  month: string
  year: number
  totalHours: number
  workingDays: number
  days: { date: string; project: string; wp: string | null; hours: number }[]
}): string {
  // Group days by date for a clean table
  const dayMap = new Map<string, { project: string; wp: string | null; hours: number }[]>()
  for (const d of params.days) {
    if (!dayMap.has(d.date)) dayMap.set(d.date, [])
    dayMap.get(d.date)!.push({ project: d.project, wp: d.wp, hours: d.hours })
  }

  const sortedDates = Array.from(dayMap.keys()).sort()

  // This HTML becomes a legally signed document — every interpolated value is
  // escaped so a project or person name can never inject markup into it.
  const rows = sortedDates.map(date => {
    const entries = dayMap.get(date)!
    return entries.map((e, i) => `
      <tr style="border-bottom:1px solid #e5e7eb;">
        ${i === 0 ? `<td rowspan="${entries.length}" style="padding:6px 10px;font-size:13px;vertical-align:top;">${escapeHtml(date)}</td>` : ''}
        <td style="padding:6px 10px;font-size:13px;">${escapeHtml(e.project)}${e.wp ? ` / ${escapeHtml(e.wp)}` : ''}</td>
        <td style="padding:6px 10px;font-size:13px;text-align:right;">${e.hours.toFixed(1)}h</td>
      </tr>
    `).join('')
  }).join('')

  return `
    <html>
    <body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;margin:40px;">
      <div style="margin-bottom:30px;">
        <h1 style="font-size:20px;margin:0;">Monthly Timesheet</h1>
        <p style="font-size:14px;color:#6b7280;margin:4px 0 0;">${escapeHtml(params.orgName)}</p>
      </div>
      <table style="font-size:13px;margin-bottom:20px;">
        <tr><td style="padding:3px 16px 3px 0;font-weight:600;">Employee:</td><td>${escapeHtml(params.personName)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0;font-weight:600;">Period:</td><td>${escapeHtml(params.month)} ${params.year}</td></tr>
        <tr><td style="padding:3px 16px 3px 0;font-weight:600;">Working Days:</td><td>${params.workingDays}</td></tr>
        <tr><td style="padding:3px 16px 3px 0;font-weight:600;">Total Hours:</td><td>${params.totalHours.toFixed(1)}h</td></tr>
      </table>

      <table style="width:100%;border-collapse:collapse;border:1px solid #d1d5db;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:8px 10px;text-align:left;font-size:12px;font-weight:600;border-bottom:2px solid #d1d5db;">Date</th>
            <th style="padding:8px 10px;text-align:left;font-size:12px;font-weight:600;border-bottom:2px solid #d1d5db;">Project / WP</th>
            <th style="padding:8px 10px;text-align:right;font-size:12px;font-weight:600;border-bottom:2px solid #d1d5db;">Hours</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          <tr style="background:#f3f4f6;font-weight:700;">
            <td colspan="2" style="padding:8px 10px;font-size:13px;border-top:2px solid #d1d5db;">Total</td>
            <td style="padding:8px 10px;font-size:13px;text-align:right;border-top:2px solid #d1d5db;">${params.totalHours.toFixed(1)}h</td>
          </tr>
        </tbody>
      </table>

      <div style="margin-top:40px;">
        <p style="font-size:12px;color:#6b7280;margin-bottom:30px;">
          I hereby confirm that the hours recorded above are accurate and complete.
        </p>
        <div style="margin-top:20px;">
          <p style="font-size:11px;color:#9ca3af;">Signature:</p>
          <div style="border-bottom:1px solid #1f2937;width:300px;height:40px;"></div>
          <p style="font-size:11px;color:#9ca3af;margin-top:4px;">**signature_1**</p>
        </div>
        <div style="margin-top:16px;">
          <p style="font-size:11px;color:#9ca3af;">Date signed:</p>
          <p style="font-size:11px;color:#9ca3af;">**date_signed_1**</p>
        </div>
      </div>

      <div style="margin-top:40px;padding-top:12px;border-top:1px solid #e5e7eb;">
        <p style="font-size:10px;color:#9ca3af;">Generated by GrantLume — Grant & Project Management</p>
      </div>
    </body>
    </html>
  `
}

async function handleSign(req: VercelRequest, res: VercelResponse, auth: AuthContext) {
  const body = await parseJsonBody(req)
  const { orgId, personId, year, month } = body || {}

  // AUTHORIZATION — orgId and personId arrive from the client. Without this
  // check any authenticated user could pass another company's ids and receive
  // an embedded signing URL for someone else's timesheet, signed with that
  // company's DocuSign credentials.
  requireOrgMember(auth, orgId)

  if (!personId || typeof personId !== 'string') {
    return res.status(400).json({ error: 'Missing personId' })
  }
  const yearNum = Number(year)
  const monthNum = Number(month)
  if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
    return res.status(400).json({ error: 'Invalid year' })
  }
  if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
    return res.status(400).json({ error: 'Invalid month' })
  }

  const supabase: any = adminClient()

  try {
    // 1. Get person info — scoped to the authorized organisation, so a person
    //    id belonging to a different company resolves to "not found".
    const { data: person, error: pErr } = await supabase
      .from('persons')
      .select('id, full_name, email')
      .eq('id', personId)
      .eq('org_id', orgId)
      .maybeSingle()
    if (pErr || !person) return res.status(404).json({ error: 'Person not found' })
    if (!person.email) return res.status(400).json({ error: 'Person has no email address — required for DocuSign' })

    // 2. Get org info + DocuSign config from DB
    const { data: org } = await supabase
      .from('organisations')
      .select('name, docusign_integration_key, docusign_user_id, docusign_account_id, docusign_rsa_private_key, docusign_base_url, docusign_oauth_base_url')
      .eq('id', orgId)
      .single()
    const orgName = org?.name || 'Organisation'

    // Resolve DocuSign config: DB first, env vars as fallback
    const dsConfig: DocuSignConfig = {
      integrationKey: org?.docusign_integration_key || process.env.DOCUSIGN_INTEGRATION_KEY || '',
      userId: org?.docusign_user_id || process.env.DOCUSIGN_USER_ID || '',
      accountId: org?.docusign_account_id || process.env.DOCUSIGN_ACCOUNT_ID || '',
      rsaPrivateKey: (org?.docusign_rsa_private_key || process.env.DOCUSIGN_RSA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      baseUrl: org?.docusign_base_url || process.env.DOCUSIGN_BASE_URL || 'https://demo.docusign.net/restapi',
      oauthBaseUrl: org?.docusign_oauth_base_url || process.env.DOCUSIGN_OAUTH_BASE_URL || 'https://account-d.docusign.com',
    }

    if (!dsConfig.integrationKey || !dsConfig.userId || !dsConfig.accountId || !dsConfig.rsaPrivateKey) {
      return res.status(500).json({ error: 'DocuSign is not configured. Go to Settings → Integrations to set up DocuSign.' })
    }

    // 3. Get the timesheet envelope
    const { data: envelope, error: eErr } = await supabase
      .from('timesheet_entries')
      .select('*')
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('year', yearNum)
      .eq('month', monthNum)
      .is('project_id', null)
      .maybeSingle()
    if (eErr || !envelope) return res.status(404).json({ error: 'Timesheet envelope not found' })
    if (envelope.status !== 'Submitted') {
      return res.status(400).json({ error: 'Timesheet must be submitted before signing' })
    }

    // 4. Get timesheet days
    const startDate = `${yearNum}-${String(monthNum).padStart(2, '0')}-01`
    const lastDay = new Date(yearNum, monthNum, 0).getDate()
    const endDate = `${yearNum}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const { data: dayRows } = await supabase
      .from('timesheet_days')
      .select('date, hours, project_id, work_package_id, projects(acronym)')
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date')

    const days = (dayRows || []).map((d: any) => ({
      date: d.date,
      project: d.projects?.acronym || d.project_id,
      wp: d.work_package_id,
      hours: Number(d.hours) || 0,
    }))

    const totalHours = days.reduce((s: number, d: any) => s + d.hours, 0)
    const workingDays = envelope.working_days || 0

    // 5. Build HTML document
    const html = buildTimesheetHtml({
      personName: person.full_name,
      orgName,
      month: MONTHS[monthNum - 1],
      year: yearNum,
      totalHours,
      workingDays,
      days,
    })

    // 6. Get DocuSign access token
    const accessToken = await getDocuSignAccessToken(dsConfig)
    const accountId = dsConfig.accountId
    const baseUrl = dsConfig.baseUrl
    const returnBase = appUrl()

    // 7. Create envelope with embedded signing
    const documentBase64 = Buffer.from(html).toString('base64')

    const envelopePayload = {
      emailSubject: `Timesheet for signing: ${MONTHS[monthNum - 1]} ${yearNum} — ${person.full_name}`,
      emailBlurb: `Please review and sign your timesheet for ${MONTHS[monthNum - 1]} ${yearNum}.`,
      documents: [{
        documentId: '1',
        name: `Timesheet_${person.full_name.replace(/\s+/g, '_')}_${MONTHS[monthNum - 1]}_${yearNum}.html`,
        htmlDefinition: { source: 'document' },
        documentBase64,
      }],
      recipients: {
        signers: [{
          email: person.email,
          name: person.full_name,
          recipientId: '1',
          routingOrder: '1',
          clientUserId: personId, // embedded signing
          tabs: {
            signHereTabs: [{
              anchorString: '**signature_1**',
              anchorUnits: 'pixels',
              anchorXOffset: '0',
              anchorYOffset: '-10',
            }],
            dateSignedTabs: [{
              anchorString: '**date_signed_1**',
              anchorUnits: 'pixels',
              anchorXOffset: '0',
              anchorYOffset: '-10',
            }],
          },
        }],
      },
      status: 'sent',
    }

    const createRes = await fetch(`${baseUrl}/v2.1/accounts/${accountId}/envelopes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(envelopePayload),
    })

    if (!createRes.ok) {
      const errText = await createRes.text()
      console.error('[docusign] Envelope creation failed:', errText)
      return res.status(502).json({ error: 'Failed to create DocuSign envelope', details: errText })
    }

    const envelopeData = await createRes.json() as any
    const envelopeId = envelopeData.envelopeId

    // 8. Get embedded signing URL (recipient view)
    const viewPayload = {
      returnUrl: `${returnBase}/timesheets?signed=1&month=${monthNum}&year=${yearNum}`,
      authenticationMethod: 'none',
      email: person.email,
      userName: person.full_name,
      clientUserId: personId,
    }

    const viewRes = await fetch(
      `${baseUrl}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(viewPayload),
      },
    )

    if (!viewRes.ok) {
      const errText = await viewRes.text()
      console.error('[docusign] Recipient view failed:', errText)
      return res.status(502).json({ error: 'Failed to get signing URL', details: errText })
    }

    const viewData = await viewRes.json() as any
    const signingUrl = viewData.url

    // 9. Update timesheet_entries with signing info
    await supabase
      .from('timesheet_entries')
      .update({
        status: 'Signing',
        signature_status: 'sent',
        signature_envelope_id: envelopeId,
        signature_url: signingUrl,
        updated_at: new Date().toISOString(),
      } as any)
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('year', yearNum)
      .eq('month', monthNum)
      .is('project_id', null)

    // 10. Create in-app notification
    const { data: personUser } = await supabase
      .from('persons')
      .select('user_id')
      .eq('id', personId)
      .eq('org_id', orgId)
      .maybeSingle()

    if (personUser?.user_id) {
      const { error: notifErr } = await supabase.from('notifications').insert({
        user_id: personUser.user_id,
        org_id: orgId,
        type: 'timesheet_ready_to_sign',
        title: 'Timesheet ready for signing',
        message: `Your timesheet for ${MONTHS[monthNum - 1]} ${yearNum} is ready to be signed.`,
        link: '/timesheets',
      })
      if (notifErr) console.error('[docusign] notification insert failed:', notifErr.message)
    }

    return res.status(200).json({
      envelopeId,
      signingUrl,
      status: 'sent',
    })
  } catch (err) {
    console.error('[docusign] Sign error:', err)
    // Never echo internal error text back to the client.
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Action: webhook — DocuSign Connect callback
// ════════════════════════════════════════════════════════════════════════════

async function handleWebhook(req: VercelRequest, res: VercelResponse) {
  // HMAC verification is mandatory. Without it, any POST to this endpoint
  // could forge an envelope status change.
  const hmacKey = process.env.DOCUSIGN_CONNECT_HMAC_KEY
  if (!hmacKey) {
    console.error('[docusign] DOCUSIGN_CONNECT_HMAC_KEY not set — refusing webhook')
    return res.status(500).json({ error: 'Webhook HMAC key not configured' })
  }

  // The EXACT bytes DocuSign signed. Hashing JSON.stringify(req.body) instead
  // of the raw body meant the digest essentially never matched, so every
  // callback was rejected and timesheets never reached "Signed".
  const raw = await readRawBody(req)

  const { createHmac, timingSafeEqual } = await import('crypto')
  const computed = createHmac('sha256', hmacKey).update(raw).digest('base64')

  // DocuSign may send several signatures (one per configured key) as
  // x-docusign-signature-1, -2, … Accept if ANY of them matches.
  const candidates: string[] = []
  for (let i = 1; i <= 5; i++) {
    const header = req.headers[`x-docusign-signature-${i}`]
    if (typeof header === 'string' && header) candidates.push(header)
  }
  if (candidates.length === 0) {
    return res.status(401).json({ error: 'Missing DocuSign signature header' })
  }

  const expected = Buffer.from(computed)
  const matched = candidates.some((candidate) => {
    const actual = Buffer.from(candidate.trim())
    // Constant-time comparison to avoid a timing oracle.
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })

  if (!matched) {
    console.warn('[docusign] HMAC mismatch — rejecting')
    return res.status(401).json({ error: 'Invalid signature' })
  }

  let body: any
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
  } catch {
    console.warn('[docusign] Webhook body was not valid JSON')
    return res.status(200).json({ message: 'Unparseable payload — ignored' })
  }

  const supabase: any = adminClient()
  const returnBase = appUrl()

  try {
    // Parse envelope info from various DocuSign Connect formats
    let envelopeId: string | undefined
    let envelopeStatus: string | undefined

    if (typeof body === 'object' && body !== null) {
      envelopeId = body.envelopeId || body.EnvelopeID || body.data?.envelopeId
      envelopeStatus = body.status || body.Status || body.data?.envelopeSummary?.status

      // DocuSign Connect v2 format
      if (!envelopeId && body.data?.envelopeSummary) {
        envelopeId = body.data.envelopeSummary.envelopeId
        envelopeStatus = body.data.envelopeSummary.status
      }

      // Envelope event format
      if (!envelopeId && body.event) {
        envelopeId = body.data?.envelopeId
        envelopeStatus = body.event === 'envelope-completed' ? 'completed'
          : body.event === 'envelope-declined' ? 'declined'
          : body.event === 'envelope-voided' ? 'voided'
          : body.event
      }
    }

    if (!envelopeId) {
      console.warn('[docusign] No envelopeId found in webhook payload')
      return res.status(200).json({ message: 'No envelopeId — ignored' })
    }

    console.log(`[docusign] Webhook: envelope ${envelopeId} status: ${envelopeStatus}`)

    // Look up the timesheet by envelope ID
    const { data: entry, error: eErr } = await supabase
      .from('timesheet_entries')
      .select('*, persons!timesheet_entries_person_id_fkey(full_name, email, user_id)')
      .eq('signature_envelope_id', envelopeId)
      .single()

    if (eErr || !entry) {
      // Try without join in case FK name is wrong
      const { data: entry2 } = await supabase
        .from('timesheet_entries')
        .select('*')
        .eq('signature_envelope_id', envelopeId)
        .single()

      if (!entry2) {
        console.warn(`[docusign] No timesheet found for envelope ${envelopeId}`)
        return res.status(200).json({ message: 'Envelope not found — ignored' })
      }

      return await processEnvelopeUpdate(supabase, entry2, envelopeStatus, returnBase, res)
    }

    return await processEnvelopeUpdate(supabase, entry, envelopeStatus, returnBase, res)
  } catch (err) {
    console.error('[docusign] Webhook error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

async function processEnvelopeUpdate(
  supabase: any,
  entry: any,
  envelopeStatus: string | undefined,
  appUrl: string,
  res: VercelResponse,
) {
  const normalizedStatus = (envelopeStatus || '').toLowerCase()
  const now = new Date().toISOString()

  if (normalizedStatus === 'completed' || normalizedStatus === 'signed') {
    // Signing completed
    await supabase
      .from('timesheet_entries')
      .update({
        status: 'Signed',
        signature_status: 'signed',
        signed_at: now,
        updated_at: now,
      } as any)
      .eq('id', entry.id)

    // Notify admins that a timesheet has been signed
    const { data: admins } = await supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', entry.org_id)
      .in('role', ['Admin', 'Finance Officer'])

    const personName = entry.persons?.full_name || 'A team member'
    const period = `${MONTHS[entry.month - 1]} ${entry.year}`

    // NOTE: a Supabase query builder is a "thenable", not a Promise — it has
    // no .catch(). The previous `.insert(...).catch(() => {})` threw a
    // TypeError here, which bubbled up as a 500 and made DocuSign retry the
    // callback forever while the admin emails were never sent.
    if (admins && admins.length > 0) {
      const rows = admins.map((admin: any) => ({
        user_id: admin.user_id,
        org_id: entry.org_id,
        type: 'timesheet_signed',
        title: 'Timesheet signed',
        message: `${personName} has signed their timesheet for ${period}. Ready for approval.`,
        link: '/timesheets',
      }))
      const { error: notifErr } = await supabase.from('notifications').insert(rows)
      if (notifErr) console.error('[docusign] notification insert failed:', notifErr.message)
    }

    // Send email to admins — best effort, never fails the webhook.
    try {
      const resendKey = process.env.RESEND_API_KEY
      if (resendKey && admins && admins.length > 0) {
        const resend = new Resend(resendKey)
        const from = 'GrantLume <notifications@grantlume.com>'

        const { data: emailRows } = await supabase.rpc('get_user_emails', {
          p_user_ids: admins.map((a: any) => a.user_id),
        })

        for (const row of (emailRows ?? []) as { email: string | null }[]) {
          if (!row.email) continue
          try {
            await resend.emails.send({
              from,
              to: row.email,
              subject: `Timesheet signed: ${escapeHtml(personName)} — ${escapeHtml(period)}`,
              html: `
                <p>Hi,</p>
                <p><strong>${escapeHtml(personName)}</strong> has signed their timesheet for <strong>${escapeHtml(period)}</strong>.</p>
                <p>The timesheet is now ready for your review and approval.</p>
                <p><a href="${appUrl}/timesheets">Review Timesheets</a></p>
                <p style="font-size:12px;color:#6b7280;">GrantLume — Grant &amp; Project Management</p>
              `,
            })
          } catch (mailErr) {
            console.error('[docusign] admin email failed:', mailErr)
          }
        }
      }
    } catch (err) {
      console.error('[docusign] admin email step failed:', err)
    }

    return res.status(200).json({ message: 'Timesheet marked as signed', envelopeId: entry.signature_envelope_id })

  } else if (normalizedStatus === 'declined') {
    // Signer declined
    await supabase
      .from('timesheet_entries')
      .update({
        status: 'Draft',
        signature_status: 'declined',
        signature_url: null,
        updated_at: now,
      } as any)
      .eq('id', entry.id)

    // Notify the person — again, no .catch() on a query builder.
    if (entry.persons?.user_id) {
      const { error: notifErr } = await supabase.from('notifications').insert({
        user_id: entry.persons.user_id,
        org_id: entry.org_id,
        type: 'warning',
        title: 'Signing declined',
        message: `Your timesheet signing for ${MONTHS[entry.month - 1]} ${entry.year} was declined. You can re-submit and try again.`,
        link: '/timesheets',
      })
      if (notifErr) console.error('[docusign] notification insert failed:', notifErr.message)
    }

    return res.status(200).json({ message: 'Timesheet signing declined, reverted to Draft' })

  } else if (normalizedStatus === 'voided') {
    // Envelope voided (admin action)
    await supabase
      .from('timesheet_entries')
      .update({
        status: 'Draft',
        signature_status: 'voided',
        signature_url: null,
        signature_envelope_id: null,
        updated_at: now,
      } as any)
      .eq('id', entry.id)

    return res.status(200).json({ message: 'Timesheet envelope voided, reverted to Draft' })
  }

  // Unknown status — just acknowledge
  return res.status(200).json({ message: `Unhandled status: ${envelopeStatus}` })
}
