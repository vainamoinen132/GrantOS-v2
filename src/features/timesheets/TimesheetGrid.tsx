import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { timesheetService, toDateStr } from '@/services/timesheetService'
import { docusignService } from '@/services/docusignService'
import { holidayService } from '@/services/holidayService'
import { absenceService } from '@/services/absenceService'
import { travelService } from '@/services/travelService'
import { settingsService } from '@/services/settingsService'
import { generateTimesheetPdf } from '@/services/timesheetPdfExport'
import { useAuthStore } from '@/stores/authStore'
import { useUiStore } from '@/stores/uiStore'
import { YearSelector } from '@/components/common/YearSelector'
import { useStaff } from '@/hooks/useStaff'
import { useProjects } from '@/hooks/useProjects'
import { SkeletonTable } from '@/components/common/SkeletonTable'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'
import { Copy, Sparkles, ChevronLeft, ChevronRight, Trash2, Plus, RotateCcw, CalendarDays, X, Send, PenTool, CheckCircle2, Clock, Undo2, FileSignature, Loader2, Shield, Plane, FileDown, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hoursToPm, formatPm, pmToHours } from '@/lib/pmUtils'
import type { Holiday, Absence, Assignment, TimesheetDay, TimesheetEntry, Travel } from '@/types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PROJECT_COLORS = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#84cc16']

interface DayInfo {
  date: Date
  dateStr: string
  dayNum: number
  dow: number
  isWeekend: boolean
  isHoliday: boolean
  holidayName: string | null
  isAbsence: boolean
  absenceType: string | null
  isTravel: boolean
  travelLocation: string | null
  isAvailable: boolean
}

interface ProjectRow {
  project_id: string
  work_package_id: string | null
  acronym: string
  wpName: string | null
  allocPm: number
  color: string
  isNationalProject: boolean
}

interface GridState {
  [key: string]: number // key = `${project_id}:${wp_id}:${dateStr}` → hours
}

interface NationalDayState {
  [key: string]: { start_time: string; end_time: string; description: string } // same key format
}

export function TimesheetGrid() {
  const { orgId, orgName, user, can } = useAuthStore()
  const { globalYear } = useUiStore()
  const { staff, isLoading: staffLoading } = useStaff({ is_active: true })
  const { projects: allProjects } = useProjects()
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1)
  const [selectedPersonId, setSelectedPersonId] = useState('')
  const [loading, setLoading] = useState(true)
  const [autoFilling, setAutoFilling] = useState(false)
  const [copying, setCopying] = useState(false)
  const [clearing, setClearing] = useState(false)

  // Data state
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [absences, setAbsences] = useState<Absence[]>([])
  const [travels, setTravels] = useState<Travel[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [existingDays, setExistingDays] = useState<TimesheetDay[]>([])
  const [hoursPerDay, setHoursPerDay] = useState(8)
  const [addProjectId, setAddProjectId] = useState('')
  const [manualProjectIds, setManualProjectIds] = useState<string[]>([])
  const [removedProjectIds, setRemovedProjectIds] = useState<string[]>([])

  // Envelope (approval + signing) state
  const [envelope, setEnvelope] = useState<TimesheetEntry | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [signing, setSigning] = useState(false)
  const [hasDocuSign, setHasDocuSign] = useState(false)

  // Fill Month Full state
  const [fillFullOpen, setFillFullOpen] = useState(false)
  const [fillFullSelectedIds, setFillFullSelectedIds] = useState<string[]>([])
  const [fillFullPcts, setFillFullPcts] = useState<Record<string, number>>({})
  const [fillFullBusy, setFillFullBusy] = useState(false)

  // Grid state (local edits before save)
  const [grid, setGrid] = useState<GridState>({})
  const [nationalGrid, setNationalGrid] = useState<NationalDayState>({})
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Determine person: staff sees self, admin can switch
  const isAdmin = can('canApproveTimesheets') || can('canManageProjects')
  const currentPersonId = selectedPersonId || staff.find(p => p.email === user?.email)?.id || ''

  // Load org settings (hours per day + DocuSign config)
  useEffect(() => {
    if (!orgId) return
    settingsService.getOrganisation(orgId).then(org => {
      if (org?.working_hours_per_day) setHoursPerDay(org.working_hours_per_day)
      setHasDocuSign(!!(org?.docusign_integration_key && org?.docusign_user_id && org?.docusign_account_id && org?.docusign_rsa_private_key))
    }).catch(() => {})
  }, [orgId])

  // Load all data when person/month changes
  const loadData = useCallback(async () => {
    if (!orgId || !currentPersonId) { setLoading(false); return }
    setLoading(true)
    try {
      // Load assignments across ALL months of the year (not just selected month)
      // This ensures projects show even if no PM allocated for this specific month
      const [days, hols, abs, alloc, trvls] = await Promise.all([
        timesheetService.listDays(orgId, currentPersonId, globalYear, selectedMonth),
        holidayService.listForMonth(orgId, globalYear, selectedMonth),
        absenceService.list(orgId, { person_id: currentPersonId, year: globalYear }),
        loadAssignmentsAllMonths(orgId, currentPersonId, globalYear),
        travelService.list(orgId, { person_id: currentPersonId, year: globalYear, month: selectedMonth }),
      ])
      setHolidays(hols)
      setAbsences(abs)
      setTravels(trvls)
      setAssignments(alloc)
      setExistingDays(days)

      // Build grid state from loaded day entries
      const g: GridState = {}
      const ng: NationalDayState = {}
      for (const d of days) {
        const key = `${d.project_id}:${d.work_package_id ?? ''}:${d.date}`
        g[key] = d.hours
        if (d.start_time || d.end_time || d.description) {
          ng[key] = {
            start_time: d.start_time ?? '',
            end_time: d.end_time ?? '',
            description: d.description ?? '',
          }
        }
      }
      setGrid(g)
      setNationalGrid(ng)

      // Ensure envelope exists and load it for status
      try {
        const env = await timesheetService.ensureEnvelope(orgId, currentPersonId, globalYear, selectedMonth)
        setEnvelope(env)
      } catch { setEnvelope(null) }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load timesheet data'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [orgId, currentPersonId, globalYear, selectedMonth])

  useEffect(() => { loadData() }, [loadData])

  // Re-fetch data when the browser tab becomes visible again
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') loadData()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [loadData])

  // Reset manual project additions when person changes
  useEffect(() => { setManualProjectIds([]); setRemovedProjectIds([]); setFillFullOpen(false) }, [currentPersonId])

  // Load assignments for person across ALL months in the year
  async function loadAssignmentsAllMonths(orgId: string, personId: string, year: number): Promise<Assignment[]> {
    const { data, error } = await (await import('@/lib/supabase')).supabase
      .from('assignments')
      .select('*, projects(acronym, title), work_packages(name)')
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('year', year)
      .eq('type', 'actual')

    if (error) throw error
    return (data ?? []) as unknown as Assignment[]
  }

  // Build calendar days for the month
  const calendarDays: DayInfo[] = useMemo(() => {
    const daysInMonth = new Date(globalYear, selectedMonth, 0).getDate()

    // Filter holidays to only those matching the current person's country + region
    const currentPerson = staff.find(p => p.id === currentPersonId)
    const personCountry = currentPerson?.country ?? null
    const personRegion = currentPerson?.region ?? null
    const filteredHolidays = holidays.filter(h => {
      // Manual holidays (no country) apply to everyone
      if (!h.country_code) return true
      // Country must match
      if (h.country_code !== personCountry) return false
      // National holidays (no region) apply to everyone in that country
      if (!h.region_code) return true
      // Regional holidays: if person has no region set, include all; otherwise must match
      if (!personRegion) return true
      return h.region_code === personRegion
    })

    const holidaySet = new Set(filteredHolidays.map(h => h.date))
    const holidayNames = new Map(filteredHolidays.map(h => [h.date, h.name]))

    // Build absence date set for this person
    const absenceDates = new Set<string>()
    const absenceTypeMap = new Map<string, string>()
    for (const a of absences.filter(ab => ab.person_id === currentPersonId)) {
      const start = a.start_date ?? a.date
      const end = a.end_date ?? a.date ?? a.start_date
      if (!start) continue
      const startD = new Date(start)
      const endD = new Date(end ?? start)
      const cursor = new Date(startD)
      while (cursor <= endD) {
        const ds = toDateStr(cursor)
        absenceDates.add(ds)
        absenceTypeMap.set(ds, a.type)
        cursor.setDate(cursor.getDate() + 1)
      }
    }

    // Build travel date set for this person
    const travelDateMap = new Map<string, string>()
    for (const t of travels) {
      travelDateMap.set(t.date, t.location)
    }

    const result: DayInfo[] = []
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(globalYear, selectedMonth - 1, d)
      const dow = date.getDay()
      const dateStr = toDateStr(date)
      const isWeekend = dow === 0 || dow === 6
      const isHoliday = holidaySet.has(dateStr)
      const isAbsence = absenceDates.has(dateStr)
      const isTravel = travelDateMap.has(dateStr)
      result.push({
        date, dateStr, dayNum: d, dow, isWeekend, isHoliday,
        holidayName: holidayNames.get(dateStr) ?? null,
        isAbsence, absenceType: absenceTypeMap.get(dateStr) ?? null,
        isTravel, travelLocation: travelDateMap.get(dateStr) ?? null,
        isAvailable: !isWeekend && !isHoliday && !isAbsence,
      })
    }
    return result
  }, [globalYear, selectedMonth, holidays, absences, travels, currentPersonId, staff])

  const availableDays = useMemo(() => calendarDays.filter(d => d.isAvailable), [calendarDays])
  const availableDateStrs = useMemo(() => availableDays.map(d => d.dateStr), [availableDays])

  // Build project rows from: assignments (all months), existing day entries, and manually added projects
  const projectRows: ProjectRow[] = useMemo(() => {
    const projectMap = new Map(allProjects.map(p => [p.id, p]))
    const seen = new Set<string>() // "projectId:wpId"
    const rows: ProjectRow[] = []

    // 1) From assignments (deduplicate by project+wp, sum PM for selected month only)
    const pmByKey = new Map<string, number>()
    for (const a of assignments) {
      const key = `${a.project_id}:${(a as any).work_package_id ?? ''}`
      if (a.month === selectedMonth) {
        pmByKey.set(key, (pmByKey.get(key) ?? 0) + (a.pms ?? 0))
      }
      if (!seen.has(key)) {
        seen.add(key)
        rows.push({
          project_id: a.project_id,
          work_package_id: (a as any).work_package_id,
          acronym: (a as any).projects?.acronym ?? projectMap.get(a.project_id)?.acronym ?? '—',
          wpName: (a as any).work_packages?.name ?? null,
          allocPm: 0, // will be filled below
          color: '',
          isNationalProject: false, // set below
        })
      }
    }

    // 2) From existing timesheet_days entries (e.g. hours entered without an allocation)
    for (const d of existingDays) {
      const key = `${d.project_id}:${d.work_package_id ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        const proj = projectMap.get(d.project_id)
        rows.push({
          project_id: d.project_id,
          work_package_id: d.work_package_id,
          acronym: proj?.acronym ?? '—',
          wpName: null,
          allocPm: 0,
          color: '',
          isNationalProject: false, // set below
        })
      }
    }

    // 3) From manually added projects
    for (const pid of manualProjectIds) {
      const key = `${pid}:`
      if (!seen.has(key)) {
        seen.add(key)
        const proj = projectMap.get(pid)
        rows.push({
          project_id: pid,
          work_package_id: null,
          acronym: proj?.acronym ?? '—',
          wpName: null,
          allocPm: 0,
          color: '',
          isNationalProject: false, // set below
        })
      }
    }

    // Fill in allocPm and colors, then filter out removed projects
    const removedSet = new Set(removedProjectIds)
    return rows
      .filter(r => !removedSet.has(r.project_id))
      .map((r, i) => {
        const proj = projectMap.get(r.project_id)
        return {
          ...r,
          allocPm: pmByKey.get(`${r.project_id}:${r.work_package_id ?? ''}`) ?? 0,
          color: PROJECT_COLORS[i % PROJECT_COLORS.length],
          isNationalProject: proj?.funding_schemes?.requires_time_range ?? false,
        }
      })
  }, [assignments, existingDays, manualProjectIds, removedProjectIds, allProjects, selectedMonth])

  // Compute totals
  const projectTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const row of projectRows) {
      const key = `${row.project_id}:${row.work_package_id ?? ''}`
      let sum = 0
      for (const d of calendarDays) {
        const gKey = `${row.project_id}:${row.work_package_id ?? ''}:${d.dateStr}`
        sum += (grid[gKey] || 0)
      }
      totals[key] = sum
    }
    return totals
  }, [grid, projectRows, calendarDays])

  const dailyTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const d of calendarDays) {
      let sum = 0
      for (const row of projectRows) {
        const gKey = `${row.project_id}:${row.work_package_id ?? ''}:${d.dateStr}`
        sum += (grid[gKey] || 0)
      }
      totals[d.dateStr] = sum
    }
    return totals
  }, [grid, projectRows, calendarDays])

  const grandTotal = useMemo(() => Object.values(projectTotals).reduce((a, b) => a + b, 0), [projectTotals])
  const totalCapacity = availableDays.length * hoursPerDay
  const capacityPct = totalCapacity > 0 ? Math.round((grandTotal / totalCapacity) * 100) : 0
  const grandTotalPm = hoursToPm(grandTotal, availableDays.length, hoursPerDay)

  // Grid cell change handler with debounced auto-save + daily cap enforcement
  const handleCellChange = useCallback((projectId: string, wpId: string | null, dateStr: string, value: number) => {
    const key = `${projectId}:${wpId ?? ''}:${dateStr}`

    // Enforce daily cap: sum of all projects for this day must not exceed hoursPerDay
    const otherHours = projectRows.reduce((sum, row) => {
      const rKey = `${row.project_id}:${row.work_package_id ?? ''}:${dateStr}`
      if (rKey === key) return sum
      return sum + (grid[rKey] || 0)
    }, 0)
    const maxAllowed = Math.max(0, hoursPerDay - otherHours)
    const capped = Math.min(value, maxAllowed)

    if (value > maxAllowed) {
      toast({
        title: 'Daily limit reached',
        description: `Maximum ${hoursPerDay}h per day. You can enter up to ${maxAllowed}h for this project today.`,
        variant: 'destructive',
      })
    }

    setGrid(prev => ({ ...prev, [key]: capped }))

    // Debounced save
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      if (!orgId || !currentPersonId) return
      try {
        await timesheetService.upsertDay(orgId, currentPersonId, projectId, wpId, dateStr, capped)
      } catch (err) {
        console.error('Auto-save failed:', err)
      }
    }, 800)
  }, [orgId, currentPersonId, grid, projectRows, hoursPerDay])

  // National project cell change handler (start_time + end_time + description)
  const nationalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleNationalCellChange = useCallback((
    projectId: string, wpId: string | null, dateStr: string,
    field: 'start_time' | 'end_time' | 'description', value: string,
  ) => {
    const key = `${projectId}:${wpId ?? ''}:${dateStr}`
    setNationalGrid(prev => {
      const existing = prev[key] ?? { start_time: '', end_time: '', description: '' }
      return { ...prev, [key]: { ...existing, [field]: value } }
    })

    // Auto-compute hours from start_time and end_time
    if (field === 'start_time' || field === 'end_time') {
      setNationalGrid(prev => {
        const entry = prev[key]
        if (entry?.start_time && entry?.end_time) {
          const [sh, sm] = entry.start_time.split(':').map(Number)
          const [eh, em] = entry.end_time.split(':').map(Number)
          if (!isNaN(sh) && !isNaN(sm) && !isNaN(eh) && !isNaN(em)) {
            const diff = (eh * 60 + em - sh * 60 - sm) / 60
            const hours = Math.max(0, Math.round(diff * 4) / 4) // snap to 0.25
            setGrid(gPrev => ({ ...gPrev, [key]: hours }))
          }
        }
        return prev
      })
    }

    // Debounced save
    if (nationalSaveTimerRef.current) clearTimeout(nationalSaveTimerRef.current)
    nationalSaveTimerRef.current = setTimeout(async () => {
      if (!orgId || !currentPersonId) return
      // Get current state
      const entry = nationalGrid[key] ?? { start_time: '', end_time: '', description: '' }
      const updatedEntry = { ...entry, [field]: value }
      // Compute hours
      let hours = grid[key] || 0
      if (updatedEntry.start_time && updatedEntry.end_time) {
        const [sh, sm] = updatedEntry.start_time.split(':').map(Number)
        const [eh, em] = updatedEntry.end_time.split(':').map(Number)
        if (!isNaN(sh) && !isNaN(sm) && !isNaN(eh) && !isNaN(em)) {
          const diff = (eh * 60 + em - sh * 60 - sm) / 60
          hours = Math.max(0, Math.round(diff * 4) / 4)
        }
      }
      try {
        await timesheetService.upsertDay(orgId, currentPersonId, projectId, wpId, dateStr, hours, {
          start_time: updatedEntry.start_time || null,
          end_time: updatedEntry.end_time || null,
          description: updatedEntry.description || null,
        })
      } catch (err) {
        console.error('National auto-save failed:', err)
      }
    }, 800)
  }, [orgId, currentPersonId, nationalGrid, grid])

  // Fill from plan
  const handleAutoFill = async () => {
    if (!orgId || !currentPersonId) return
    setAutoFilling(true)
    try {
      const result = await timesheetService.autoFillFromPlan(
        orgId, currentPersonId, globalYear, selectedMonth, availableDateStrs, hoursPerDay,
      )
      toast({ title: 'Filled from plan', description: `${result.filled} cells populated from allocations.` })
      await loadData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to auto-fill'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setAutoFilling(false)
    }
  }

  // Copy previous month
  const handleCopyPrevMonth = async () => {
    if (!orgId || !currentPersonId) return
    setCopying(true)
    try {
      const result = await timesheetService.copyPreviousMonth(
        orgId, currentPersonId, globalYear, selectedMonth, availableDateStrs,
      )
      toast({ title: 'Copied', description: `${result.copied} cells copied from previous month.` })
      await loadData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to copy'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setCopying(false)
    }
  }

  // Clear a single project row for this month
  const handleClearRow = async (projectId: string) => {
    if (!orgId || !currentPersonId) return
    const proceed = window.confirm('Clear all hours for this project in the current month?')
    if (!proceed) return
    setClearing(true)
    try {
      await timesheetService.clearDays(orgId, currentPersonId, globalYear, selectedMonth, projectId)
      toast({ title: 'Cleared', description: 'Hours cleared for this project.' })
      await loadData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setClearing(false)
    }
  }

  // Clear all hours for the entire month
  const handleClearAll = async () => {
    if (!orgId || !currentPersonId) return
    const proceed = window.confirm(`Clear ALL hours for ${MONTHS[selectedMonth - 1]} ${globalYear}? This cannot be undone.`)
    if (!proceed) return
    setClearing(true)
    try {
      await timesheetService.clearDays(orgId, currentPersonId, globalYear, selectedMonth)
      toast({ title: 'Cleared', description: 'All hours cleared for this month.' })
      await loadData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setClearing(false)
    }
  }

  // Add a project manually to the timesheet (persist immediately with a 0-hour entry)
  const handleAddProject = async () => {
    if (!addProjectId || !orgId || !currentPersonId) return
    if (projectRows.some(r => r.project_id === addProjectId)) {
      toast({ title: 'Already added', description: 'This project is already in the timesheet.' })
      setAddProjectId('')
      return
    }
    setManualProjectIds(prev => [...prev, addProjectId])
    setRemovedProjectIds(prev => prev.filter(id => id !== addProjectId))
    // Persist a 0-hour entry on the first available day so the row survives person switches
    if (availableDays.length > 0) {
      try {
        await timesheetService.upsertDay(orgId, currentPersonId, addProjectId, null, availableDays[0].dateStr, 0)
      } catch { /* non-critical */ }
    }
    setAddProjectId('')
  }

  // Remove a project row entirely (clear all its hours for the month)
  const handleRemoveProject = async (projectId: string) => {
    if (!orgId || !currentPersonId) return
    const proceed = window.confirm('Remove this project from the timesheet? All hours for this project in the current month will be deleted.')
    if (!proceed) return
    setClearing(true)
    try {
      await timesheetService.clearDays(orgId, currentPersonId, globalYear, selectedMonth, projectId)
      setManualProjectIds(prev => prev.filter(id => id !== projectId))
      setRemovedProjectIds(prev => [...prev, projectId])
      toast({ title: 'Removed', description: 'Project removed from timesheet.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove project'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setClearing(false)
    }
  }

  // Fill Month Full: distribute hoursPerDay across selected projects using custom percentages
  const handleFillMonthFull = async () => {
    if (!orgId || !currentPersonId || fillFullSelectedIds.length === 0) return
    setFillFullBusy(true)
    try {
      const n = fillFullSelectedIds.length
      // Use custom percentages; compute hours per project from percentages
      // Round to whole hours, distribute remainder to projects with highest percentages
      const rawHours = fillFullSelectedIds.map(id => {
        const pct = fillFullPcts[id] ?? Math.round(100 / n)
        return { id, hours: (pct / 100) * hoursPerDay }
      })
      // Floor all, then distribute remainder
      const floored = rawHours.map(r => ({ ...r, whole: Math.floor(r.hours) }))
      let remaining = hoursPerDay - floored.reduce((s, r) => s + r.whole, 0)
      // Sort by fractional part descending to distribute remainder
      const sorted = [...floored].sort((a, b) => (b.hours - b.whole) - (a.hours - a.whole))
      for (const item of sorted) {
        if (remaining <= 0) break
        item.whole += 1
        remaining -= 1
      }
      const hoursMap = new Map(floored.map(r => [r.id, r.whole]))

      const entries: { projectId: string; wpId: string | null; dateStr: string; hours: number }[] = []
      for (const day of availableDays) {
        for (const id of fillFullSelectedIds) {
          const h = hoursMap.get(id) ?? 0
          if (h > 0) {
            entries.push({
              projectId: id,
              wpId: null,
              dateStr: day.dateStr,
              hours: h,
            })
          }
        }
      }

      // Save all entries
      await timesheetService.bulkUpsertDays(
        entries.map(e => ({
          org_id: orgId,
          person_id: currentPersonId,
          project_id: e.projectId,
          work_package_id: e.wpId,
          date: e.dateStr,
          hours: e.hours,
        })),
      )

      // Add any projects not yet in manual list
      const currentIds = new Set(projectRows.map(r => r.project_id))
      const newIds = fillFullSelectedIds.filter(id => !currentIds.has(id))
      if (newIds.length > 0) {
        setManualProjectIds(prev => [...prev, ...newIds])
      }

      toast({ title: 'Month filled', description: `${availableDays.length} days × ${n} projects filled.` })
      setFillFullOpen(false)
      setFillFullSelectedIds([])
      setFillFullPcts({})
      await loadData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fill month'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setFillFullBusy(false)
    }
  }

  // ── Submit timesheet ──
  const handleSubmit = async () => {
    if (!orgId || !currentPersonId || !user?.id) return
    if (grandTotal <= 0) {
      toast({ title: 'Cannot submit', description: 'Please enter hours before submitting.', variant: 'destructive' })
      return
    }
    if (grandTotal > totalCapacity) {
      toast({
        title: 'Over-allocated',
        description: `Total hours (${grandTotal}h) exceed monthly capacity (${totalCapacity}h / 1 PM). Please reduce hours before submitting.`,
        variant: 'destructive',
      })
      return
    }
    const proceed = window.confirm(`Submit your timesheet for ${MONTHS[selectedMonth - 1]} ${globalYear}? You won't be able to edit hours after submission.`)
    if (!proceed) return
    setSubmitting(true)
    try {
      await timesheetService.submit(orgId, currentPersonId, globalYear, selectedMonth, user.id)
      toast({ title: 'Submitted', description: hasDocuSign ? 'Timesheet submitted. You can now sign it.' : 'Timesheet submitted for approval.' })
      await loadData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  // ── Request DocuSign e-signature ──
  const handleSign = async () => {
    if (!orgId || !currentPersonId || !user?.id) return
    setSigning(true)
    try {
      const result = await docusignService.requestSigning({
        orgId,
        personId: currentPersonId,
        year: globalYear,
        month: selectedMonth,
        userId: user.id,
      })
      toast({ title: 'Signing initiated', description: 'Opening DocuSign for your signature…' })
      // Redirect to DocuSign signing ceremony
      if (result.signingUrl) {
        window.location.href = result.signingUrl
      }
      await loadData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to initiate signing'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setSigning(false)
    }
  }

  // ── Recall (revert to Draft) — only admin or own timesheet before signing ──
  const handleRecall = async () => {
    if (!orgId || !currentPersonId || !user?.id) return
    const proceed = window.confirm('Recall this timesheet to Draft? This will cancel the current submission.')
    if (!proceed) return
    try {
      await timesheetService.updateEnvelopeStatus(orgId, currentPersonId, globalYear, selectedMonth, 'Draft', user.id)
      toast({ title: 'Recalled', description: 'Timesheet reverted to Draft. You can edit hours again.' })
      await loadData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to recall'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    }
  }

  // Is the grid locked for editing? (anything beyond Draft is locked)
  const envelopeStatus = envelope?.status ?? 'Draft'
  const isLocked = envelopeStatus !== 'Draft' && envelopeStatus !== 'Rejected'

  const prevMonth = () => setSelectedMonth(m => m > 1 ? m - 1 : 12)
  const nextMonth = () => setSelectedMonth(m => m < 12 ? m + 1 : 1)
  const prevMonthName = MONTHS[(selectedMonth - 2 + 12) % 12]

  // Projects available to add (not already in grid)
  const availableProjects = useMemo(() => {
    const inGrid = new Set(projectRows.map(r => r.project_id))
    return allProjects.filter(p => !inGrid.has(p.id))
  }, [allProjects, projectRows])

  if (loading || staffLoading) return <SkeletonTable columns={6} rows={6} />

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex gap-3 items-end flex-wrap">
          {isAdmin && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Person</label>
              <select
                value={currentPersonId}
                onChange={(e) => setSelectedPersonId(e.target.value)}
                className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Select person...</option>
                {staff.map(p => (
                  <option key={p.id} value={p.id}>{p.full_name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Year</label>
            <YearSelector />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Month</label>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={prevMonth} aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="inline-flex items-center rounded-lg border bg-muted/40 p-0.5 gap-0.5 flex-wrap">
                {MONTHS.map((m, i) => (
                  <button
                    key={i}
                    onClick={() => setSelectedMonth(i + 1)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[11px] font-semibold transition-all',
                      selectedMonth === i + 1
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={nextMonth} aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {!isLocked && (
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={handleAutoFill} disabled={autoFilling || projectRows.length === 0} className="gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              {autoFilling ? 'Filling...' : 'Fill from Plan'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCopyPrevMonth} disabled={copying} className="gap-1.5">
              <Copy className="h-3.5 w-3.5" />
              {copying ? 'Copying...' : `Copy ${prevMonthName}`}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setFillFullOpen(true); setFillFullSelectedIds([]) }} disabled={allProjects.length === 0} className="gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" />
              Fill Month Full
            </Button>
            {grandTotal > 0 && (
              <Button variant="outline" size="sm" onClick={handleClearAll} disabled={clearing} className="gap-1.5 text-destructive hover:text-destructive">
                <RotateCcw className="h-3.5 w-3.5" />
                {clearing ? 'Clearing...' : 'Clear All'}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Status banner + action buttons ── */}
      <div className={cn(
        'flex items-center justify-between rounded-lg border px-4 py-3',
        envelopeStatus === 'Draft' && 'border-muted bg-muted/20',
        envelopeStatus === 'Submitted' && 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30',
        envelopeStatus === 'Signing' && 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30',
        envelopeStatus === 'Signed' && 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30',
        envelopeStatus === 'Approved' && 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40',
        envelopeStatus === 'Rejected' && 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30',
      )}>
        <div className="flex items-center gap-2.5">
          {envelopeStatus === 'Draft' && <Clock className="h-4 w-4 text-muted-foreground" />}
          {envelopeStatus === 'Submitted' && <Send className="h-4 w-4 text-blue-600" />}
          {envelopeStatus === 'Signing' && <PenTool className="h-4 w-4 text-amber-600" />}
          {envelopeStatus === 'Signed' && <FileSignature className="h-4 w-4 text-emerald-600" />}
          {envelopeStatus === 'Approved' && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
          {envelopeStatus === 'Rejected' && <Undo2 className="h-4 w-4 text-red-600" />}
          <div>
            <div className="text-sm font-semibold">
              {envelopeStatus === 'Draft' && 'Draft — Fill in your hours and submit'}
              {envelopeStatus === 'Submitted' && (hasDocuSign ? 'Submitted — Ready for signing' : 'Submitted — Awaiting approval')}
              {envelopeStatus === 'Signing' && 'Signing in progress — Waiting for e-signature'}
              {envelopeStatus === 'Signed' && 'Signed — Awaiting approval'}
              {envelopeStatus === 'Approved' && 'Approved ✓'}
              {envelopeStatus === 'Rejected' && 'Rejected — Please review and resubmit'}
            </div>
            {envelope?.submitted_at && envelopeStatus !== 'Draft' && (
              <div className="text-[11px] text-muted-foreground">
                Submitted {new Date(envelope.submitted_at).toLocaleDateString()}
                {envelope.signed_at && ` · Signed ${new Date(envelope.signed_at).toLocaleDateString()}`}
                {envelope.approved_at && ` · Approved ${new Date(envelope.approved_at).toLocaleDateString()}`}
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          {/* Draft → Submit */}
          {(envelopeStatus === 'Draft' || envelopeStatus === 'Rejected') && grandTotal > 0 && (
            <Button size="sm" onClick={handleSubmit} disabled={submitting} className="gap-1.5">
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {submitting ? 'Submitting…' : 'Submit'}
            </Button>
          )}

          {/* Submitted → Sign (only if DocuSign is configured) */}
          {envelopeStatus === 'Submitted' && hasDocuSign && (
            <>
              <Button variant="outline" size="sm" onClick={handleRecall} className="gap-1.5">
                <Undo2 className="h-3.5 w-3.5" />
                Recall
              </Button>
              <Button size="sm" onClick={handleSign} disabled={signing} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white">
                {signing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PenTool className="h-3.5 w-3.5" />}
                {signing ? 'Initiating…' : 'Sign with DocuSign'}
              </Button>
            </>
          )}

          {/* Submitted → admin can approve/reject directly (no DocuSign) */}
          {envelopeStatus === 'Submitted' && !hasDocuSign && isAdmin && (
            <>
              <Button size="sm" variant="outline" onClick={async () => {
                if (!orgId || !currentPersonId || !user?.id) return
                await timesheetService.updateEnvelopeStatus(orgId, currentPersonId, globalYear, selectedMonth, 'Approved', user.id)
                toast({ title: 'Approved', description: 'Timesheet approved.' })
                await loadData()
              }} className="gap-1.5 text-emerald-600 border-emerald-300 hover:bg-emerald-50">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={async () => {
                if (!orgId || !currentPersonId || !user?.id) return
                await timesheetService.updateEnvelopeStatus(orgId, currentPersonId, globalYear, selectedMonth, 'Rejected', user.id)
                toast({ title: 'Rejected', description: 'Timesheet rejected. The person can revise and resubmit.' })
                await loadData()
              }} className="gap-1.5 text-red-600 border-red-300 hover:bg-red-50">
                <Undo2 className="h-3.5 w-3.5" />
                Reject
              </Button>
            </>
          )}

          {/* Submitted → non-admin recall (no DocuSign) */}
          {envelopeStatus === 'Submitted' && !hasDocuSign && !isAdmin && (
            <Button variant="outline" size="sm" onClick={handleRecall} className="gap-1.5">
              <Undo2 className="h-3.5 w-3.5" />
              Recall
            </Button>
          )}

          {/* Signing → waiting (DocuSign flow only) */}
          {envelopeStatus === 'Signing' && envelope?.signature_url && (
            <Button size="sm" variant="outline" onClick={() => window.open(envelope.signature_url!, '_blank')} className="gap-1.5">
              <PenTool className="h-3.5 w-3.5" />
              Open Signing
            </Button>
          )}

          {/* Signed → admin can approve/reject (DocuSign flow) */}
          {envelopeStatus === 'Signed' && isAdmin && (
            <>
              <Button size="sm" variant="outline" onClick={async () => {
                if (!orgId || !currentPersonId || !user?.id) return
                await timesheetService.updateEnvelopeStatus(orgId, currentPersonId, globalYear, selectedMonth, 'Approved', user.id)
                toast({ title: 'Approved', description: 'Timesheet approved.' })
                await loadData()
              }} className="gap-1.5 text-emerald-600 border-emerald-300 hover:bg-emerald-50">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={async () => {
                if (!orgId || !currentPersonId || !user?.id) return
                await timesheetService.updateEnvelopeStatus(orgId, currentPersonId, globalYear, selectedMonth, 'Rejected', user.id)
                toast({ title: 'Rejected', description: 'Timesheet rejected. The person can revise and resubmit.' })
                await loadData()
              }} className="gap-1.5 text-red-600 border-red-300 hover:bg-red-50">
                <Undo2 className="h-3.5 w-3.5" />
                Reject
              </Button>
            </>
          )}

          {/* Approved → locked indicator */}
          {envelopeStatus === 'Approved' && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600">
              <Shield className="h-3.5 w-3.5" />
              Locked
            </div>
          )}

          {/* PDF Export — available when there are hours */}
          {grandTotal > 0 && (
            <Button variant="outline" size="sm" onClick={() => {
              const currentPerson = staff.find(p => p.id === currentPersonId)
              if (!currentPerson || !orgId) return
              generateTimesheetPdf({
                person: currentPerson,
                year: globalYear,
                month: selectedMonth,
                orgName: orgName ?? '',
                days: existingDays,
                projects: allProjects,
                envelope,
                hoursPerDay,
                holidays: new Set(holidays.map(h => h.date)),
                absences: new Set(
                  absences.filter(a => a.person_id === currentPersonId).flatMap(a => {
                    const dates: string[] = []
                    const start = a.start_date ?? a.date
                    const end = a.end_date ?? a.date ?? a.start_date
                    if (!start) return dates
                    const cursor = new Date(start)
                    const endD = new Date(end ?? start)
                    while (cursor <= endD) {
                      dates.push(toDateStr(cursor))
                      cursor.setDate(cursor.getDate() + 1)
                    }
                    return dates
                  })
                ),
              })
              toast({ title: 'PDF exported', description: 'Timesheet PDF downloaded.' })
            }} className="gap-1.5">
              <FileDown className="h-3.5 w-3.5" />
              Export PDF
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Working Days</div>
          <div className="text-xl font-bold tabular-nums mt-0.5">{availableDays.length}</div>
          <div className="text-[11px] text-muted-foreground">{MONTHS[selectedMonth - 1]} {globalYear}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Total Hours</div>
          <div className="text-xl font-bold tabular-nums mt-0.5 text-primary">{grandTotal.toFixed(1)}h</div>
          <div className="text-[11px] text-muted-foreground">= {formatPm(grandTotalPm)} · max {totalCapacity}h</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Capacity Used</div>
          <div className={cn('text-xl font-bold tabular-nums mt-0.5', capacityPct > 100 ? 'text-red-500' : capacityPct >= 80 ? 'text-amber-500' : 'text-emerald-500')}>{capacityPct}%</div>
          <div className="text-[11px] text-muted-foreground">
            {calendarDays.filter(d => d.isHoliday).length > 0 && `${calendarDays.filter(d => d.isHoliday).length} holiday · `}
            {calendarDays.filter(d => d.isAbsence).length > 0 && `${calendarDays.filter(d => d.isAbsence).length} absence · `}
            {projectRows.length} projects
          </div>
        </div>
      </div>

      {/* Capacity progress bar */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', capacityPct > 100 ? 'bg-red-500' : capacityPct >= 80 ? 'bg-amber-500' : 'bg-emerald-500')}
            style={{ width: `${Math.min(capacityPct, 100)}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{grandTotal.toFixed(1)} / {totalCapacity}h</span>
      </div>

      {/* Over-capacity warning */}
      {capacityPct > 100 && (
        <div className="flex items-center gap-2.5 rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
          <div>
            <div className="text-sm font-semibold text-red-700 dark:text-red-400">Over-allocated</div>
            <div className="text-[11px] text-red-600 dark:text-red-400/80">
              Total hours ({grandTotal}h) exceed monthly capacity ({totalCapacity}h / 1 PM). Reduce hours to 100% or below before submitting.
            </div>
          </div>
        </div>
      )}

      {/* Add project to timesheet */}
      {availableProjects.length > 0 && !isLocked && (
        <div className="flex items-center gap-2">
          <select
            value={addProjectId}
            onChange={(e) => setAddProjectId(e.target.value)}
            className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Add a project...</option>
            {availableProjects.map(p => (
              <option key={p.id} value={p.id}>{p.acronym} — {p.title}</option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={handleAddProject} disabled={!addProjectId} className="h-8 gap-1 text-xs">
            <Plus className="h-3 w-3" />
            Add
          </Button>
        </div>
      )}

      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border bg-background" /> Editable</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-muted" /> Weekend</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-50 border-red-200 border" /> Holiday</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-50 border-blue-200 border" /> Absence</span>
        <span className="flex items-center gap-1.5"><Plane className="w-3 h-3 text-orange-500" /> Travel</span>
      </div>

      {/* THE GRID */}
      {projectRows.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center space-y-2">
          <div className="text-muted-foreground text-sm">No projects found for this person.</div>
          <div className="text-muted-foreground text-xs">Use the "Add a project" dropdown above, or create allocations in the Allocations module.</div>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-max min-w-full border-collapse text-xs">
              <thead>
                <tr className="bg-muted/60">
                  <th className="sticky left-0 z-10 bg-muted/60 px-3 py-2 text-left font-semibold text-muted-foreground min-w-[180px] border-r border-b">
                    Project / WP
                  </th>
                  {calendarDays.map(d => (
                    <th
                      key={d.dateStr}
                      className={cn(
                        'px-0 py-1 text-center font-medium border-b min-w-[42px] w-[42px]',
                        d.isWeekend && 'bg-muted/40',
                        d.isHoliday && 'bg-red-50',
                        d.isTravel && !d.isWeekend && 'border-t-2 border-t-orange-400',
                      )}
                      title={d.isHoliday ? d.holidayName ?? 'Holiday' : d.isTravel ? `Travel: ${d.travelLocation}` : undefined}
                    >
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{DAY_NAMES[d.dow]}</div>
                      <div className="flex items-center justify-center gap-0.5">
                        <span className={cn('text-[11px] font-bold', d.isHoliday && 'text-red-500')}>{d.dayNum}</span>
                        {d.isTravel && !d.isWeekend && <Plane className="h-2.5 w-2.5 text-orange-500" />}
                      </div>
                    </th>
                  ))}
                  <th className="px-2 py-2 text-center font-bold border-b border-l min-w-[64px] bg-muted/60">Total</th>
                </tr>
              </thead>
              <tbody>
                {projectRows.map((row, rowIdx) => {
                  const rowKey = `${row.project_id}:${row.work_package_id ?? ''}`
                  const rowTotal = projectTotals[rowKey] || 0
                  const allocHours = pmToHours(row.allocPm, availableDays.length, hoursPerDay)
                  const rowPm = hoursToPm(rowTotal, availableDays.length, hoursPerDay)

                  return (
                    <tr key={rowKey} className={cn('border-b last:border-0', rowIdx % 2 === 1 && 'bg-muted/10')}>
                      <td
                        className="sticky left-0 z-[1] bg-card px-3 py-2 border-r font-medium"
                        style={{ borderLeft: `3px solid ${row.color}` }}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <div>
                            <div className="text-primary font-semibold text-xs">{row.acronym}</div>
                            {row.wpName && <div className="text-[10px] text-muted-foreground">{row.wpName}</div>}
                            {row.allocPm > 0 && (
                              <div className="text-[10px] text-muted-foreground">Plan: {allocHours.toFixed(1)}h ({formatPm(row.allocPm)})</div>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5">
                            {rowTotal > 0 && (
                              <button
                                onClick={() => handleClearRow(row.project_id)}
                                disabled={clearing}
                                className="text-muted-foreground/40 hover:text-amber-600 transition-colors p-0.5 rounded"
                                title="Clear hours for this row"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                            <button
                              onClick={() => handleRemoveProject(row.project_id)}
                              disabled={clearing}
                              className="text-muted-foreground/40 hover:text-destructive transition-colors p-0.5 rounded"
                              title="Remove project from timesheet"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      </td>
                      {calendarDays.map(d => {
                        const cellKey = `${row.project_id}:${row.work_package_id ?? ''}:${d.dateStr}`
                        const value = grid[cellKey] || 0
                        const editable = d.isAvailable && !isLocked

                        return (
                          <td
                            key={d.dateStr}
                            className={cn(
                              'px-0.5 py-0.5 text-center',
                              d.isWeekend && 'bg-muted/30',
                              d.isHoliday && 'bg-red-50/50',
                              d.isAbsence && !d.isWeekend && 'bg-blue-50/50',
                            )}
                          >
                            {!editable ? (
                              <div className="h-7 flex items-center justify-center text-muted-foreground/40 text-[10px]">
                                {d.isHoliday ? '🏛' : d.isAbsence ? '🏖' : ''}
                              </div>
                            ) : row.isNationalProject ? (
                              <div
                                className={cn(
                                  'h-7 flex items-center justify-center text-[10px] tabular-nums rounded',
                                  value > 0 ? 'font-bold text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/30' : 'text-muted-foreground/30',
                                )}
                                title="Arbeitszeitnachweis — hours auto-computed from start/end time"
                              >
                                {value > 0 ? value.toFixed(1) : '·'}
                              </div>
                            ) : (
                              <input
                                type="number"
                                step="0.25"
                                min="0"
                                max={hoursPerDay.toString()}
                                value={value || ''}
                                placeholder="·"
                                onChange={(e) => {
                                  const raw = parseFloat(e.target.value) || 0
                                  const snapped = Math.round(raw * 4) / 4 // snap to nearest 0.25
                                  const v = Math.min(Math.max(snapped, 0), hoursPerDay)
                                  handleCellChange(row.project_id, row.work_package_id, d.dateStr, v)
                                }}
                                className={cn(
                                  'w-full h-7 text-center text-xs tabular-nums rounded border border-transparent bg-transparent outline-none transition-all',
                                  'hover:border-border hover:bg-muted/50 focus:border-primary focus:bg-primary/5 focus:ring-1 focus:ring-primary/20',
                                  value > 0 && 'font-bold',
                                )}
                              />
                            )}
                          </td>
                        )
                      })}
                      <td className="px-2 py-2 text-center bg-muted/30 border-l">
                        <div className={cn('font-bold tabular-nums text-xs', allocHours > 0 && rowTotal > allocHours + 0.5 && 'text-amber-600')}>{rowTotal.toFixed(1)}h</div>
                        <div className="text-[10px] text-muted-foreground tabular-nums">{formatPm(rowPm)}</div>
                      </td>
                    </tr>
                  )
                })}

                {/* Daily totals row */}
                <tr className="bg-muted/50 border-t-2">
                  <td className="sticky left-0 z-[1] bg-muted/50 px-3 py-2 border-r">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Daily Total</div>
                  </td>
                  {calendarDays.map(d => {
                    const total = dailyTotals[d.dateStr] || 0
                    const pct = total / hoursPerDay
                    const isOver = total > hoursPerDay
                    const isNear = pct >= 0.9 && !isOver

                    return (
                      <td key={d.dateStr} className={cn('px-0.5 py-1 text-center', d.isWeekend && 'bg-muted/30')}>
                        {!d.isWeekend && !d.isHoliday && (
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={cn('text-[10px] font-bold tabular-nums', isOver && 'text-red-500', isNear && 'text-amber-500')}>
                              {total > 0 ? total.toFixed(1) : ''}
                            </span>
                            <div className="w-5 h-1 rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn('h-full rounded-full', isOver ? 'bg-red-500' : isNear ? 'bg-amber-500' : 'bg-emerald-500')}
                                style={{ width: `${Math.min(pct * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </td>
                    )
                  })}
                  <td className="px-2 py-2 text-center bg-muted/50 border-l">
                    <div className={cn('font-bold tabular-nums text-sm', capacityPct > 100 && 'text-red-500')}>{grandTotal.toFixed(1)}h</div>
                    <div className="text-[10px] text-muted-foreground tabular-nums">
                      {formatPm(grandTotalPm)}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Arbeitszeitnachweis — time-range tracking details */}
      {projectRows.filter(r => r.isNationalProject).map(row => {
        const workingDays = calendarDays.filter(d => d.isAvailable)
        return (
          <div key={`national-${row.project_id}`} className="rounded-lg border overflow-hidden">
            <div className="bg-amber-50 dark:bg-amber-950/20 border-b px-4 py-2.5 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: row.color }} />
              <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">{row.acronym}</span>
              <span className="text-[10px] text-amber-600/70 dark:text-amber-400/50">— Arbeitszeitnachweis: daily start/end time &amp; activity description</span>
            </div>
            <div className="divide-y max-h-[400px] overflow-y-auto">
              {workingDays.map(d => {
                const cellKey = `${row.project_id}:${row.work_package_id ?? ''}:${d.dateStr}`
                const nd = nationalGrid[cellKey] ?? { start_time: '', end_time: '', description: '' }
                const hours = grid[cellKey] || 0
                const dayName = d.date.toLocaleDateString('en-US', { weekday: 'short' })
                const dateFormatted = d.date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

                return (
                  <div key={d.dateStr} className="flex items-center gap-3 px-4 py-2 hover:bg-muted/30 transition-colors">
                    <div className="min-w-[80px] text-xs">
                      <span className="font-semibold">{dayName}</span>{' '}
                      <span className="text-muted-foreground">{dateFormatted}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="time"
                        value={nd.start_time}
                        onChange={e => handleNationalCellChange(row.project_id, row.work_package_id, d.dateStr, 'start_time', e.target.value)}
                        disabled={isLocked}
                        className="h-7 w-[90px] rounded border border-input bg-background px-1.5 text-xs tabular-nums focus:ring-1 focus:ring-primary/30 focus:border-primary outline-none"
                      />
                      <span className="text-[10px] text-muted-foreground">to</span>
                      <input
                        type="time"
                        value={nd.end_time}
                        onChange={e => handleNationalCellChange(row.project_id, row.work_package_id, d.dateStr, 'end_time', e.target.value)}
                        disabled={isLocked}
                        className="h-7 w-[90px] rounded border border-input bg-background px-1.5 text-xs tabular-nums focus:ring-1 focus:ring-primary/30 focus:border-primary outline-none"
                      />
                    </div>
                    <span className={cn('text-[10px] font-bold tabular-nums min-w-[36px] text-center', hours > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground/40')}>
                      {hours > 0 ? `${hours.toFixed(1)}h` : '—'}
                    </span>
                    <input
                      type="text"
                      placeholder="Activity description (Tätigkeitsbeschreibung)..."
                      value={nd.description}
                      onChange={e => handleNationalCellChange(row.project_id, row.work_package_id, d.dateStr, 'description', e.target.value)}
                      disabled={isLocked}
                      className="flex-1 h-7 rounded border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary/30 focus:border-primary outline-none placeholder:text-muted-foreground/40"
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* Fill Month Full Dialog */}
      {fillFullOpen && (() => {
        const n = fillFullSelectedIds.length
        const totalPct = fillFullSelectedIds.reduce((s, id) => s + (fillFullPcts[id] ?? (n > 0 ? Math.round(100 / n) : 0)), 0)
        const pctValid = n > 0 && totalPct === 100

        // Compute hour preview per project
        const hourPreview = fillFullSelectedIds.map(id => {
          const pct = fillFullPcts[id] ?? Math.round(100 / n)
          const rawH = (pct / 100) * hoursPerDay
          return { id, pct, rawH, whole: Math.floor(rawH) }
        })
        let rem = hoursPerDay - hourPreview.reduce((s, r) => s + r.whole, 0)
        const sortedPreview = [...hourPreview].sort((a, b) => (b.rawH - b.whole) - (a.rawH - a.whole))
        for (const item of sortedPreview) {
          if (rem <= 0) break
          item.whole += 1
          rem -= 1
        }
        const previewMap = new Map(hourPreview.map(r => [r.id, r]))

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setFillFullOpen(false)}>
            <div className="bg-background rounded-lg border shadow-lg w-full max-w-lg mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-sm">Fill Month Full</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Select projects and set distribution percentages. {hoursPerDay}h/day × {availableDays.length} working days = {hoursPerDay * availableDays.length}h total.
                  </p>
                </div>
                <button onClick={() => setFillFullOpen(false)} className="text-muted-foreground hover:text-foreground p-1 rounded">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Project selection */}
              <div className="border rounded-lg max-h-48 overflow-y-auto divide-y">
                {allProjects.map(p => {
                  const checked = fillFullSelectedIds.includes(p.id)
                  return (
                    <label key={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          if (checked) {
                            const next = fillFullSelectedIds.filter(id => id !== p.id)
                            setFillFullSelectedIds(next)
                            // Redistribute percentages equally among remaining
                            if (next.length > 0) {
                              const eqPct = Math.round(100 / next.length)
                              const newPcts: Record<string, number> = {}
                              next.forEach((id, i) => { newPcts[id] = i === next.length - 1 ? 100 - eqPct * (next.length - 1) : eqPct })
                              setFillFullPcts(newPcts)
                            } else {
                              setFillFullPcts({})
                            }
                          } else {
                            const next = [...fillFullSelectedIds, p.id]
                            setFillFullSelectedIds(next)
                            // Distribute equally
                            const eqPct = Math.round(100 / next.length)
                            const newPcts: Record<string, number> = {}
                            next.forEach((id, i) => { newPcts[id] = i === next.length - 1 ? 100 - eqPct * (next.length - 1) : eqPct })
                            setFillFullPcts(newPcts)
                          }
                        }}
                        className="h-4 w-4 rounded border-gray-300 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{p.acronym}</div>
                        <div className="text-[11px] text-muted-foreground truncate">{p.title}</div>
                      </div>
                    </label>
                  )
                })}
              </div>

              {/* Percentage distribution */}
              {n > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Distribution</span>
                    <button
                      type="button"
                      onClick={() => {
                        const eqPct = Math.round(100 / n)
                        const newPcts: Record<string, number> = {}
                        fillFullSelectedIds.forEach((id, i) => { newPcts[id] = i === n - 1 ? 100 - eqPct * (n - 1) : eqPct })
                        setFillFullPcts(newPcts)
                      }}
                      className="text-[10px] text-primary hover:underline"
                    >
                      Reset to equal
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {fillFullSelectedIds.map(id => {
                      const proj = allProjects.find(p => p.id === id)
                      const pct = fillFullPcts[id] ?? Math.round(100 / n)
                      const preview = previewMap.get(id)
                      return (
                        <div key={id} className="flex items-center gap-2">
                          <span className="text-xs font-medium w-20 truncate shrink-0">{proj?.acronym ?? '—'}</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={pct}
                            onChange={(e) => {
                              const newVal = Number(e.target.value)
                              setFillFullPcts(prev => ({ ...prev, [id]: newVal }))
                            }}
                            className="flex-1 h-1.5 accent-primary cursor-pointer"
                          />
                          <div className="flex items-center gap-1 shrink-0">
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={pct}
                              onChange={(e) => {
                                const newVal = Math.max(0, Math.min(100, Number(e.target.value) || 0))
                                setFillFullPcts(prev => ({ ...prev, [id]: newVal }))
                              }}
                              className="w-12 h-7 text-center text-xs tabular-nums rounded border border-input bg-background"
                            />
                            <span className="text-[10px] text-muted-foreground">%</span>
                          </div>
                          <span className="text-[11px] tabular-nums font-medium w-14 text-right shrink-0">
                            {preview?.whole ?? 0}h/day
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  {/* Total indicator */}
                  <div className={cn(
                    'flex items-center justify-between rounded-md px-3 py-1.5 text-xs font-semibold border',
                    pctValid ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/20 dark:border-emerald-800 dark:text-emerald-400' : 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/20 dark:border-red-800 dark:text-red-400',
                  )}>
                    <span>Total: {totalPct}%</span>
                    <span>{hoursPerDay}h/day × {availableDays.length} days = {hoursPerDay * availableDays.length}h</span>
                  </div>
                  {!pctValid && totalPct !== 100 && (
                    <p className="text-[10px] text-red-500">Percentages must add up to 100%. Currently {totalPct}%.</p>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setFillFullOpen(false)}>Cancel</Button>
                <Button
                  size="sm"
                  onClick={handleFillMonthFull}
                  disabled={!pctValid || fillFullBusy}
                >
                  {fillFullBusy ? 'Filling...' : `Fill ${n} project${n !== 1 ? 's' : ''}`}
                </Button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Bottom hint */}
      <div className="text-[11px] text-muted-foreground">
        Hours auto-save as you type. Tab between cells to navigate. Use "Add a project" to enter hours for any project. Click <X className="inline h-3 w-3" /> to remove a project.
      </div>
    </div>
  )
}
