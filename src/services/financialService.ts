import { supabase } from '@/lib/supabase'
import type { FinancialBudget, Project } from '@/types'

export type BudgetCategory = 'personnel' | 'travel' | 'subcontracting' | 'other' | 'indirect'

const ALL_CATEGORIES: BudgetCategory[] = ['personnel', 'travel', 'subcontracting', 'other', 'indirect']

export interface BudgetRow {
  project_id: string
  project_acronym: string
  category: BudgetCategory
  budgeted: number
  actual: number
  year: number
}

/**
 * Aggregate personnel cost per project for a year.
 *
 * This used to embed `persons(annual_salary)` in an assignments query, pulling
 * every individual salary into the browser for anyone who could reach the
 * financials screen. SELECT on that column is now revoked; the database
 * computes the aggregate instead and refuses callers without the
 * financial-details permission.
 */
async function fetchPersonnelTotals(
  orgId: string,
  year: number,
  type: 'actual' | 'official' = 'actual',
): Promise<Map<string, number>> {
  const { data, error } = await (supabase as any).rpc('get_personnel_costs', {
    p_org_id: orgId,
    p_year: year,
    p_type: type,
  })

  if (error) throw error

  const totals = new Map<string, number>()
  for (const row of (data ?? []) as { project_id: string; total_cost: number | null }[]) {
    totals.set(row.project_id, Number(row.total_cost ?? 0))
  }
  return totals
}

export const financialService = {
  async listBudgets(orgId: string | null, year: number): Promise<FinancialBudget[]> {
    let query = supabase
      .from('financial_budgets')
      .select('*, projects(acronym, title)')
      .eq('year', year)

    if (orgId) query = query.eq('org_id', orgId)

    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as FinancialBudget[]
  },

  async upsertBudget(budget: {
    org_id: string
    project_id: string
    category: BudgetCategory
    year: number
    budgeted: number
    actual: number
  }): Promise<FinancialBudget> {
    const { data, error } = await supabase
      .from('financial_budgets')
      .upsert(
        { ...budget, updated_at: new Date().toISOString() },
        { onConflict: 'project_id,category,year' },
      )
      .select('*, projects(acronym, title)')
      .single()

    if (error) throw error
    return data as FinancialBudget
  },

  async updateActual(id: string, actual: number): Promise<void> {
    const { error } = await supabase
      .from('financial_budgets')
      .update({ actual, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  },

  /**
   * Seed financial_budgets rows from project budget fields.
   * For each active project, creates one row per category per year
   * if it doesn't already exist. Distributes the project's total
   * category budget evenly across the project's active years.
   */
  async seedFromProjects(
    orgId: string,
    projects: Project[],
    year: number,
  ): Promise<{ created: number; updated: number }> {
    // Fetch existing budget rows for this year
    const existing = await financialService.listBudgets(orgId, year)
    const existingSet = new Set(
      existing.map((b) => `${b.project_id}:${b.category}`),
    )

    const toInsert: {
      org_id: string
      project_id: string
      category: BudgetCategory
      year: number
      budgeted: number
      actual: number
    }[] = []

    const toUpdate: { id: string; budgeted: number }[] = []

    for (const p of projects) {
      // Only seed projects that span this year
      const pStart = new Date(p.start_date).getFullYear()
      const pEnd = new Date(p.end_date).getFullYear()
      if (year < pStart || year > pEnd) continue

      const projectYears = pEnd - pStart + 1

      const categoryBudgets: Record<BudgetCategory, number> = {
        personnel: (p.budget_personnel ?? 0) / projectYears,
        travel: (p.budget_travel ?? 0) / projectYears,
        subcontracting: (p.budget_subcontracting ?? 0) / projectYears,
        other: (p.budget_other ?? 0) / projectYears,
        indirect: ((p.total_budget ?? 0) * (p.overhead_rate ?? 0) / 100) / projectYears,
      }

      for (const cat of ALL_CATEGORIES) {
        const key = `${p.id}:${cat}`
        const budgeted = Math.round(categoryBudgets[cat] * 100) / 100

        if (!existingSet.has(key)) {
          toInsert.push({
            org_id: orgId,
            project_id: p.id,
            category: cat,
            year,
            budgeted,
            actual: 0,
          })
        } else {
          // Update budgeted amount if project budget changed
          const ex = existing.find((b) => b.project_id === p.id && b.category === cat)
          if (ex && Math.abs(ex.budgeted - budgeted) > 0.01) {
            toUpdate.push({ id: ex.id, budgeted })
          }
        }
      }
    }

    let created = 0
    let updated = 0

    if (toInsert.length > 0) {
      const { error } = await supabase.from('financial_budgets').insert(toInsert)
      if (error) throw error
      created = toInsert.length
    }

    for (const u of toUpdate) {
      const { error } = await supabase
        .from('financial_budgets')
        .update({ budgeted: u.budgeted, updated_at: new Date().toISOString() })
        .eq('id', u.id)
      if (error) throw error
      updated++
    }

    return { created, updated }
  },

  /**
   * Compute personnel actuals from assignments × person salaries
   * and write them into the financial_budgets 'personnel' rows.
   */
  async syncPersonnelActuals(orgId: string, year: number): Promise<number> {
    // 1. Compute actuals server-side (salaries never reach the browser)
    const totals = await fetchPersonnelTotals(orgId, year, 'actual')

    // 2. Fetch existing personnel budget rows
    const { data: budgetRows, error: bErr } = await supabase
      .from('financial_budgets')
      .select('id, project_id, actual')
      .eq('org_id', orgId)
      .eq('year', year)
      .eq('category', 'personnel')

    if (bErr) throw bErr

    let synced = 0
    for (const row of budgetRows ?? []) {
      const computed = Math.round((totals.get(row.project_id) ?? 0) * 100) / 100
      if (Math.abs(row.actual - computed) > 0.01) {
        const { error: uErr } = await supabase
          .from('financial_budgets')
          .update({ actual: computed, updated_at: new Date().toISOString() })
          .eq('id', row.id)
        if (uErr) throw uErr
        synced++
      }
    }

    return synced
  },

  async computePersonnelActuals(
    orgId: string,
    year: number,
  ): Promise<{ project_id: string; total: number }[]> {
    const totals = await fetchPersonnelTotals(orgId, year, 'actual')
    return Array.from(totals.entries()).map(([project_id, total]) => ({ project_id, total }))
  },

  /**
   * Sync non-personnel actuals from project_expenses into financial_budgets.
   * Sums expenses by project × category × year and updates the actual column.
   */
  async syncExpenseActuals(orgId: string, year: number): Promise<number> {
    // 1. Get expense totals per project per category for this year
    const yearStart = `${year}-01-01`
    const yearEnd = `${year}-12-31`

    const { data: expenses, error: eErr } = await supabase
      .from('project_expenses')
      .select('project_id, category, amount')
      .eq('org_id', orgId)
      .gte('expense_date', yearStart)
      .lte('expense_date', yearEnd)

    if (eErr) throw eErr

    const totals = new Map<string, number>()
    for (const row of expenses ?? []) {
      const key = `${row.project_id}:${row.category}`
      totals.set(key, (totals.get(key) ?? 0) + Number(row.amount))
    }

    // 2. Fetch existing budget rows for non-personnel categories
    const { data: budgetRows, error: bErr } = await supabase
      .from('financial_budgets')
      .select('id, project_id, category, actual')
      .eq('org_id', orgId)
      .eq('year', year)
      .in('category', ['travel', 'subcontracting', 'other', 'indirect'])

    if (bErr) throw bErr

    let synced = 0
    for (const row of budgetRows ?? []) {
      const key = `${row.project_id}:${row.category}`
      const computed = Math.round((totals.get(key) ?? 0) * 100) / 100
      if (Math.abs(row.actual - computed) > 0.01) {
        const { error: uErr } = await supabase
          .from('financial_budgets')
          .update({ actual: computed, updated_at: new Date().toISOString() })
          .eq('id', row.id)
        if (uErr) throw uErr
        synced++
      }
    }

    return synced
  },

  async getProjectBudgetSummary(
    orgId: string | null,
    year: number,
  ): Promise<BudgetRow[]> {
    const budgets = await financialService.listBudgets(orgId, year)
    return budgets.map((b) => ({
      project_id: b.project_id,
      project_acronym: (b as any).projects?.acronym ?? '?',
      category: b.category as BudgetCategory,
      budgeted: b.budgeted,
      actual: b.actual,
      year: b.year,
    }))
  },
}
