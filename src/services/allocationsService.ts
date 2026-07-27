import { supabase } from '@/lib/supabase'
import type { Assignment, PmBudget, PeriodLock } from '@/types'
import type { AssignmentType } from '@/types'

export interface AllocationCell {
  person_id: string
  project_id: string
  work_package_id: string | null
  year: number
  month: number
  pms: number
  type: AssignmentType
  id?: string
}

export const allocationsService = {
  // Assignments
  async listAssignments(
    orgId: string | null,
    year: number,
    type: AssignmentType,
  ): Promise<Assignment[]> {
    let query = supabase
      .from('assignments')
      .select('*')
      .eq('year', year)
      .eq('type', type)
      .order('month')

    if (orgId) query = query.eq('org_id', orgId)

    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as Assignment[]
  },

  async listAssignmentsByProject(
    projectId: string,
    year: number,
    type: AssignmentType,
  ): Promise<Assignment[]> {
    const { data, error } = await supabase
      .from('assignments')
      .select('*')
      .eq('project_id', projectId)
      .eq('year', year)
      .eq('type', type)
      .order('month')

    if (error) throw error
    return (data ?? []) as Assignment[]
  },

  async listAssignmentsByPerson(
    personId: string,
    year: number,
    type: AssignmentType,
  ): Promise<Assignment[]> {
    const { data, error } = await supabase
      .from('assignments')
      .select('*')
      .eq('person_id', personId)
      .eq('year', year)
      .eq('type', type)
      .order('month')

    if (error) throw error
    return (data ?? []) as Assignment[]
  },

  async upsertAssignment(cell: AllocationCell & { org_id: string }): Promise<Assignment> {
    // Find existing row (handles NULL work_package_id correctly)
    let query = supabase
      .from('assignments')
      .select('id')
      .eq('person_id', cell.person_id)
      .eq('project_id', cell.project_id)
      .eq('year', cell.year)
      .eq('month', cell.month)
      .eq('type', cell.type)

    if (cell.work_package_id) {
      query = query.eq('work_package_id', cell.work_package_id)
    } else {
      query = query.is('work_package_id', null)
    }

    const { data: existingRows } = await query.limit(1)

    if (existingRows && existingRows.length > 0) {
      const { data, error } = await supabase
        .from('assignments')
        .update({ pms: cell.pms, updated_at: new Date().toISOString() })
        .eq('id', existingRows[0].id)
        .select()
        .single()
      if (error) throw error
      return data as Assignment
    } else {
      const { data, error } = await supabase
        .from('assignments')
        .insert({
          org_id: cell.org_id,
          person_id: cell.person_id,
          project_id: cell.project_id,
          work_package_id: cell.work_package_id,
          year: cell.year,
          month: cell.month,
          pms: cell.pms,
          type: cell.type,
        })
        .select()
        .single()
      if (error) throw error
      return data as Assignment
    }
  },

  async bulkUpsertAssignments(
    cells: (AllocationCell & { org_id: string })[],
  ): Promise<Assignment[]> {
    if (cells.length === 0) return []

    // WHY THIS IS SPLIT IN TWO
    // ------------------------
    // PostgreSQL treats NULLs as distinct in a unique index, so a row with no
    // work package never "conflicts" with the existing row for the same
    // person/project/month. `fix_assignment_upsert.sql` worked around that by
    // replacing the plain constraint with an index on
    // COALESCE(work_package_id, ...) — but PostgREST's `on_conflict` can only
    // infer a PLAIN-column index, so the bulk save either errored with 42P10
    // ("no unique or exclusion constraint matching the ON CONFLICT
    // specification") or hit a duplicate-key violation on the expression
    // index. Either way, saving the allocation grid failed.
    //
    // Rows WITH a work package now use a partial unique index that
    // ON CONFLICT can infer. Rows WITHOUT one take an explicit
    // find-then-update path, which mirrors what timesheetService already does
    // for timesheet_days.
    const withWp = cells.filter(c => !!c.work_package_id)
    const withoutWp = cells.filter(c => !c.work_package_id)

    const results: Assignment[] = []

    if (withWp.length > 0) {
      const rows = withWp.map(c => ({
        org_id: c.org_id,
        person_id: c.person_id,
        project_id: c.project_id,
        work_package_id: c.work_package_id,
        year: c.year,
        month: c.month,
        pms: c.pms,
        type: c.type,
      }))
      const { data, error } = await supabase
        .from('assignments')
        .upsert(rows, { onConflict: 'person_id,project_id,work_package_id,year,month,type' })
        .select()
      if (error) throw error
      results.push(...((data ?? []) as Assignment[]))
    }

    for (const cell of withoutWp) {
      results.push(await allocationsService.upsertAssignment(cell))
    }

    return results
  },

  async deleteAssignment(id: string): Promise<void> {
    const { error } = await supabase.from('assignments').delete().eq('id', id)
    if (error) throw error
  },

  // PM Budgets
  async listPmBudgets(
    orgId: string | null,
    year: number,
    type: AssignmentType,
  ): Promise<PmBudget[]> {
    let query = supabase
      .from('pm_budgets')
      .select('*')
      .eq('year', year)
      .eq('type', type)

    if (orgId) query = query.eq('org_id', orgId)

    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as PmBudget[]
  },

  async listPmBudgetsByProject(
    projectId: string,
    type: AssignmentType,
  ): Promise<PmBudget[]> {
    const { data, error } = await supabase
      .from('pm_budgets')
      .select('*')
      .eq('project_id', projectId)
      .eq('type', type)
      .order('year')

    if (error) throw error
    return (data ?? []) as PmBudget[]
  },

  async upsertPmBudget(budget: {
    org_id: string
    project_id: string
    work_package_id: string | null
    year: number
    target_pms: number
    type: AssignmentType
  }): Promise<PmBudget> {
    // Handle NULL work_package_id correctly (same pattern as assignments)
    let query = supabase
      .from('pm_budgets')
      .select('id')
      .eq('project_id', budget.project_id)
      .eq('year', budget.year)
      .eq('type', budget.type)

    if (budget.work_package_id) {
      query = query.eq('work_package_id', budget.work_package_id)
    } else {
      query = query.is('work_package_id', null)
    }

    const { data: existing } = await query.limit(1)

    if (existing && existing.length > 0) {
      const { data, error } = await supabase
        .from('pm_budgets')
        .update({ target_pms: budget.target_pms, updated_at: new Date().toISOString() })
        .eq('id', existing[0].id)
        .select()
        .single()
      if (error) throw error
      return data as PmBudget
    } else {
      const { data, error } = await supabase
        .from('pm_budgets')
        .insert({ ...budget, updated_at: new Date().toISOString() })
        .select()
        .single()
      if (error) throw error
      return data as PmBudget
    }
  },

  // Period Locks
  async listPeriodLocks(orgId: string | null, year: number): Promise<PeriodLock[]> {
    let query = supabase
      .from('period_locks')
      .select('*')
      .eq('year', year)
      .order('month')

    if (orgId) query = query.eq('org_id', orgId)

    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as PeriodLock[]
  },

  async togglePeriodLock(
    orgId: string,
    year: number,
    month: number,
    userId: string,
  ): Promise<{ locked: boolean }> {
    // Check if already locked
    const { data: existing } = await supabase
      .from('period_locks')
      .select('id')
      .eq('org_id', orgId)
      .eq('year', year)
      .eq('month', month)
      .maybeSingle()

    if (existing) {
      const { error } = await supabase
        .from('period_locks')
        .delete()
        .eq('id', existing.id)
      if (error) throw error
      return { locked: false }
    } else {
      const { error } = await supabase
        .from('period_locks')
        .insert({
          org_id: orgId,
          year,
          month,
          locked_by: userId,
        })
      if (error) throw error
      return { locked: true }
    }
  },
}
