import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { cors, authenticateRequest, handleAuthError } from './lib/auth.js'
import { checkRateLimit } from './lib/rateLimit.js'

/**
 * Consolidated AI & search API — replaces parse-grant, parse-collab-grant, parse-import, eu-calls.
 *
 * POST /api/ai?action=parse-grant
 * POST /api/ai?action=parse-collab-grant
 * POST /api/ai?action=parse-import
 * GET  /api/ai?action=eu-calls&q=...&pageSize=20
 */

export const config = {
  maxDuration: 120,
}

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'

// ── AI Quota Limits per plan ──────────────────────────────────────────────
const AI_PLAN_LIMITS: Record<string, { monthly_tokens: number; monthly_requests: number }> = {
  trial:      { monthly_tokens: 200_000,   monthly_requests: 10 },
  starter:    { monthly_tokens: 500_000,   monthly_requests: 30 },
  growth:     { monthly_tokens: 2_000_000, monthly_requests: 100 },
  enterprise: { monthly_tokens: 10_000_000, monthly_requests: 500 },
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

async function checkQuota(
  supabase: any, orgId: string
): Promise<{ allowed: boolean; error?: string; plan?: string; usage?: any; limits?: any }> {
  if (!orgId) return { allowed: false, error: 'org_id is required for AI requests' }

  // Get org plan
  const { data: org } = await supabase
    .from('organisations')
    .select('plan')
    .eq('id', orgId)
    .single()

  const plan = org?.plan || 'trial'
  const limits = AI_PLAN_LIMITS[plan] || AI_PLAN_LIMITS.trial

  // Get current month usage
  const month = currentMonth()
  const { data: usage } = await supabase
    .from('ai_usage')
    .select('tokens_in, tokens_out, request_count')
    .eq('org_id', orgId)
    .eq('month', month)
    .maybeSingle()

  const totalTokens = (usage?.tokens_in || 0) + (usage?.tokens_out || 0)
  const requestCount = usage?.request_count || 0

  if (totalTokens >= limits.monthly_tokens) {
    return { allowed: false, error: `AI token limit reached (${totalTokens.toLocaleString()} / ${limits.monthly_tokens.toLocaleString()} tokens used this month). Upgrade your plan for more.`, plan, usage, limits }
  }
  if (requestCount >= limits.monthly_requests) {
    return { allowed: false, error: `AI request limit reached (${requestCount} / ${limits.monthly_requests} requests this month). Upgrade your plan for more.`, plan, usage, limits }
  }

  return { allowed: true, plan, usage, limits }
}

async function recordUsage(
  supabase: any,
  orgId: string,
  userId: string,
  action: string,
  tokensIn: number,
  tokensOut: number,
) {
  const month = currentMonth()

  // Upsert monthly aggregate
  const { data: existing } = await supabase
    .from('ai_usage')
    .select('id, tokens_in, tokens_out, request_count')
    .eq('org_id', orgId)
    .eq('month', month)
    .maybeSingle()

  if (existing) {
    await supabase.from('ai_usage').update({
      tokens_in: existing.tokens_in + tokensIn,
      tokens_out: existing.tokens_out + tokensOut,
      request_count: existing.request_count + 1,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id)
  } else {
    await supabase.from('ai_usage').insert({
      org_id: orgId,
      month,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      request_count: 1,
    })
  }

  // Insert audit log entry
  await supabase.from('ai_usage_log').insert({
    org_id: orgId,
    user_id: userId,
    action,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()

  const action = (req.query.action as string) || ''

  // Health check — no auth required, useful for diagnostics
  if (action === 'health' && req.method === 'GET') {
    const env = getClaudeAndSupabase()
    return res.status(200).json({
      ok: true,
      hasClaudeKey: !!process.env.CLAUDE_API_KEY,
      hasSupabaseUrl: !!(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL),
      hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hasEnv: !!env,
      timestamp: new Date().toISOString(),
    })
  }

  try {
    // Rate limit: 20 AI requests per 60s per IP
    if (!checkRateLimit(req, res, { limit: 20, windowSeconds: 60, prefix: 'ai' })) return

    // Authenticate all AI requests
    let auth
    try {
      auth = await authenticateRequest(req)
    } catch (err) {
      return handleAuthError(err, res)
    }

    // Bind the request to the AUTHENTICATED identity, unconditionally.
    //
    // The previous version only overwrote org_id `if (auth.orgId)`, so a user
    // with no organisation membership could still supply any org_id they liked
    // and have the server act on it with the service-role key.
    if (req.body && typeof req.body === 'object') {
      req.body.org_id = auth.orgId ?? null
      req.body.user_id = auth.userId

      // `storage_path` was a client-controlled path downloaded with the
      // SERVICE ROLE key, which bypasses storage RLS — i.e. any authenticated
      // user could have the AI read out any file in the grant-uploads bucket,
      // including other companies' grant agreements. Every live caller sends
      // `file_data` (base64) instead, so the parameter is simply refused.
      if (req.body.storage_path) {
        return res.status(400).json({
          error: 'storage_path is no longer accepted — send the file contents as file_data instead',
        })
      }
    }

    switch (action) {
      case 'parse-grant':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
        return await handleParseGrant(req, res)
      case 'parse-collab-grant':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
        return await handleParseCollabGrant(req, res)
      case 'parse-import':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
        return await handleParseImport(req, res)
      case 'eu-calls':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
        return await handleEuCalls(req, res)
      case 'eu-calls-list':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
        return await handleEuCallsList(req, res)
      default:
        return res.status(400).json({ error: `Unknown action: "${action}"` })
    }
  } catch (fatalErr: any) {
    // Global safety net — if any handler throws without catching, return a proper error
    console.error('[GrantLume] AI handler fatal error:', fatalErr)
    if (!res.headersSent) {
      return res.status(500).json({ error: `Unexpected server error: ${fatalErr?.message || 'Unknown'}` })
    }
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────

function getClaudeAndSupabase() {
  const claudeApiKey = process.env.CLAUDE_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!claudeApiKey || !supabaseUrl || !supabaseServiceKey) return null
  return { claudeApiKey, supabase: createClient(supabaseUrl, supabaseServiceKey) }
}

async function buildContentFromFile(arrayBuffer: ArrayBuffer, ext: string, userPromptText: string) {
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp',
    }
    return [
      { type: 'image', source: { type: 'base64', media_type: mimeMap[ext] || 'image/jpeg', data: base64 } },
      { type: 'text', text: userPromptText },
    ]
  }

  if (ext === 'pdf') {
    // Send PDF directly to Claude's native document support — no text extraction needed
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    return [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: userPromptText },
    ]
  }

  // Word, text, etc.
  const textContent = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(arrayBuffer))
  if (!textContent || textContent.trim().length < 10) {
    throw new Error('Could not read file contents. Please try a different format (CSV, Excel, PDF, or image).')
  }
  const maxChars = 100000
  const truncatedText = textContent.length > maxChars
    ? textContent.slice(0, maxChars) + '\n\n[Document truncated]'
    : textContent

  return [{ type: 'text', text: userPromptText + `\n\n--- DOCUMENT TEXT ---\n${truncatedText}\n--- END ---` }]
}

async function callClaude(claudeApiKey: string, systemPrompt: string, messageContent: any[]) {
  // Check if any content block is a PDF document — requires beta header
  const hasPdf = messageContent.some((b: any) => b.type === 'document' && b.source?.media_type === 'application/pdf')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': claudeApiKey,
    'anthropic-version': '2023-06-01',
  }
  if (hasPdf) {
    headers['anthropic-beta'] = 'pdfs-2024-09-25'
  }

  const claudeResponse = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: messageContent }],
    }),
  })

  if (!claudeResponse.ok) {
    const errBody = await claudeResponse.text()
    console.error('[GrantLume] Claude API error:', claudeResponse.status, errBody)
    let details = errBody
    try { details = JSON.parse(errBody)?.error?.message || errBody } catch {}
    throw { status: 502, message: `AI extraction failed (${claudeResponse.status}): ${details}` }
  }

  const claudeData = await claudeResponse.json() as any
  const textBlock = claudeData.content?.find((b: any) => b.type === 'text')
  if (!textBlock?.text) {
    throw { status: 502, message: 'No text response from AI' }
  }

  return {
    text: textBlock.text,
    usage: claudeData.usage,
    tokens_in: claudeData.usage?.input_tokens || 0,
    tokens_out: claudeData.usage?.output_tokens || 0,
  }
}

function parseJsonResponse(rawText: string): any {
  let jsonStr = rawText.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '')
  }
  if (!jsonStr.startsWith('{')) {
    const jsonStart = jsonStr.indexOf('{')
    if (jsonStart >= 0) {
      jsonStr = jsonStr.substring(jsonStart)
      let depth = 0
      let jsonEnd = -1
      for (let i = 0; i < jsonStr.length; i++) {
        if (jsonStr[i] === '{') depth++
        if (jsonStr[i] === '}') depth--
        if (depth === 0) { jsonEnd = i; break }
      }
      if (jsonEnd > 0) jsonStr = jsonStr.substring(0, jsonEnd + 1)
    }
  }
  return JSON.parse(jsonStr)
}

// ════════════════════════════════════════════════════════════════════════════
// parse-grant
// ════════════════════════════════════════════════════════════════════════════

const GRANT_SYSTEM_PROMPT = `You are an expert grant agreement parser. You will receive the extracted text of a grant agreement document. Extract ALL structured information and return it as a single JSON object matching the schema below. Be thorough — extract every work package, deliverable, milestone, and reporting period you can find.

IMPORTANT RULES:
- Dates should be in ISO format (YYYY-MM-DD).
- Month numbers are project-relative (M1 = first month of the project, M2 = second, etc.).
- For "has_wps", set true if the document defines work packages.
- For "is_lead_organisation", set true if the document indicates the uploading organisation is the coordinator/lead.
- Budget fields should be numbers (no currency symbols). Use null if not found.
- "our_pm_rate" is the person-month rate for the organisation. Use null if not stated.
- "wp_number" in deliverables/milestones refers to the work package number it belongs to.
- If you cannot find a value, use null for optional fields or your best estimate for required fields.
- Include a "confidence_notes" string summarising anything you were uncertain about.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):

{
  "project": {
    "acronym": "string",
    "title": "string",
    "grant_number": "string | null",
    "start_date": "YYYY-MM-DD",
    "end_date": "YYYY-MM-DD",
    "total_budget": "number | null",
    "overhead_rate": "number | null",
    "has_wps": "boolean",
    "is_lead_organisation": "boolean",
    "our_pm_rate": "number | null",
    "budget_personnel": "number | null",
    "budget_travel": "number | null",
    "budget_subcontracting": "number | null",
    "budget_other": "number | null"
  },
  "work_packages": [
    {
      "number": "integer",
      "name": "string",
      "description": "string | null",
      "start_month": "integer",
      "end_month": "integer",
      "person_months": "number | null"
    }
  ],
  "deliverables": [
    {
      "number": "string (e.g. D1.1)",
      "title": "string",
      "description": "string | null",
      "wp_number": "integer | null",
      "due_month": "integer"
    }
  ],
  "milestones": [
    {
      "number": "string (e.g. MS1)",
      "title": "string",
      "description": "string | null",
      "wp_number": "integer | null",
      "due_month": "integer",
      "verification_means": "string | null"
    }
  ],
  "reporting_periods": [
    {
      "period_number": "integer",
      "start_month": "integer",
      "end_month": "integer"
    }
  ],
  "confidence_notes": "string"
}`

async function handleParseGrant(req: VercelRequest, res: VercelResponse) {
  try {
    const env = getClaudeAndSupabase()
    if (!env) return res.status(500).json({ error: 'Server credentials not configured' })

    const { file_data, organisation_abbreviation, user_instructions, org_id, user_id } = req.body || {}
    if (!file_data) return res.status(400).json({ error: 'No file_data provided' })

    // Quota check
    if (org_id) {
      const quota = await checkQuota(env.supabase, org_id)
      if (!quota.allowed) return res.status(429).json({ error: quota.error, quota_exceeded: true })
    }

    const buffer = Buffer.from(file_data, 'base64')
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)

    // Send PDF directly to Claude's native document support
    const base64 = Buffer.from(arrayBuffer).toString('base64')

    let userPrompt = `Please parse this grant agreement PDF and extract all project information as the JSON schema described in the system prompt.`
    if (organisation_abbreviation) {
      userPrompt += `\n\nIMPORTANT: Our organisation's abbreviation/name is "${organisation_abbreviation}". When extracting budget figures, PM rates, and personnel costs, focus on the data specific to this organisation (not the total consortium figures). Look for budget tables or annexes that break down costs per beneficiary/partner.`
    }
    if (user_instructions) {
      userPrompt += `\n\nAdditional instructions from the user:\n${user_instructions}`
    }
    userPrompt += '\n\nReturn ONLY the JSON object.'

    const { text, usage, tokens_in, tokens_out } = await callClaude(env.claudeApiKey, GRANT_SYSTEM_PROMPT, [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: userPrompt },
    ])
    const extraction = parseJsonResponse(text)

    // Record usage
    if (org_id) {
      await recordUsage(env.supabase, org_id, user_id || 'unknown', 'parse-grant', tokens_in, tokens_out)
    }

    return res.status(200).json({ extraction, usage })
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('parse-grant error:', err)
    return res.status(500).json({ error: `Server error: ${err.message || 'Unknown error'}` })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// parse-collab-grant
// ════════════════════════════════════════════════════════════════════════════

const COLLAB_SYSTEM_PROMPT = `You are an expert EU grant agreement parser specialised in extracting collaboration project data from grant agreements, annexes, and budget tables. You extract data for a multi-partner collaboration module.

IMPORTANT RULES:
- Dates should be in ISO format (YYYY-MM-DD).
- Month numbers are project-relative (M1 = first month, M2 = second, etc.).
- Budget fields should be numbers (no currency symbols). Use null if not found.
- For country codes, use the official 2-letter ISO 3166-1 alpha-2 codes (DE, FR, IT, ES, etc.).
- For org_type, use official EU participant types: HES (Higher Education), REC (Research Organisation), PRC (Private Company), PUB (Public Body), OTH (Other).
- If you cannot find a value, use null.
- Include a "confidence_notes" string summarising anything uncertain.
- Extract ALL partners, work packages, tasks, deliverables, and milestones you can find.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):

{
  "project": {
    "title": "string",
    "acronym": "string",
    "grant_number": "string | null",
    "funding_programme": "string | null",
    "funding_scheme": "string | null",
    "start_date": "YYYY-MM-DD | null",
    "end_date": "YYYY-MM-DD | null",
    "duration_months": "number | null"
  },
  "partners": [
    {
      "org_name": "string",
      "role": "coordinator | partner",
      "participant_number": "number",
      "country": "string (2-letter ISO code) | null",
      "org_type": "HES | REC | PRC | PUB | OTH | null",
      "contact_name": "string | null",
      "contact_email": "string | null",
      "budget_personnel": "number | null",
      "budget_subcontracting": "number | null",
      "budget_travel": "number | null",
      "budget_equipment": "number | null",
      "budget_other_goods": "number | null",
      "total_person_months": "number | null",
      "funding_rate": "number | null",
      "indirect_cost_rate": "number | null"
    }
  ],
  "work_packages": [
    {
      "wp_number": "number",
      "title": "string",
      "start_month": "number | null",
      "end_month": "number | null",
      "total_person_months": "number | null",
      "leader_participant_number": "number | null",
      "tasks": [
        {
          "task_number": "string (e.g. T1.1)",
          "title": "string",
          "description": "string | null",
          "start_month": "number | null",
          "end_month": "number | null",
          "leader_participant_number": "number | null",
          "person_months": "number | null"
        }
      ]
    }
  ],
  "deliverables": [
    {
      "number": "string (e.g. D1.1)",
      "title": "string",
      "description": "string | null",
      "wp_number": "number | null",
      "due_month": "number",
      "type": "report | data | software | demonstrator | other | null",
      "dissemination": "public | confidential | classified | null",
      "leader_participant_number": "number | null"
    }
  ],
  "milestones": [
    {
      "number": "string (e.g. MS1)",
      "title": "string",
      "description": "string | null",
      "wp_number": "number | null",
      "due_month": "number",
      "verification_means": "string | null"
    }
  ],
  "confidence_notes": "string"
}`

async function handleParseCollabGrant(req: VercelRequest, res: VercelResponse) {
  try {
    const env = getClaudeAndSupabase()
    if (!env) return res.status(500).json({ error: 'Server credentials not configured' })

    const { file_data, file_name, user_instructions, org_id, user_id } = req.body || {}
    if (!file_data) return res.status(400).json({ error: 'No file_data provided' })

    // Quota check
    if (org_id) {
      const quota = await checkQuota(env.supabase, org_id)
      if (!quota.allowed) return res.status(429).json({ error: quota.error, quota_exceeded: true })
    }

    const collabBuffer = Buffer.from(file_data, 'base64')
    const arrayBuffer = collabBuffer.buffer.slice(collabBuffer.byteOffset, collabBuffer.byteOffset + collabBuffer.byteLength)
    const ext = (file_name || '').toLowerCase().split('.').pop() || ''

    let prompt = `Extract collaboration project data from this document (file: "${file_name}").`
    prompt += `\nThis is an EU-funded multi-partner project. Extract ALL project metadata, partners with their budgets, work packages with tasks, deliverables, and milestones.`
    prompt += `\nFor budget tables, look for per-partner breakdowns of: Personnel, Subcontracting, Travel & Subsistence, Equipment, and Other Goods & Services.`
    prompt += `\nReturn a JSON object matching the schema from the system prompt.`
    if (user_instructions) prompt += `\n\nAdditional instructions from the user:\n${user_instructions}`
    prompt += '\n\nReturn ONLY the JSON object.'

    const messageContent = await buildContentFromFile(arrayBuffer, ext, prompt)
    const { text, usage, tokens_in, tokens_out } = await callClaude(env.claudeApiKey, COLLAB_SYSTEM_PROMPT, messageContent)
    const extraction = parseJsonResponse(text)

    // Record usage
    if (org_id) {
      await recordUsage(env.supabase, org_id, user_id || 'unknown', 'parse-collab-grant', tokens_in, tokens_out)
    }

    // Validate
    const hasProject = extraction.project?.title || extraction.project?.acronym
    const hasPartners = Array.isArray(extraction.partners) && extraction.partners.length > 0
    const hasWPs = Array.isArray(extraction.work_packages) && extraction.work_packages.length > 0

    if (!hasProject && !hasPartners && !hasWPs) {
      return res.status(200).json({
        extraction, usage,
        warning: 'AI could not find meaningful project data in this document. Try uploading a grant agreement annex with budget tables, work packages, and partner information.',
      })
    }

    return res.status(200).json({ extraction, usage })
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('[GrantLume] parse-collab-grant error:', err)
    return res.status(500).json({ error: `Server error: ${err.message || 'Unknown error'}` })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// parse-import
// ════════════════════════════════════════════════════════════════════════════

const IMPORT_SYSTEM_PROMPT = `You are an expert data extraction assistant for a grant & project management platform called GrantLume. You will receive a document (text or image) from which you need to extract structured data.

The user will tell you what type of data to extract: "persons" (staff/employees), "projects", or "proposals".

IMPORTANT RULES:
- Return ONLY a valid JSON object with a single key "rows" containing an array of extracted records.
- Dates should be in ISO format (YYYY-MM-DD) where possible.
- For numbers (budgets, FTE, salary), return numeric values without currency symbols.
- If you cannot determine a value, use null.
- Extract ALL records you can find — be thorough.
- Do not invent data. Only extract what is clearly present in the document.
- Include a "confidence" field (0-100) for each row indicating your confidence in the extraction.
- Include an "_notes" field for each row with any relevant observations.

SCHEMAS:

For "persons":
{ "rows": [{ "full_name": "string", "email": "string|null", "department": "string|null", "role": "string|null", "employment_type": "string|null", "fte": "number|null", "start_date": "YYYY-MM-DD|null", "end_date": "YYYY-MM-DD|null", "country": "string|null", "annual_salary": "number|null", "confidence": 85, "_notes": "string" }] }

For "projects":
{ "rows": [{ "acronym": "string", "title": "string", "start_date": "YYYY-MM-DD|null", "end_date": "YYYY-MM-DD|null", "status": "string|null", "grant_number": "string|null", "total_budget": "number|null", "budget_personnel": "number|null", "budget_travel": "number|null", "budget_subcontracting": "number|null", "budget_other": "number|null", "confidence": 85, "_notes": "string" }] }

For "proposals":
{ "rows": [{ "project_name": "string", "call_identifier": "string|null", "funding_scheme": "string|null", "status": "In Preparation|Submitted|Rejected|Granted|null", "submission_deadline": "YYYY-MM-DD|null", "expected_decision": "YYYY-MM-DD|null", "our_pms": "number|null", "personnel_budget": "number|null", "travel_budget": "number|null", "subcontracting_budget": "number|null", "other_budget": "number|null", "notes": "string|null", "confidence": 85, "_notes": "string" }] }

Return ONLY the JSON object. No markdown fences, no explanation.`

async function handleParseImport(req: VercelRequest, res: VercelResponse) {
  console.log('[GrantLume] parse-import: started')
  try {
    const env = getClaudeAndSupabase()
    if (!env) {
      console.error('[GrantLume] parse-import: missing env vars — CLAUDE_API_KEY, SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY not set')
      return res.status(500).json({ error: 'Server credentials not configured. Please check CLAUDE_API_KEY and Supabase environment variables.' })
    }

    const { file_data, file_name, import_type, user_instructions, org_id, user_id } = req.body || {}
    console.log('[GrantLume] parse-import: params', { file_data: !!file_data, file_name, import_type, org_id })
    if (!file_data) return res.status(400).json({ error: 'No file_data provided' })
    if (!import_type || !['persons', 'projects', 'proposals'].includes(import_type)) {
      return res.status(400).json({ error: 'import_type must be one of: persons, projects, proposals' })
    }

    // Quota check
    if (org_id) {
      console.log('[GrantLume] parse-import: checking quota…')
      const quota = await checkQuota(env.supabase, org_id)
      if (!quota.allowed) return res.status(429).json({ error: quota.error, quota_exceeded: true })
    }

    // Direct base64 file data — no storage round-trip, and therefore no
    // client-controlled path handed to a service-role download.
    console.log('[GrantLume] parse-import: decoding base64 file data…')
    const importBuffer = Buffer.from(file_data, 'base64')
    const arrayBuffer = importBuffer.buffer.slice(importBuffer.byteOffset, importBuffer.byteOffset + importBuffer.byteLength)
    const ext = (file_name || '').toLowerCase().split('.').pop() || ''
    console.log('[GrantLume] parse-import: decoded, ext =', ext, 'size =', arrayBuffer.byteLength)

    let prompt = `Extract "${import_type}" data from this document (file: "${file_name}").`
    prompt += `\nReturn a JSON object with a "rows" array matching the "${import_type}" schema from the system prompt.`
    prompt += `\nBe thorough — extract every record you can find.`
    if (user_instructions) prompt += `\n\nAdditional instructions from the user:\n${user_instructions}`
    prompt += '\n\nReturn ONLY the JSON object.'

    console.log('[GrantLume] parse-import: building content from file…')
    const messageContent = await buildContentFromFile(arrayBuffer, ext, prompt)
    console.log('[GrantLume] parse-import: calling Claude API…')
    const { text, usage, tokens_in, tokens_out } = await callClaude(env.claudeApiKey, IMPORT_SYSTEM_PROMPT, messageContent)
    console.log('[GrantLume] parse-import: Claude responded, tokens_in =', tokens_in, 'tokens_out =', tokens_out)
    const extraction = parseJsonResponse(text)
    console.log('[GrantLume] parse-import: parsed extraction, rows =', extraction?.rows?.length ?? 0)

    // Record usage
    if (org_id) {
      await recordUsage(env.supabase, org_id, user_id || 'unknown', 'parse-import', tokens_in, tokens_out).catch((e: any) => {
        console.error('[GrantLume] parse-import: usage recording failed (non-fatal):', e)
      })
    }

    return res.status(200).json({ extraction, usage })
  } catch (err: any) {
    console.error('[GrantLume] parse-import error:', err)
    if (err.status) return res.status(err.status).json({ error: err.message })
    return res.status(500).json({ error: `Server error: ${err?.message || 'Unknown error'}` })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// eu-calls / eu-calls-list — proxy to EC Funding & Tenders (SEDIA) search API
// ════════════════════════════════════════════════════════════════════════════
//
// The F&T portal exposes search via a JSON-over-multipart/form-data endpoint.
// The `topic-list.json` file linked from older integrations has been removed
// (ec.europa.eu → commission.europa.eu migration), so we hit the live search
// API directly. Confirmed request shape:
//
//   POST https://api.tech.ec.europa.eu/search-api/prod/rest/search
//        ?apiKey=SEDIA&text=***&pageSize=N&pageNumber=M
//   Content-Type: multipart/form-data; boundary=...
//        query     (application/json) → Elasticsearch bool filter
//        sort      (application/json) → { field, order }
//        languages (application/json) → ["en"]
//
// See https://github.com/ajruben/sedia-api-fetchers for the canonical shape.

const SEDIA_SEARCH_URL = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search'

// Status codes the SEDIA index uses.
const SEDIA_STATUS = {
  forthcoming: '31094502',
  open: '31094501',
  closed: '31094503',
}

// Type codes: 0 = tenders, 1/2/8 = grants.
const SEDIA_GRANT_TYPES = ['1', '2', '8']

// Known framework-programme IDs → readable labels for UI display.
// Keep in sync with src/lib/euProgrammes.ts on the client side.
const PROGRAMME_LABELS: Record<string, string> = {
  '43108390': 'Horizon Europe',
  '43152860': 'Digital Europe',
  '43353764': 'Erasmus+',
  '43251814': 'Creative Europe',
  '43252405': 'LIFE Programme',
  '44181033': 'European Defence Fund',
  '43251567': 'Connecting Europe Facility (CEF)',
  '43332642': 'EU4Health',
  '43089234': 'Innovation Fund',
  '43298916': 'Euratom Research and Training',
  '43252476': 'Single Market Programme',
  '43251589': 'Citizens, Equality, Rights and Values',
  '43252386': 'Justice Programme',
  '43254019': 'European Social Fund Plus (ESF+)',
  '43392145': 'EMFAF (Maritime, Fisheries & Aquaculture)',
  '43254037': 'European Solidarity Corps',
  '43253706': 'Technical Support Instrument (TSI)',
  '44416173': 'Interregional Innovation Investments (I3)',
  '44773066': 'Just Transition Mechanism',
  '43251530': 'Border Management and Visa Policy (BMVI)',
  '43252368': 'Internal Security Fund (ISF)',
  '43251447': 'Asylum, Migration and Integration Fund (AMIF)',
  '43253979': 'Customs Programme',
  '43253995': 'Fiscalis Programme',
  '43298203': 'Union Civil Protection Mechanism',
  '43298664': 'Promotion of Agricultural Products',
  '43251842': 'Union Anti-Fraud Programme',
  // Legacy / closed programmes
  '31045243': 'Horizon 2020 (legacy 2014–2020)',
  '31059643': 'COSME (legacy 2014–2020)',
  '31076817': 'Rights, Equality and Citizenship (REC, legacy)',
  '31059093': 'Erasmus+ (legacy 2014–2020)',
  '31107710': 'LIFE (legacy 2014–2020)',
}

function programmeLabel(id: string | null | undefined): string {
  if (!id) return ''
  return PROGRAMME_LABELS[id] ?? ''
}

/** Translate a SEDIA status code to a human-readable label. */
function statusLabel(code: string | null | undefined): string {
  switch (code) {
    case SEDIA_STATUS.open: return 'Open'
    case SEDIA_STATUS.forthcoming: return 'Forthcoming'
    case SEDIA_STATUS.closed: return 'Closed'
    default: return ''
  }
}

/** The earliest future deadline in an array of ISO datetimes, or the first. */
function pickDeadline(list: unknown): string | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined
  const now = Date.now()
  const parsed = list
    .map(v => (typeof v === 'string' ? { s: v, t: Date.parse(v) } : null))
    .filter((x): x is { s: string; t: number } => !!x && !isNaN(x.t))
  if (parsed.length === 0) return undefined
  const future = parsed.filter(p => p.t >= now).sort((a, b) => a.t - b.t)
  const picked = future[0] ?? parsed.sort((a, b) => b.t - a.t)[0]
  return picked.s.slice(0, 10)
}

/**
 * Post a search to the SEDIA API. Query/sort/languages are sent as JSON blobs
 * in a multipart/form-data body (the SEDIA endpoint insists on this shape).
 */
async function sediaSearch(params: {
  query: Record<string, any>
  sort: Record<string, any>
  text?: string
  pageSize: number
  pageNumber: number
}): Promise<any> {
  const url = new URL(SEDIA_SEARCH_URL)
  url.searchParams.set('apiKey', 'SEDIA')
  url.searchParams.set('text', params.text ?? '***')
  url.searchParams.set('pageSize', String(params.pageSize))
  url.searchParams.set('pageNumber', String(params.pageNumber))

  const form = new FormData()
  form.append(
    'query',
    new Blob([JSON.stringify(params.query)], { type: 'application/json' }),
  )
  form.append(
    'sort',
    new Blob([JSON.stringify(params.sort)], { type: 'application/json' }),
  )
  form.append(
    'languages',
    new Blob([JSON.stringify(['en'])], { type: 'application/json' }),
  )

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'User-Agent': 'GrantLume/1.0', Accept: 'application/json' },
    body: form,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`SEDIA API returned ${res.status}: ${body.slice(0, 200)}`)
  }
  return await res.json()
}

/** Normalise a SEDIA result row into the shape the client expects. */
function shapeTopic(r: any) {
  const m = r.metadata ?? {}
  const firstOf = (v: any) => (Array.isArray(v) ? v[0] ?? '' : v ?? '')
  const identifier = firstOf(m.identifier) || r.reference || ''
  const frameworkId = firstOf(m.frameworkProgramme)
  return {
    identifier,
    title: firstOf(m.title) || r.summary || '',
    callIdentifier: firstOf(m.callIdentifier),
    callTitle: firstOf(m.callTitle),
    programme: programmeLabel(frameworkId) || frameworkId,
    programmeId: frameworkId,
    programmePeriod: firstOf(m.programmePeriod),
    typeOfAction: Array.isArray(m.typesOfAction)
      ? m.typesOfAction.join(', ')
      : firstOf(m.typesOfAction),
    status: firstOf(m.status),
    statusLabel: statusLabel(firstOf(m.status)),
    openingDate: firstOf(m.startDate)?.slice?.(0, 10) || undefined,
    deadlineDate: pickDeadline(m.deadlineDate),
    deadlineModel: firstOf(m.deadlineModel),
    summary: r.summary || '',
    keywords: Array.isArray(m.keywords) ? m.keywords.slice(0, 20) : [],
    url: identifier
      ? `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${identifier}`
      : undefined,
  }
}

// ── Simple in-memory cache so filter changes don't hit SEDIA every time ───
const sediaResponseCache = new Map<string, { fetchedAt: number; data: any }>()
const SEDIA_CACHE_TTL_MS = 10 * 60 * 1000  // 10 minutes

async function cachedSediaSearch(params: Parameters<typeof sediaSearch>[0]) {
  const key = JSON.stringify(params)
  const hit = sediaResponseCache.get(key)
  const now = Date.now()
  if (hit && now - hit.fetchedAt < SEDIA_CACHE_TTL_MS) return hit.data
  const data = await sediaSearch(params)
  sediaResponseCache.set(key, { fetchedAt: now, data })
  // Bound cache size.
  if (sediaResponseCache.size > 200) {
    const firstKey = sediaResponseCache.keys().next().value
    if (firstKey !== undefined) sediaResponseCache.delete(firstKey)
  }
  return data
}

/**
 * eu-calls — lightweight keyword lookup used by the Proposals combo-box.
 * Returns up to `pageSize` topic-level matches for the given query string.
 */
async function handleEuCalls(req: VercelRequest, res: VercelResponse) {
  const query = ((req.query.q as string) ?? '').trim()
  const pageSize = Math.min(parseInt((req.query.pageSize as string) ?? '15', 10) || 15, 50)

  if (query.length < 2) {
    return res.status(200).json({ topics: [] })
  }

  try {
    const data = await cachedSediaSearch({
      query: {
        bool: {
          must: [
            { terms: { type: SEDIA_GRANT_TYPES } },
          ],
        },
      },
      sort: { field: 'sortStatus', order: 'ASC' },
      text: query,
      pageSize,
      pageNumber: 1,
    })

    const topics = ((data.results ?? []) as any[])
      .map(shapeTopic)
      .filter(t => t.identifier)

    return res.status(200).json({ topics, source: 'sedia' })
  } catch (err: any) {
    console.error('[eu-calls] search failed:', err?.message)
    return res.status(502).json({ error: `EU search failed: ${err?.message ?? 'unknown'}` })
  }
}

/**
 * eu-calls-list — paginated browse for the Calls module. Accepts q, programme,
 * status, pageNumber, pageSize. `status` defaults to open + forthcoming.
 */
async function handleEuCallsList(req: VercelRequest, res: VercelResponse) {
  const q = ((req.query.q as string) ?? '').trim()
  const programmeRaw = ((req.query.programme as string) ?? '').trim()
  const statusFilter = ((req.query.status as string) ?? '').trim().toLowerCase()
  const pageSize = Math.min(parseInt((req.query.pageSize as string) ?? '50', 10) || 50, 100)
  const pageNumber = Math.max(parseInt((req.query.pageNumber as string) ?? '1', 10) || 1, 1)

  // Translate readable filters into SEDIA codes.
  let statusCodes: string[] = [SEDIA_STATUS.open, SEDIA_STATUS.forthcoming]
  if (statusFilter === 'open') statusCodes = [SEDIA_STATUS.open]
  else if (statusFilter === 'forthcoming') statusCodes = [SEDIA_STATUS.forthcoming]
  else if (statusFilter === 'closed') statusCodes = [SEDIA_STATUS.closed]
  else if (statusFilter === 'any' || statusFilter === 'all') {
    statusCodes = [SEDIA_STATUS.open, SEDIA_STATUS.forthcoming, SEDIA_STATUS.closed]
  }

  // Resolve programme filter — accept either an ID or a known short/long name.
  let programmeIds: string[] | null = null
  if (programmeRaw) {
    const lower = programmeRaw.toLowerCase()
    // First try exact ID
    if (/^\d+$/.test(programmeRaw)) {
      programmeIds = [programmeRaw]
    } else {
      // Match known labels (partial, case-insensitive)
      const hits = Object.entries(PROGRAMME_LABELS)
        .filter(([, label]) => label.toLowerCase().includes(lower))
        .map(([id]) => id)
      if (hits.length > 0) programmeIds = hits
      // Otherwise leave as null and pass the string as a text filter below.
    }
  }

  const must: any[] = [
    { terms: { type: SEDIA_GRANT_TYPES } },
    { terms: { status: statusCodes } },
  ]
  if (programmeIds && programmeIds.length > 0) {
    must.push({ terms: { frameworkProgramme: programmeIds } })
  }

  // Use `text` for free-text keyword search; fall back to wildcard.
  const text = q || (programmeIds ? '***' : (programmeRaw || '***'))

  try {
    const data = await cachedSediaSearch({
      query: { bool: { must } },
      sort: statusFilter === 'closed'
        ? { field: 'deadlineDate', order: 'DESC' }
        : { field: 'sortStatus', order: 'ASC' },
      text,
      pageSize,
      pageNumber,
    })

    const topics = ((data.results ?? []) as any[])
      .map(shapeTopic)
      .filter(t => t.identifier)

    return res.status(200).json({
      topics,
      total: data.totalResults ?? topics.length,
      pageSize,
      pageNumber,
      source: 'sedia',
    })
  } catch (err: any) {
    console.error('[eu-calls-list] search failed:', err?.message)
    return res.status(502).json({
      error: `Failed to load F&T topic list: ${err?.message ?? 'unknown'}`,
    })
  }
}
