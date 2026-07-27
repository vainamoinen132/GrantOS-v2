import { supabase } from '@/lib/supabase'
import { emailService } from './emailService'
import { notificationService } from './notificationService'
import { timesheetApproverService } from './timesheetApproverService'
import { memberDirectory } from './memberDirectoryService'
import type { TimesheetEntry, TimesheetStatus, TimesheetDay } from '@/types'
import { hoursToPm } from '@/lib/pmUtils'

// Cast for new table not yet in generated DB types
const tsDays = () => (supabase as any).from('timesheet_days')

export interface TimesheetFilters {
  person_id?: string
  project_id?: string
  year?: number
  month?: number
  status?: TimesheetStatus
}

/** Count weekday (Mon-Fri) dates in a given month/year */
export function getWorkingDays(year: number, month: number): number {
  let count = 0
  const daysInMonth = new Date(year, month, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay()
    if (dow !== 0 && dow !== 6) count++
  }
  return count
}

/** Get all weekday Date objects in a month */
export function getWeekdayDates(year: number, month: number): Date[] {
  const dates: Date[] = []
  const daysInMonth = new Date(year, month, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d)
    const dow = date.getDay()
    if (dow !== 0 && dow !== 6) dates.push(date)
  }
  return dates
}

/** Format a Date to YYYY-MM-DD string */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const SELECT_WITH_JOINS = '*, persons(full_name, fte), projects(acronym, title)'

export const timesheetService = {
  // ───────────────────────────────────────────────
  // Monthly envelope (timesheet_entries) — approval flow
  // ───────────────────────────────────────────────

  async listEnvelopes(orgId: string | null, filters?: TimesheetFilters): Promise<TimesheetEntry[]> {
    let query = supabase
      .from('timesheet_entries')
      .select(SELECT_WITH_JOINS)
      .order('month')

    if (orgId) query = query.eq('org_id', orgId)
    if (filters?.person_id) query = query.eq('person_id', filters.person_id)
    if (filters?.year) query = query.eq('year', filters.year)
    if (filters?.month) query = query.eq('month', filters.month)
    if (filters?.status) query = query.eq('status', filters.status)

    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as unknown as TimesheetEntry[]
  },

  /** Ensure a monthly envelope exists for a person+month. Returns it. */
  async ensureEnvelope(
    orgId: string,
    personId: string,
    year: number,
    month: number,
  ): Promise<TimesheetEntry> {
    // Try to find existing
    const { data: existing } = await supabase
      .from('timesheet_entries')
      .select('*')
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('year', year)
      .eq('month', month)
      .maybeSingle()

    if (existing) return existing as unknown as TimesheetEntry

    // Create new
    const { data, error } = await supabase
      .from('timesheet_entries')
      .insert({
        org_id: orgId,
        person_id: personId,
        year,
        month,
        status: 'Draft',
        working_days: getWorkingDays(year, month),
        total_hours: 0,
      } as any)
      .select('*')
      .single()

    if (error) throw error
    return data as unknown as TimesheetEntry
  },

  /** Recompute total_hours on the envelope from timesheet_days */
  async refreshEnvelopeTotals(
    orgId: string,
    personId: string,
    year: number,
    month: number,
  ): Promise<void> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const { data: dayRows, error: dErr } = await tsDays()
      .select('hours')
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .gte('date', startDate)
      .lte('date', endDate)

    if (dErr) throw dErr

    const totalHours = (dayRows ?? []).reduce((s: number, r: any) => s + (Number(r.hours) || 0), 0)

    const { error } = await supabase
      .from('timesheet_entries')
      .update({ total_hours: totalHours, updated_at: new Date().toISOString() } as any)
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('year', year)
      .eq('month', month)

    if (error) throw error
  },

  async submit(orgId: string, personId: string, year: number, month: number, userId: string): Promise<void> {
    // Ensure envelope, refresh totals, then mark Submitted
    await timesheetService.ensureEnvelope(orgId, personId, year, month)
    await timesheetService.refreshEnvelopeTotals(orgId, personId, year, month)

    const { error } = await supabase
      .from('timesheet_entries')
      .update({
        status: 'Submitted',
        submitted_at: new Date().toISOString(),
        submitted_by: userId,
        updated_at: new Date().toISOString(),
      } as any)
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('year', year)
      .eq('month', month)

    if (error) throw error

    // Fire-and-forget: notify admins/approvers.
    //
    // This used to call supabase.auth.admin.getUserById() from the browser.
    // That is a service-role-only API, so every call 403'd and the
    // "timesheet submitted" email was never actually sent to anyone. Resolve
    // the addresses through the server endpoint instead.
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const period = `${MONTHS[month - 1]} ${year}`
    void (async () => {
      try {
        const { data: person } = await supabase
          .from('persons')
          .select('full_name')
          .eq('id', personId)
          .single()
        const submitterName = (person as any)?.full_name ?? 'A team member'

        const { data: admins } = await supabase
          .from('org_members')
          .select('user_id')
          .eq('org_id', orgId)
          .in('role', ['Admin', 'Finance Officer'])

        const recipientIds = (admins ?? [])
          .map((a: { user_id: string }) => a.user_id)
          .filter((id: string) => id !== userId)
        if (recipientIds.length === 0) return

        const emails = await memberDirectory.resolveEmails(orgId, recipientIds)
        for (const email of Object.values(emails)) {
          await emailService.sendTimesheetSubmitted({
            to: email,
            approverName: email.split('@')[0],
            submitterName,
            orgName: '',
            period,
            timesheetUrl: `${typeof window !== 'undefined' ? window.location.origin : ''}/timesheets`,
          })
        }
      } catch (err) {
        console.warn('[GrantLume] Failed to send timesheet-submitted emails:', err)
      }
    })()

    // Fire-and-forget: in-app notifications for admins AND timesheet approvers
    const MONTHS2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const period2 = `${MONTHS2[month - 1]} ${year}`
    Promise.resolve(
      supabase
        .from('persons')
        .select('full_name, department')
        .eq('id', personId)
        .single()
    ).then(({ data: person2 }) => {
      const name = (person2 as any)?.full_name ?? 'A team member'
      const dept = (person2 as any)?.department ?? null

      // Notify admins
      notificationService.getAdminUserIds(orgId).then((adminIds) => {
        notificationService.notifyMany({
          orgId,
          userIds: adminIds.filter((id) => id !== userId),
          type: 'approval',
          title: 'Timesheet submitted',
          message: `${name} submitted their timesheet for ${period2}.`,
          link: '/timesheets',
        }).catch(() => {})
      }).catch(() => {})

      // Notify timesheet approvers (may overlap with admins, that's fine)
      timesheetApproverService.getApproversForPerson(orgId, dept).then((approvers) => {
        const approverUserIds = approvers.map(a => a.user_id).filter(Boolean) as string[]
        if (approverUserIds.length > 0) {
          notificationService.notifyMany({
            orgId,
            userIds: approverUserIds.filter(id => id !== userId),
            type: 'approval',
            title: 'Timesheet awaiting your approval',
            message: `${name} submitted their timesheet for ${period2}. Please review and approve.`,
            link: '/timesheets',
          }).catch(() => {})
        }
        // Email approvers
        const appUrl = typeof window !== 'undefined' ? window.location.origin : ''
        for (const approver of approvers) {
          const email = approver.person?.email
          if (email) {
            emailService.sendTimesheetSubmitted({
              to: email,
              approverName: approver.person?.full_name ?? email.split('@')[0],
              submitterName: name,
              orgName: '',
              period: period2,
              timesheetUrl: `${appUrl}/timesheets`,
            }).catch(() => {})
          }
        }
      }).catch(() => {})
    }).catch(() => {})
  },

  async updateEnvelopeStatus(
    orgId: string,
    personId: string,
    year: number,
    month: number,
    status: TimesheetStatus,
    userId: string,
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    }
    if (status === 'Approved') {
      updates.approved_at = new Date().toISOString()
      updates.approved_by = userId
    }

    const { error } = await supabase
      .from('timesheet_entries')
      .update(updates as any)
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('year', year)
      .eq('month', month)

    if (error) throw error

    // Fire-and-forget: notify the employee on approve/reject
    if (status === 'Approved' || status === 'Rejected') {
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
      const period = `${MONTHS[month - 1]} ${year}`
      const appUrl = typeof window !== 'undefined' ? window.location.origin : ''

      Promise.resolve(supabase.from('persons').select('full_name, email, user_id').eq('id', personId).single())
      .then(({ data: person }) => {
        const personName = (person as any)?.full_name ?? 'Team member'
        const personEmail = (person as any)?.email
        const personUserId = (person as any)?.user_id
        const approverName = 'Your manager' // Best effort

        // In-app notification to the employee
        if (personUserId) {
          notificationService.notify({
            orgId,
            userId: personUserId,
            type: status === 'Approved' ? 'success' : 'warning',
            title: status === 'Approved' ? 'Timesheet approved' : 'Timesheet rejected',
            message: `Your timesheet for ${period} has been ${status.toLowerCase()}.`,
            link: '/timesheets',
          }).catch(() => {})
        }

        // Email notification
        if (personEmail) {
          if (status === 'Approved') {
            emailService.sendTimesheetApproved({
              to: personEmail,
              personName,
              period,
              approverName,
              timesheetUrl: `${appUrl}/timesheets`,
            }).catch(() => {})
          } else {
            emailService.sendTimesheetRejected({
              to: personEmail,
              personName,
              period,
              approverName,
              timesheetUrl: `${appUrl}/timesheets`,
            }).catch(() => {})
          }
        }
      }).catch(() => {})
    }
  },

  // ───────────────────────────────────────────────
  // Daily entries (timesheet_days)
  // ───────────────────────────────────────────────

  /** Load all daily entries for a person in a given month */
  async listDays(
    orgId: string,
    personId: string,
    year: number,
    month: number,
  ): Promise<TimesheetDay[]> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const { data, error } = await tsDays()
      .select('*, projects(acronym, title)')
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date')

    if (error) throw error
    return (data ?? []) as TimesheetDay[]
  },

  /** Upsert a single day entry. If hours = 0, delete it. */
  async upsertDay(
    orgId: string,
    personId: string,
    projectId: string,
    workPackageId: string | null,
    date: string,
    hours: number,
    extra?: { start_time?: string | null; end_time?: string | null; description?: string | null },
  ): Promise<void> {
    if (hours <= 0) {
      // Delete instead
      let query = tsDays()
        .delete()
        .eq('org_id', orgId)
        .eq('person_id', personId)
        .eq('project_id', projectId)
        .eq('date', date)

      if (workPackageId) {
        query = query.eq('work_package_id', workPackageId)
      } else {
        query = query.is('work_package_id', null)
      }

      const { error } = await query
      if (error) throw error
      return
    }

    // Build the extra fields for national projects
    const extraFields: Record<string, unknown> = {}
    if (extra?.start_time !== undefined) extraFields.start_time = extra.start_time
    if (extra?.end_time !== undefined) extraFields.end_time = extra.end_time
    if (extra?.description !== undefined) extraFields.description = extra.description

    // Try to find existing
    let findQuery = tsDays()
      .select('id')
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('project_id', projectId)
      .eq('date', date)

    if (workPackageId) {
      findQuery = findQuery.eq('work_package_id', workPackageId)
    } else {
      findQuery = findQuery.is('work_package_id', null)
    }

    const { data: existing } = await findQuery.limit(1)

    if (existing && existing.length > 0) {
      const { error } = await tsDays()
        .update({ hours, ...extraFields, updated_at: new Date().toISOString() })
        .eq('id', existing[0].id)
      if (error) throw error
    } else {
      const { error } = await tsDays()
        .insert({
          org_id: orgId,
          person_id: personId,
          project_id: projectId,
          work_package_id: workPackageId,
          date,
          hours,
          ...extraFields,
        })
      if (error) throw error
    }
  },

  /** Bulk upsert multiple day entries at once (for auto-fill, copy month, etc.) */
  async bulkUpsertDays(
    entries: {
      org_id: string
      person_id: string
      project_id: string
      work_package_id: string | null
      date: string
      hours: number
    }[],
  ): Promise<number> {
    if (entries.length === 0) return 0

    // Separate zero-hour (delete) from non-zero (upsert). Within each
    // group, batch by NULL vs non-NULL work_package_id so each resulting
    // statement is atomic (Supabase upsert/delete on an array is a single
    // SQL statement → all-or-nothing under the period-lock trigger).
    const toDelete = entries.filter(e => e.hours <= 0)
    const toUpsert = entries.filter(e => e.hours > 0)

    // DELETE for zero-hour entries, split by NULL-ness of wp_id.
    const deleteWithWp = toDelete.filter(e => !!e.work_package_id)
    const deleteNullWp = toDelete.filter(e => !e.work_package_id)
    if (deleteWithWp.length > 0) {
      // Group by (org, person, project, wp_id) and list dates to minimise statements.
      for (const e of deleteWithWp) {
        const { error } = await tsDays()
          .delete()
          .eq('org_id', e.org_id)
          .eq('person_id', e.person_id)
          .eq('project_id', e.project_id)
          .eq('work_package_id', e.work_package_id!)
          .eq('date', e.date)
        if (error) throw error
      }
    }
    if (deleteNullWp.length > 0) {
      for (const e of deleteNullWp) {
        const { error } = await tsDays()
          .delete()
          .eq('org_id', e.org_id)
          .eq('person_id', e.person_id)
          .eq('project_id', e.project_id)
          .is('work_package_id', null)
          .eq('date', e.date)
        if (error) throw error
      }
    }

    // UPSERT non-zero entries — one atomic statement per NULL-ness bucket.
    const upsertWithWp = toUpsert.filter(e => !!e.work_package_id)
    const upsertNullWp = toUpsert.filter(e => !e.work_package_id)
    if (upsertWithWp.length > 0) {
      const { error } = await tsDays().upsert(
        upsertWithWp.map(e => ({
          org_id: e.org_id,
          person_id: e.person_id,
          project_id: e.project_id,
          work_package_id: e.work_package_id,
          date: e.date,
          hours: e.hours,
        })),
        { onConflict: 'org_id,person_id,project_id,work_package_id,date' },
      )
      if (error) throw error
    }
    if (upsertNullWp.length > 0) {
      // For null work_package_id rows, we can't use onConflict on a nullable
      // column safely; fall back to serialized upserts but abort on first
      // failure (the period-lock trigger still guards correctness).
      for (const e of upsertNullWp) {
        await timesheetService.upsertDay(
          e.org_id, e.person_id, e.project_id, null, e.date, e.hours,
        )
      }
    }

    return toUpsert.length
  },

  /** Delete all daily entries for a person in a month (for a specific project, or all) */
  async clearDays(
    orgId: string,
    personId: string,
    year: number,
    month: number,
    projectId?: string,
  ): Promise<void> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    let query = tsDays()
      .delete()
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .gte('date', startDate)
      .lte('date', endDate)

    if (projectId) query = query.eq('project_id', projectId)

    const { error } = await query
    if (error) throw error
  },

  // ───────────────────────────────────────────────
  // Smart features
  // ───────────────────────────────────────────────

  /**
   * Auto-fill from allocations: distributes each project's allocated hours
   * evenly across available working days (minus holidays & absences).
   * Only fills days that don't already have entries for that project.
   */
  async autoFillFromPlan(
    orgId: string,
    personId: string,
    year: number,
    month: number,
    availableDates: string[], // pre-computed: weekdays minus holidays minus absences
    hoursPerDay: number,
  ): Promise<{ filled: number }> {
    // 1. Get allocations for this person & month
    const { data: assignments, error: aErr } = await supabase
      .from('assignments')
      .select('project_id, work_package_id, pms')
      .eq('org_id', orgId)
      .eq('person_id', personId)
      .eq('year', year)
      .eq('month', month)
      .eq('type', 'actual')

    if (aErr) throw aErr
    if (!assignments || assignments.length === 0) {
      throw new Error('No allocations found for this person in this period.')
    }

    // 2. Get existing day entries for this person & month
    const existingDays = await timesheetService.listDays(orgId, personId, year, month)
    const existingSet = new Set(
      existingDays.map(d => `${d.project_id}:${d.work_package_id ?? ''}:${d.date}`),
    )

    // 3. For each allocation, distribute hours across available dates
    const toInsert: {
      org_id: string; person_id: string; project_id: string;
      work_package_id: string | null; date: string; hours: number
    }[] = []

    for (const a of assignments) {
      const totalAllocHours = a.pms * availableDates.length * hoursPerDay
      const dailyHours = Math.round((totalAllocHours / availableDates.length) * 4) / 4 // round to 0.25

      for (const dateStr of availableDates) {
        const key = `${a.project_id}:${a.work_package_id ?? ''}:${dateStr}`
        if (existingSet.has(key)) continue // don't overwrite existing entries

        toInsert.push({
          org_id: orgId,
          person_id: personId,
          project_id: a.project_id,
          work_package_id: a.work_package_id,
          date: dateStr,
          hours: dailyHours,
        })
      }
    }

    if (toInsert.length > 0) {
      await timesheetService.bulkUpsertDays(toInsert)
    }

    // Ensure envelope exists
    await timesheetService.ensureEnvelope(orgId, personId, year, month)
    await timesheetService.refreshEnvelopeTotals(orgId, personId, year, month)

    return { filled: toInsert.length }
  },

  /**
   * Copy daily pattern from a previous month.
   * Takes the previous month's day entries and maps them onto the target month's
   * available dates (same weekday pattern where possible, or just fill sequentially).
   */
  async copyPreviousMonth(
    orgId: string,
    personId: string,
    year: number,
    month: number,
    availableDates: string[],
  ): Promise<{ copied: number }> {
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year

    const prevDays = await timesheetService.listDays(orgId, personId, prevYear, prevMonth)
    if (prevDays.length === 0) {
      throw new Error('No timesheet data found in the previous month to copy.')
    }

    // Group by project+wp, get their daily pattern
    const projectMap = new Map<string, { project_id: string; work_package_id: string | null; hours: number[] }>()
    for (const d of prevDays) {
      const key = `${d.project_id}:${d.work_package_id ?? ''}`
      if (!projectMap.has(key)) {
        projectMap.set(key, { project_id: d.project_id, work_package_id: d.work_package_id, hours: [] })
      }
      projectMap.get(key)!.hours.push(d.hours)
    }

    // For each project, compute average daily hours and apply to available dates
    const toInsert: {
      org_id: string; person_id: string; project_id: string;
      work_package_id: string | null; date: string; hours: number
    }[] = []

    for (const [, proj] of projectMap) {
      const avgHours = Math.round((proj.hours.reduce((a, b) => a + b, 0) / proj.hours.length) * 4) / 4

      for (const dateStr of availableDates) {
        toInsert.push({
          org_id: orgId,
          person_id: personId,
          project_id: proj.project_id,
          work_package_id: proj.work_package_id,
          date: dateStr,
          hours: avgHours,
        })
      }
    }

    // Clear current month first, then bulk insert (fast single query)
    await timesheetService.clearDays(orgId, personId, year, month)

    if (toInsert.length > 0) {
      // Batch insert in chunks of 50 for reliability
      const BATCH = 50
      for (let i = 0; i < toInsert.length; i += BATCH) {
        const batch = toInsert.slice(i, i + BATCH)
        const { error } = await tsDays().insert(batch)
        if (error) throw error
      }
    }

    await timesheetService.ensureEnvelope(orgId, personId, year, month)
    await timesheetService.refreshEnvelopeTotals(orgId, personId, year, month)

    return { copied: toInsert.length }
  },

  // ───────────────────────────────────────────────
  // Approval → Actuals sync
  // ───────────────────────────────────────────────

  /**
   * When a timesheet month is approved, compute actual PMs per project
   * from daily hours and upsert into the assignments table as 'actual' type.
   * Formula: PM = totalProjectHours / (availableWorkingDays × hoursPerDay)
   */
  async syncApprovedToActuals(
    orgId: string,
    personId: string,
    year: number,
    month: number,
    hoursPerDay: number,
    availableDayCount: number,
  ): Promise<{ synced: number }> {
    const { allocationsService } = await import('@/services/allocationsService')

    // Load all daily entries for this person & month
    const days = await timesheetService.listDays(orgId, personId, year, month)

    // Group by project+wp → total hours
    const projMap = new Map<string, { project_id: string; work_package_id: string | null; totalHours: number }>()
    for (const d of days) {
      const key = `${d.project_id}:${d.work_package_id ?? ''}`
      if (!projMap.has(key)) {
        projMap.set(key, { project_id: d.project_id, work_package_id: d.work_package_id, totalHours: 0 })
      }
      projMap.get(key)!.totalHours += d.hours
    }

    // Compute PMs using canonical formula and upsert into assignments as 'actual'
    const cells = Array.from(projMap.values()).map(p => {
      const pms = hoursToPm(p.totalHours, availableDayCount, hoursPerDay)
      return {
        org_id: orgId,
        person_id: personId,
        project_id: p.project_id,
        work_package_id: p.work_package_id,
        year,
        month,
        pms,
        type: 'actual' as const,
      }
    })

    if (cells.length > 0) {
      await allocationsService.bulkUpsertAssignments(cells)
    }

    return { synced: cells.length }
  },

  // ───────────────────────────────────────────────
  // Aggregated hours for allocation sync
  // ───────────────────────────────────────────────

  /**
   * Get total timesheet hours per person+project+wp+month for an entire year.
   * Used by AllocationGrid when "timesheets drive allocations" is ON.
   */
  async aggregateHoursByYear(
    orgId: string,
    year: number,
  ): Promise<{ person_id: string; project_id: string; work_package_id: string | null; month: number; totalHours: number }[]> {
    const startDate = `${year}-01-01`
    const endDate = `${year}-12-31`

    const { data, error } = await tsDays()
      .select('person_id, project_id, work_package_id, date, hours')
      .eq('org_id', orgId)
      .gte('date', startDate)
      .lte('date', endDate)

    if (error) throw error
    if (!data || data.length === 0) return []

    // Group by person+project+wp+month
    const map = new Map<string, { person_id: string; project_id: string; work_package_id: string | null; month: number; totalHours: number }>()
    for (const d of data as any[]) {
      const month = parseInt(d.date.substring(5, 7), 10)
      const key = `${d.person_id}:${d.project_id}:${d.work_package_id ?? ''}:${month}`
      if (!map.has(key)) {
        map.set(key, { person_id: d.person_id, project_id: d.project_id, work_package_id: d.work_package_id ?? null, month, totalHours: 0 })
      }
      map.get(key)!.totalHours += d.hours
    }

    return Array.from(map.values())
  },

  // ───────────────────────────────────────────────
  // Legacy compatibility (keep old list method working)
  // ───────────────────────────────────────────────

  async list(orgId: string | null, filters?: TimesheetFilters): Promise<TimesheetEntry[]> {
    return timesheetService.listEnvelopes(orgId, filters)
  },

  async bulkUpdateStatus(
    ids: string[],
    status: TimesheetStatus,
    userId: string,
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    }
    if (status === 'Submitted') {
      updates.submitted_at = new Date().toISOString()
      updates.submitted_by = userId
    } else if (status === 'Approved') {
      updates.approved_at = new Date().toISOString()
      updates.approved_by = userId
    }

    const { error } = await supabase
      .from('timesheet_entries')
      .update(updates as any)
      .in('id', ids)

    if (error) throw error

    // Fire-and-forget: notify employees when their timesheet is approved/rejected
    if (status === 'Approved' || status === 'Rejected') {
      Promise.resolve(
        supabase.from('timesheet_entries').select('person_id, year, month').in('id', ids)
      ).then(({ data: entries }) => {
        if (!entries || entries.length === 0) return
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        // Get approver name
        supabase.auth.getUser().then(({ data: authData }) => {
          const approverName = authData?.user?.user_metadata?.first_name
            ? `${authData.user.user_metadata.first_name} ${authData.user.user_metadata.last_name || ''}`.trim()
            : authData?.user?.email?.split('@')[0] ?? 'An admin'

          // Deduplicate by person
          const seen = new Set<string>()
          for (const e of entries as any[]) {
            const key = `${e.person_id}:${e.year}:${e.month}`
            if (seen.has(key)) continue
            seen.add(key)
            const period = `${MONTHS[(e.month as number) - 1]} ${e.year}`
            // Get person email
            Promise.resolve(
              supabase.from('persons').select('full_name, email').eq('id', e.person_id).single()
            ).then(({ data: person }) => {
              if (!person?.email) return
              const origin = typeof window !== 'undefined' ? window.location.origin : 'https://app.grantlume.com'
              const params = {
                personName: (person as any).full_name ?? person.email.split('@')[0],
                period,
                approverName,
                timesheetUrl: `${origin}/timesheets`,
              }
              if (status === 'Approved') {
                emailService.sendTimesheetApproved({ to: person.email, ...params })
              } else {
                emailService.sendTimesheetRejected({ to: person.email, ...params })
              }
            }).catch(() => {})
          }
        }).catch(() => {})
      }).catch(() => {})
    }
  },

  async remove(id: string): Promise<void> {
    const { error } = await supabase
      .from('timesheet_entries')
      .delete()
      .eq('id', id)
    if (error) throw error
  },
}
