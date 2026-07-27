import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import * as XLSX from 'xlsx'
import { apiFetch } from '@/lib/apiClient'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/use-toast'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import {
  Upload, FileSpreadsheet, FileText, Image, Sparkles,
  ArrowRight, ArrowLeft, Check, AlertTriangle, Loader2, X, Lightbulb, Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AiQuotaWidget } from '@/components/ai/AiQuotaWidget'

// ─── Types ───────────────────────────────────────────────────

export type ImportType = 'persons' | 'projects' | 'proposals'
type Step = 'upload' | 'processing' | 'map' | 'preview'
type FileCategory = 'spreadsheet' | 'document'

interface ColumnDef {
  field: string
  label: string
  type?: 'string' | 'number' | 'date'
  required: boolean
  aliases: string[]
}

interface ImportConfig {
  label: string
  description: string
  templateHint: string
  columns: ColumnDef[]
  table: string
}

// ─── Import target configs ───────────────────────────────────

const IMPORT_CONFIGS: Record<ImportType, ImportConfig> = {
  persons: {
    label: 'Staff',
    description: 'Import team members from a spreadsheet.',
    templateHint: 'At minimum, include a "Full Name" column. Email, department, role, FTE, and dates are optional but recommended.',
    columns: [
      { field: 'full_name', label: 'Full Name', required: true, aliases: ['name', 'full name', 'fullname', 'person', 'staff name', 'employee', 'employee name', 'researcher', 'member'] },
      { field: 'email', label: 'Email', required: false, aliases: ['email', 'e-mail', 'mail', 'email address', 'contact'] },
      { field: 'department', label: 'Department', required: false, aliases: ['department', 'dept', 'unit', 'division', 'group', 'team', 'lab', 'laboratory'] },
      { field: 'role', label: 'Role', required: false, aliases: ['role', 'position', 'title', 'job title', 'job role', 'function', 'designation'] },
      { field: 'employment_type', label: 'Employment Type', required: false, aliases: ['employment type', 'employment_type', 'contract', 'contract type'] },
      { field: 'fte', label: 'FTE', required: false, type: 'number', aliases: ['fte', 'full time equivalent', 'working time', 'percentage', 'effort'] },
      { field: 'start_date', label: 'Start Date', required: false, type: 'date', aliases: ['start date', 'start_date', 'startdate', 'hire date', 'from', 'joined', 'joining date'] },
      { field: 'end_date', label: 'End Date', required: false, type: 'date', aliases: ['end date', 'end_date', 'enddate', 'leave date', 'to', 'until', 'departure'] },
      { field: 'country', label: 'Country', required: false, aliases: ['country', 'country code', 'nation', 'location', 'nationality'] },
      { field: 'annual_salary', label: 'Annual Salary', required: false, type: 'number', aliases: ['salary', 'annual salary', 'annual_salary', 'pay', 'compensation', 'wage'] },
    ],
    table: 'persons',
  },
  projects: {
    label: 'Projects',
    description: 'Import research projects from a spreadsheet.',
    templateHint: 'Required: Acronym, Title, Start Date, End Date. Optional: grant number, budgets, status.',
    columns: [
      { field: 'acronym', label: 'Acronym', required: true, aliases: ['acronym', 'code', 'project code', 'short name', 'project id', 'project acronym', 'id', 'ref', 'reference', 'abbreviation'] },
      { field: 'title', label: 'Title', required: true, aliases: ['title', 'name', 'project name', 'project title', 'full title', 'project'] },
      { field: 'start_date', label: 'Start Date', required: true, type: 'date', aliases: ['start date', 'start_date', 'startdate', 'start', 'from', 'begin', 'begin date', 'beginning', 'kick-off'] },
      { field: 'end_date', label: 'End Date', required: true, type: 'date', aliases: ['end date', 'end_date', 'enddate', 'end', 'to', 'until', 'finish', 'finish date', 'due date', 'completion'] },
      { field: 'status', label: 'Status', required: false, aliases: ['status', 'state', 'project status', 'phase', 'stage'] },
      { field: 'grant_number', label: 'Grant Number', required: false, aliases: ['grant number', 'grant_number', 'grant', 'grant id', 'grant no', 'contract number', 'agreement number', 'ga number', 'project number'] },
      { field: 'total_budget', label: 'Total Budget', required: false, type: 'number', aliases: ['total budget', 'total_budget', 'budget', 'total cost', 'grant amount', 'funding', 'amount', 'value'] },
      { field: 'budget_personnel', label: 'Personnel Budget', required: false, type: 'number', aliases: ['budget personnel', 'budget_personnel', 'personnel budget', 'personnel cost', 'staff cost', 'personnel', 'labor', 'labour'] },
      { field: 'budget_travel', label: 'Travel Budget', required: false, type: 'number', aliases: ['budget travel', 'budget_travel', 'travel budget', 'travel cost', 'travel', 'mobility'] },
      { field: 'budget_subcontracting', label: 'Subcontracting Budget', required: false, type: 'number', aliases: ['budget subcontracting', 'budget_subcontracting', 'subcontracting', 'subcontracting budget', 'outsourcing'] },
      { field: 'budget_other', label: 'Other Budget', required: false, type: 'number', aliases: ['budget other', 'budget_other', 'other budget', 'other cost', 'other', 'indirect', 'overhead'] },
    ],
    table: 'projects',
  },
  proposals: {
    label: 'Proposals',
    description: 'Import grant proposals from a spreadsheet.',
    templateHint: 'Required: Title. Optional: call ID, programme, status, submission deadline, budgets, person-months, notes.',
    columns: [
      { field: 'project_name', label: 'Title', required: true, aliases: ['title', 'name', 'proposal title', 'proposal name', 'project title', 'project name', 'project_name'] },
      { field: 'call_identifier', label: 'Call ID', required: false, aliases: ['call', 'call identifier', 'call_identifier', 'call id', 'call reference', 'topic id', 'topic'] },
      { field: 'funding_scheme', label: 'Programme', required: false, aliases: ['programme', 'program', 'funding programme', 'funding_programme', 'scheme', 'funding scheme', 'funding_scheme', 'framework'] },
      { field: 'status', label: 'Status', required: false, aliases: ['status', 'state', 'stage', 'outcome', 'result', 'decision'] },
      { field: 'submission_deadline', label: 'Submission Deadline', required: false, type: 'date', aliases: ['submission deadline', 'submission_deadline', 'deadline', 'submission date', 'submitted', 'due date'] },
      { field: 'expected_decision', label: 'Expected Decision', required: false, type: 'date', aliases: ['expected decision', 'expected_decision', 'decision date', 'result date', 'notification date'] },
      { field: 'our_pms', label: 'Our Person-Months', required: false, type: 'number', aliases: ['our pms', 'our_pms', 'person months', 'person-months', 'pm', 'pms', 'effort', 'our effort'] },
      { field: 'personnel_budget', label: 'Personnel Budget', required: false, type: 'number', aliases: ['personnel budget', 'personnel_budget', 'personnel cost', 'staff cost', 'personnel', 'labor', 'labour'] },
      { field: 'travel_budget', label: 'Travel Budget', required: false, type: 'number', aliases: ['travel budget', 'travel_budget', 'travel cost', 'travel', 'mobility'] },
      { field: 'subcontracting_budget', label: 'Subcontracting Budget', required: false, type: 'number', aliases: ['subcontracting budget', 'subcontracting_budget', 'subcontracting', 'outsourcing'] },
      { field: 'other_budget', label: 'Other Budget', required: false, type: 'number', aliases: ['other budget', 'other_budget', 'other cost', 'other', 'indirect'] },
      { field: 'notes', label: 'Notes', required: false, aliases: ['notes', 'note', 'comments', 'comment', 'remarks', 'description'] },
    ],
    table: 'proposals',
  },
}

// ─── File type utilities ─────────────────────────────────────

const SPREADSHEET_EXTS = ['csv', 'xlsx', 'xls', 'tsv']
const DOCUMENT_EXTS = ['pdf', 'doc', 'docx', 'txt', 'rtf']
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp']
const ALL_ACCEPT = '.csv,.xlsx,.xls,.tsv,.pdf,.doc,.docx,.txt,.rtf,.jpg,.jpeg,.png,.gif,.webp'
const SPREADSHEET_ACCEPT = '.csv,.xlsx,.xls,.tsv'

const FILE_LIMITS = {
  spreadsheet: { maxSizeMB: 10 },
  document: { maxSizeMB: 10 },
  image: { maxSizeMB: 5 },
}

function getFileExt(name: string): string {
  return name.toLowerCase().split('.').pop() || ''
}

function getFileCategory(name: string): FileCategory {
  const ext = getFileExt(name)
  if (SPREADSHEET_EXTS.includes(ext)) return 'spreadsheet'
  return 'document'
}

function getFileSizeLimitMB(name: string): number {
  const ext = getFileExt(name)
  if (IMAGE_EXTS.includes(ext)) return FILE_LIMITS.image.maxSizeMB
  if (SPREADSHEET_EXTS.includes(ext)) return FILE_LIMITS.spreadsheet.maxSizeMB
  return FILE_LIMITS.document.maxSizeMB
}

function validateFile(file: File): string | null {
  const ext = getFileExt(file.name)
  const allExts = [...SPREADSHEET_EXTS, ...DOCUMENT_EXTS, ...IMAGE_EXTS]
  if (!allExts.includes(ext)) {
    return `Unsupported file type (.${ext}). Supported: ${allExts.map((e) => `.${e}`).join(', ')}`
  }
  const limitMB = getFileSizeLimitMB(file.name)
  if (file.size > limitMB * 1024 * 1024) {
    return `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum: ${limitMB} MB.`
  }
  return null
}

// ─── Fuzzy column matching ───────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[_\-./]/g, ' ').replace(/\s+/g, ' ').trim()
}

function matchScore(header: string, alias: string): number {
  const h = normalize(header)
  const a = alias
  if (h === a) return 100
  if (h.startsWith(a) || a.startsWith(h)) return 80
  if (h.includes(a) || a.includes(h)) return 60
  const hWords = new Set(h.split(' '))
  const aWords = a.split(' ')
  const overlap = aWords.filter((w) => hWords.has(w)).length
  if (overlap > 0) return 30 + (overlap / aWords.length) * 30
  return 0
}

function autoMap(csvHeaders: string[], columns: ColumnDef[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  const usedHeaders = new Set<string>()
  for (const col of columns) {
    let bestHeader = ''
    let bestScore = 0
    for (const csvH of csvHeaders) {
      if (usedHeaders.has(csvH)) continue
      const fieldScore = matchScore(csvH, normalize(col.field))
      if (fieldScore > bestScore) { bestScore = fieldScore; bestHeader = csvH }
      for (const alias of col.aliases) {
        const s = matchScore(csvH, alias)
        if (s > bestScore) { bestScore = s; bestHeader = csvH }
      }
    }
    // Keep this threshold in sync with src/features/import/BulkImport.tsx.
    // 30 was too permissive and caused silent misbindings (e.g. "Amount"
    // auto-mapping to "annual_salary").
    if (bestScore >= 60 && bestHeader) {
      mapping[col.field] = bestHeader
      usedHeaders.add(bestHeader)
    }
  }
  return mapping
}

// ─── Component ───────────────────────────────────────────────

interface ParsedData {
  headers: string[]
  rows: Record<string, unknown>[]
  source: 'spreadsheet' | 'ai'
}

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  importType: ImportType
  /** When true, dialog opens in AI-focused mode (only accepts documents/images) */
  aiMode?: boolean
  /** Called after successful import so the parent can refresh data */
  onImportComplete?: () => void
}

const AI_ONLY_ACCEPT = '.pdf,.doc,.docx,.txt,.rtf,.jpg,.jpeg,.png,.gif,.webp'

export function ImportDialog({ open, onOpenChange, importType, aiMode, onImportComplete }: ImportDialogProps) {
  const { t } = useTranslation()
  const { orgId, aiEnabled } = useAuthStore()
  const config = IMPORT_CONFIGS[importType]
  const effectiveAiMode = aiMode && aiEnabled
  const fileAccept = effectiveAiMode ? AI_ONLY_ACCEPT : aiEnabled ? ALL_ACCEPT : SPREADSHEET_ACCEPT

  // Wizard state
  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [userHint, setUserHint] = useState('')

  // Parsing / AI state
  const [quotaExhausted, setQuotaExhausted] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [processingMessage, setProcessingMessage] = useState('')
  const [parsed, setParsed] = useState<ParsedData | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)

  // Reset on close
  useEffect(() => {
    if (!open) {
      // Small delay so the dialog animation finishes before resetting
      const t = setTimeout(() => {
        setStep('upload')
        setFile(null)
        setFileError(null)
        setParsed(null)
        setMapping({})
        setImporting(false)
        setProcessing(false)
        setUserHint('')
        setQuotaExhausted(false)
      }, 200)
      return () => clearTimeout(t)
    }
  }, [open])

  // ─── File handling ──────────────────────────────

  const handleFileSelect = useCallback((f: File) => {
    if (!aiEnabled && getFileCategory(f.name) === 'document') {
      setFileError('AI is disabled for your organisation. Only spreadsheet files (CSV, Excel) are supported.')
      setFile(null)
      return
    }
    const error = validateFile(f)
    if (error) {
      setFileError(error)
      setFile(null)
      return
    }
    setFileError(null)
    setFile(f)
  }, [aiEnabled])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFileSelect(f)
  }, [handleFileSelect])

  // ─── Process file ───────────────────────────────

  const handleProcess = async () => {
    if (!file) return
    const category = getFileCategory(file.name)

    if (category === 'spreadsheet') {
      setStep('processing')
      setProcessing(true)
      setProcessingMessage('Reading spreadsheet…')
      try {
        const data = await file.arrayBuffer()
        const workbook = XLSX.read(new Uint8Array(data), { type: 'array' })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)

        if (jsonRows.length === 0) {
          toast({ title: 'Empty file', description: 'The uploaded file has no data rows.', variant: 'destructive' })
          setStep('upload')
          setProcessing(false)
          return
        }

        const headers = Object.keys(jsonRows[0])
        const autoMapping = autoMap(headers, config.columns)

        setParsed({ headers, rows: jsonRows, source: 'spreadsheet' })
        setMapping(autoMapping)
        setStep('map')
      } catch {
        toast({ title: 'Parse error', description: "Could not read the file. Make sure it's a valid CSV or Excel file.", variant: 'destructive' })
        setStep('upload')
      } finally {
        setProcessing(false)
      }
    } else {
      // AI extraction — send file as base64 directly to API (no storage upload)
      setStep('processing')
      setProcessing(true)
      setProcessingMessage('Preparing file…')
      try {
        console.log('[AI Import] Step 1: Reading file as base64…', { name: file.name, size: file.size, type: file.type })
        const arrayBuffer = await file.arrayBuffer()
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        )
        console.log('[AI Import] Step 1 done: base64 length =', base64.length)

        // Check file size — Vercel has ~4.5MB body limit
        if (base64.length > 4_000_000) {
          throw new Error('File is too large for AI processing (max ~3MB). Please use a smaller file or convert to a spreadsheet.')
        }

        setProcessingMessage('AI is reading your document…')
        console.log('[AI Import] Step 2: Calling AI parse-import API…')
        const abortCtrl = new AbortController()
        const timeout = setTimeout(() => abortCtrl.abort(), 120_000) // 120s timeout
        const reqBody = {
          file_data: base64,
          file_name: file.name,
          import_type: importType,
          user_instructions: userHint.trim() || undefined,
          org_id: useAuthStore.getState().orgId || '',
          user_id: useAuthStore.getState().user?.id || '',
        }
        let response: Response
        try {
          response = await apiFetch('/api/ai?action=parse-import', {
            method: 'POST',
            signal: abortCtrl.signal,
            body: JSON.stringify(reqBody),
          })
        } catch (fetchErr: any) {
          console.error('[AI Import] Fetch error:', fetchErr)
          if (fetchErr?.name === 'AbortError') throw new Error('AI extraction timed out (120s). Please try a smaller document or use a spreadsheet instead.')
          throw fetchErr
        } finally {
          clearTimeout(timeout)
        }

        console.log('[AI Import] Step 2 done: API responded with status', response.status)

        if (!response.ok) {
          const errText = await response.text()
          console.error('[AI Import] API error response:', response.status, errText)
          let errMsg = `AI extraction failed (${response.status})`
          try {
            const errData = JSON.parse(errText)
            errMsg = errData.error || errMsg
          } catch { /* not JSON */ }
          throw new Error(errMsg)
        }

        setProcessingMessage('Processing results…')
        console.log('[AI Import] Step 3: Parsing response JSON…')
        const data = await response.json()
        console.log('[AI Import] Step 3 done: Got data', { rowCount: data.extraction?.rows?.length ?? 0, keys: Object.keys(data) })
        const rows: Record<string, unknown>[] = data.extraction?.rows ?? []

        if (rows.length === 0) {
          console.warn('[AI Import] No rows extracted from document')
          toast({ title: 'No data found', description: 'AI could not extract any records from this document. Try a different file or add hints.', variant: 'destructive' })
          setStep('upload')
          setProcessing(false)
          return
        }

        const allKeys = new Set<string>()
        for (const row of rows) {
          for (const key of Object.keys(row)) allKeys.add(key)
        }
        const internalFields = ['confidence', '_notes']
        const headers = [...allKeys].filter((k) => !internalFields.includes(k))
        const autoMapping = autoMap(headers, config.columns)

        console.log('[AI Import] Step 4: Mapped columns', { headers, autoMapping, rowCount: rows.length })
        setParsed({ headers, rows, source: 'ai' })
        setMapping(autoMapping)
        setStep('map')

        const avgConfidence = rows.reduce((sum, r) => sum + (Number(r.confidence) || 0), 0) / rows.length
        if (avgConfidence < 70) {
          toast({ title: 'Low confidence', description: 'AI extraction confidence is below 70%. Please review the data carefully.', variant: 'default' })
        }
      } catch (err) {
        console.error('[AI Import] Error:', err)
        const message = err instanceof Error ? err.message : 'Failed to process file'
        toast({ title: 'Error', description: message, variant: 'destructive' })
        setStep('upload')
      } finally {
        setProcessing(false)
      }
    }
  }

  // ─── Mapping ────────────────────────────────────

  const handleMappingChange = (targetField: string, csvHeader: string) => {
    setMapping((prev) => {
      const next = { ...prev }
      if (csvHeader === '') {
        delete next[targetField]
      } else {
        next[targetField] = csvHeader
      }
      return next
    })
  }

  const requiredColumns = config.columns.filter((c) => c.required)
  const allMappedRequired = requiredColumns.every((c) => mapping[c.field])

  const getMappedRows = () => {
    if (!parsed) return []
    const colTypeMap: Record<string, string> = {}
    config.columns.forEach((c) => { if (c.type) colTypeMap[c.field] = c.type })

    return parsed.rows.map((row) => {
      const mapped: Record<string, unknown> = { org_id: orgId }
      for (const [targetField, csvHeader] of Object.entries(mapping)) {
        if (!csvHeader) continue
        const rawVal = row[csvHeader]
        if (rawVal === undefined || rawVal === '' || rawVal === null) continue
        let val: unknown = rawVal

        const colType = colTypeMap[targetField]
        if (colType === 'number') {
          const cleaned = String(val).replace(/[^\d.\-]/g, '')
          const num = parseFloat(cleaned)
          if (isNaN(num)) continue
          val = num
        } else if (colType === 'date') {
          const d = new Date(String(val))
          if (isNaN(d.getTime())) continue
          val = d.toISOString().split('T')[0]
        }

        mapped[targetField] = val
      }
      return mapped
    })
  }

  const handleConfirmMapping = () => {
    if (!allMappedRequired) {
      toast({
        title: 'Missing required mappings',
        description: `Please map all required fields: ${requiredColumns.filter((c) => !mapping[c.field]).map((c) => c.label).join(', ')}`,
        variant: 'destructive',
      })
      return
    }
    setStep('preview')
  }

  // ─── Import ─────────────────────────────────────

  const handleImport = async () => {
    if (!parsed || !orgId) return
    setImporting(true)
    try {
      const rows = getMappedRows()

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      let accessToken = supabaseAnonKey
      try {
        const storageKey = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'))
        if (storageKey) {
          const stored = JSON.parse(localStorage.getItem(storageKey) || '{}')
          if (stored?.access_token) accessToken = stored.access_token
        }
      } catch { /* use anon key */ }

      const endpoint = `${supabaseUrl}/rest/v1/${config.table}`
      const headers = {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${accessToken}`,
        'Prefer': 'return=minimal',
      }

      // Insert rows individually in parallel to avoid PostgREST "all keys must match" error
      // Each row may have different optional fields; individual inserts let DB defaults apply
      const results = await Promise.allSettled(
        rows.map((row) =>
          fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(row) })
            .then(async (res) => {
              if (!res.ok) {
                const body = await res.text().catch(() => '')
                throw new Error(body)
              }
            })
        )
      )

      const succeeded = results.filter((r) => r.status === 'fulfilled').length
      const failed = results.filter((r) => r.status === 'rejected')
      console.log(`[Import] Done: ${succeeded} succeeded, ${failed.length} failed`)
      if (failed.length > 0) {
        console.error('[Import] Failed rows:', failed.slice(0, 3).map((r) => (r as PromiseRejectedResult).reason?.message))
      }

      if (succeeded === 0) {
        const firstErr = (failed[0] as PromiseRejectedResult)?.reason?.message || 'All inserts failed'
        let errMsg = firstErr
        try { errMsg = JSON.parse(firstErr)?.message || firstErr } catch {}
        throw new Error(errMsg)
      }

      const desc = failed.length > 0
        ? `${succeeded} imported, ${failed.length} failed (check data for errors).`
        : `${succeeded} ${config.label.toLowerCase()} imported successfully.`
      toast({ title: t('import.importComplete'), description: desc })
      onImportComplete?.()
      onOpenChange(false)
    } catch (err: any) {
      console.error('[Import] Insert error:', err)
      const message = err?.message || err?.details || err?.hint || 'Import failed'
      toast({ title: t('import.importFailed'), description: message, variant: 'destructive' })
    } finally {
      setImporting(false)
    }
  }

  const downloadTemplate = () => {
    const headers = config.columns.map((c) => c.label)
    const ws = XLSX.utils.aoa_to_sheet([headers])
    // Set column widths
    ws['!cols'] = headers.map(() => ({ wch: 18 }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, config.label)
    XLSX.writeFile(wb, `${importType}_import_template.xlsx`)
  }

  // ─── Step indicators ───────────────────────────

  const STEPS: { key: Step; label: string }[] = [
    { key: 'upload', label: t('import.stepUpload') },
    { key: 'processing', label: t('import.stepProcess') },
    { key: 'map', label: t('import.stepMap') },
    { key: 'preview', label: t('import.stepImport') },
  ]
  const currentStepIdx = STEPS.findIndex((s) => s.key === step)

  const StepIndicator = () => (
    <div className="flex items-center gap-1 mb-4">
      {STEPS.map((s, i) => (
        <div key={s.key} className="flex items-center">
          <div className={cn(
            'flex items-center justify-center h-6 w-6 rounded-full text-[10px] font-semibold transition-colors',
            i < currentStepIdx ? 'bg-primary text-primary-foreground' :
            i === currentStepIdx ? 'bg-primary text-primary-foreground ring-2 ring-primary/30' :
            'bg-muted text-muted-foreground',
          )}>
            {i < currentStepIdx ? <Check className="h-3 w-3" /> : i + 1}
          </div>
          <span className={cn(
            'text-[11px] ml-1 hidden sm:inline',
            i === currentStepIdx ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}>{s.label}</span>
          {i < STEPS.length - 1 && <div className="w-4 sm:w-8 h-px bg-border mx-1" />}
        </div>
      ))}
    </div>
  )

  const fileCategory = file ? getFileCategory(file.name) : null
  const isAIFile = fileCategory === 'document'

  // ─── Render ────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!processing && !importing) onOpenChange(v) }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {effectiveAiMode ? <Sparkles className="h-4 w-4 text-amber-500" /> : <Upload className="h-4 w-4" />}
            {effectiveAiMode ? t('import.importWithAITitle', { type: config.label }) : t('import.importTitle', { type: config.label })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {effectiveAiMode ? 'Upload a document for AI-assisted import' : 'Upload a file to import data'}
          </DialogDescription>
        </DialogHeader>

        <StepIndicator />

        {/* ═══════════════════ STEP 1: Upload ═══════════════════ */}
        {step === 'upload' && (
          <div className="space-y-4">
            {/* Hint */}
            <div className={cn(
              'flex items-start gap-2 rounded-lg border p-3',
              effectiveAiMode ? 'bg-purple-50/50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-800' : 'bg-muted/30',
            )}>
              {effectiveAiMode ? <Sparkles className="h-4 w-4 text-purple-500 mt-0.5 shrink-0" /> : <Lightbulb className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />}
              <div className="text-xs text-muted-foreground space-y-1">
                {effectiveAiMode ? (
                  <>
                    <p>Upload a PDF, Word document, or image and AI will extract {config.label.toLowerCase()} data automatically.</p>
                    <p>For best results, use clear documents with structured data (tables, lists).</p>
                  </>
                ) : (
                  <>
                    <p>{config.description}</p>
                    <p>{config.templateHint}</p>
                  </>
                )}
              </div>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={cn(
                'border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer',
                dragOver ? 'border-primary bg-primary/5' :
                file ? 'border-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20' :
                'border-muted-foreground/25 hover:border-muted-foreground/50',
              )}
              onClick={() => document.getElementById('import-dialog-file-input')?.click()}
            >
              {file ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-center gap-2">
                    {isAIFile ? <Sparkles className="h-7 w-7 text-amber-500" /> : <FileSpreadsheet className="h-7 w-7 text-emerald-600" />}
                  </div>
                  <p className="font-medium text-sm">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(2)} MB ·
                    {isAIFile ? ' AI extraction' : ' Spreadsheet'}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); setFile(null); setFileError(null) }}
                    className="text-muted-foreground text-xs h-7"
                  >
                    <X className="h-3 w-3 mr-1" /> Remove
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="h-8 w-8 text-muted-foreground/40 mx-auto" />
                  <p className="font-medium text-sm">{t('import.dropOrBrowse')}</p>
                  <div className="flex flex-wrap gap-1.5 justify-center">
                    {!effectiveAiMode && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                        <FileSpreadsheet className="h-2.5 w-2.5" /> CSV / Excel
                      </span>
                    )}
                    {(aiEnabled || effectiveAiMode) && (
                      <>
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                          <FileText className="h-2.5 w-2.5" /> PDF / Word
                          <Sparkles className="h-2 w-2 text-amber-500" />
                        </span>
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                          <Image className="h-2.5 w-2.5" /> Images
                          <Sparkles className="h-2 w-2 text-amber-500" />
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
            <input
              id="import-dialog-file-input"
              type="file"
              accept={fileAccept}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFileSelect(f)
                e.target.value = ''
              }}
            />

            {fileError && (
              <p className="text-xs text-destructive flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {fileError}
              </p>
            )}

            {/* AI hint */}
            {(file && isAIFile) || effectiveAiMode ? (
              <div className="space-y-1.5">
                <Label htmlFor="ai-hint" className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Lightbulb className="h-3.5 w-3.5 text-amber-500" /> Help the AI (optional)
                </Label>
                <Input
                  id="ai-hint"
                  placeholder={`e.g. "This PDF is a list of our research staff with departments"`}
                  value={userHint}
                  onChange={(e) => setUserHint(e.target.value)}
                  className="text-sm h-8"
                />
              </div>
            ) : null}

            {/* AI Quota */}
            {((file && isAIFile) || effectiveAiMode) && (
              <AiQuotaWidget onQuotaExhausted={setQuotaExhausted} />
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-1">
              {!effectiveAiMode ? (
                <Button variant="outline" size="sm" onClick={downloadTemplate} className="text-xs h-8 gap-1.5">
                  <Download className="h-3.5 w-3.5" /> {t('import.downloadTemplate')}
                </Button>
              ) : <div />}
              <Button size="sm" onClick={handleProcess} disabled={!file || processing || ((isAIFile || effectiveAiMode) && quotaExhausted)} className="h-8 gap-1.5">
                {(isAIFile || effectiveAiMode) && <Sparkles className="h-3.5 w-3.5" />}
                {!isAIFile && !effectiveAiMode && <ArrowRight className="h-3.5 w-3.5" />}
                {(isAIFile || effectiveAiMode) ? t('import.extractWithAI') : t('import.parseAndContinue')}
              </Button>
            </div>
          </div>
        )}

        {/* ═══════════════════ STEP 2: Processing ═══════════════════ */}
        {step === 'processing' && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="relative">
              <Loader2 className="h-10 w-10 text-primary animate-spin" />
              {isAIFile && <Sparkles className="h-4 w-4 text-amber-500 absolute -top-1 -right-1" />}
            </div>
            <p className="font-medium">{processingMessage}</p>
            <p className="text-xs text-muted-foreground">
              {isAIFile ? 'AI is analyzing your document. This may take 15–30 seconds.' : 'Parsing your spreadsheet…'}
            </p>
          </div>
        )}

        {/* ═══════════════════ STEP 3: Map columns ═══════════════════ */}
        {step === 'map' && parsed && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                <strong>{parsed.rows.length}</strong> record{parsed.rows.length !== 1 ? 's' : ''} found{parsed.source === 'ai' ? ' by AI' : ''}.
                Match your columns to the expected fields.
              </p>
              <Badge variant="secondary" className="text-[10px]">
                {Object.keys(mapping).length} / {config.columns.length} mapped
              </Badge>
            </div>

            {parsed.source === 'ai' && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900/50 p-2.5">
                <Sparkles className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-[11px] text-amber-800 dark:text-amber-200">
                  Data was extracted by AI. Column mapping has been auto-detected — please review carefully.
                </p>
              </div>
            )}

            <div className="rounded-lg border overflow-hidden max-h-[40vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b bg-muted/80 backdrop-blur-sm">
                    <th className="px-3 py-2 text-left font-medium text-xs w-[160px]">{t('import.targetField')}</th>
                    <th className="px-3 py-2 text-left font-medium text-xs">{t('import.yourColumn')}</th>
                    <th className="px-3 py-2 text-left font-medium text-xs hidden md:table-cell">{t('import.sample')}</th>
                    <th className="px-3 py-2 text-center font-medium w-[40px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {config.columns.map((col) => {
                    const csvHeader = mapping[col.field] ?? ''
                    const isMapped = !!csvHeader
                    const sampleValues = isMapped
                      ? parsed.rows.slice(0, 3).map((r) => String(r[csvHeader] ?? '')).filter(Boolean)
                      : []

                    return (
                      <tr key={col.field} className="border-b last:border-0">
                        <td className="px-3 py-2">
                          <span className="font-medium text-xs">{col.label}</span>
                          {col.required && <span className="text-destructive ml-0.5">*</span>}
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={csvHeader}
                            onChange={(e) => handleMappingChange(col.field, e.target.value)}
                            className={cn(
                              'w-full rounded-md border px-2 py-1 text-xs bg-background',
                              !isMapped && col.required && 'border-destructive/50',
                            )}
                          >
                            <option value="">— {t('import.skip')} —</option>
                            {parsed.headers.map((h) => (
                              <option key={h} value={h}>{h}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 hidden md:table-cell">
                          {sampleValues.length > 0 ? (
                            <span className="text-[11px] text-muted-foreground truncate block max-w-[180px]">
                              {sampleValues.join(' · ')}
                            </span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {isMapped ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600 inline-block" />
                          ) : col.required ? (
                            <AlertTriangle className="h-3.5 w-3.5 text-destructive inline-block" />
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex gap-2 justify-between pt-1">
              <Button variant="outline" size="sm" onClick={() => { setStep('upload'); setParsed(null); setMapping({}) }} className="h-8 gap-1.5 text-xs">
                <ArrowLeft className="h-3.5 w-3.5" /> {t('import.startOver')}
              </Button>
              <Button size="sm" onClick={handleConfirmMapping} disabled={!allMappedRequired} className="h-8 gap-1.5 text-xs">
                <ArrowRight className="h-3.5 w-3.5" /> {t('import.previewAndImport')}
              </Button>
            </div>
          </div>
        )}

        {/* ═══════════════════ STEP 4: Preview & Import ═══════════════════ */}
        {step === 'preview' && parsed && (
          <div className="space-y-4">
            {(() => {
              const mappedRows = getMappedRows()
              const mappedFields = Object.keys(mapping)
              return (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      <strong>{mappedRows.length}</strong> record{mappedRows.length !== 1 ? 's' : ''} ready to import.
                    </p>
                    <Badge variant="secondary" className="text-[10px]">{mappedRows.length} rows</Badge>
                  </div>

                  <div className="rounded-lg border overflow-x-auto max-h-[35vh] overflow-y-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 z-10">
                        <tr className="border-b bg-muted/80 backdrop-blur-sm">
                          <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-8">#</th>
                          {mappedFields.map((field) => (
                            <th key={field} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                              {config.columns.find(c => c.field === field)?.label ?? field}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {mappedRows.slice(0, 20).map((row, i) => (
                          <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                            <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                            {mappedFields.map((field) => (
                              <td key={field} className="px-2 py-1.5 max-w-[140px] truncate">
                                {String(row[field] ?? '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {mappedRows.length > 20 && (
                          <tr>
                            <td colSpan={mappedFields.length + 1} className="px-2 py-2 text-center text-muted-foreground text-[11px]">
                              … and {mappedRows.length - 20} more rows
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex gap-2 justify-between pt-1">
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setStep('map')} disabled={importing} className="h-8 gap-1.5 text-xs">
                        <ArrowLeft className="h-3.5 w-3.5" /> {t('import.backToMapping')}
                      </Button>
                    </div>
                    <Button size="sm" onClick={handleImport} disabled={importing} className="h-8 gap-1.5 text-xs">
                      {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {importing ? t('import.importing') : `${t('import.importRows', { count: mappedRows.length })}`}
                    </Button>
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
