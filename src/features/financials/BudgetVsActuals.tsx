import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useBudgetSummary } from '@/hooks/useFinancials'
import { useProjects } from '@/hooks/useProjects'
import { SkeletonTable } from '@/components/common/SkeletonTable'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { DollarSign } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { BudgetCategory } from '@/services/financialService'

const CATEGORY_KEYS: { key: BudgetCategory; labelKey: string }[] = [
  { key: 'personnel', labelKey: 'financials.personnelBudget' },
  { key: 'travel', labelKey: 'financials.travelBudget' },
  { key: 'subcontracting', labelKey: 'financials.subcontractingBudget' },
  { key: 'other', labelKey: 'financials.otherBudget' },
  { key: 'indirect', labelKey: 'financials.indirectCosts' },
]

interface ProjectBudget {
  projectId: string
  acronym: string
  categories: Record<BudgetCategory, { budgeted: number; actual: number }>
  totalBudgeted: number
  totalActual: number
}

export function BudgetVsActuals() {
  const { t } = useTranslation()
  const { rows, isLoading: loadingBudgets, isError: budgetsError, refetch: refetchBudgets } = useBudgetSummary()
  const { projects, isLoading: loadingProjects, isError: projectsError, refetch: refetchProjects } = useProjects()
  const isLoading = loadingBudgets || loadingProjects
  const isError = budgetsError || projectsError

  const projectBudgets = useMemo(() => {
    const map = new Map<string, ProjectBudget>()

    // Init from projects
    for (const p of projects) {
      map.set(p.id, {
        projectId: p.id,
        acronym: p.acronym,
        categories: {
          personnel: { budgeted: 0, actual: 0 },
          travel: { budgeted: 0, actual: 0 },
          subcontracting: { budgeted: 0, actual: 0 },
          other: { budgeted: 0, actual: 0 },
          indirect: { budgeted: 0, actual: 0 },
        },
        totalBudgeted: 0,
        totalActual: 0,
      })
    }

    // Fill from budget data
    for (const row of rows) {
      let pb = map.get(row.project_id)
      if (!pb) {
        pb = {
          projectId: row.project_id,
          acronym: row.project_acronym,
          categories: {
            personnel: { budgeted: 0, actual: 0 },
            travel: { budgeted: 0, actual: 0 },
            subcontracting: { budgeted: 0, actual: 0 },
            other: { budgeted: 0, actual: 0 },
            indirect: { budgeted: 0, actual: 0 },
          },
          totalBudgeted: 0,
          totalActual: 0,
        }
        map.set(row.project_id, pb)
      }
      const cat = pb.categories[row.category]
      if (cat) {
        cat.budgeted += row.budgeted
        cat.actual += row.actual
      }
      pb.totalBudgeted += row.budgeted
      pb.totalActual += row.actual
    }

    return Array.from(map.values()).sort((a, b) => a.acronym.localeCompare(b.acronym))
  }, [projects, rows])

  // Grand totals
  const grandTotals = useMemo(() => {
    const totals: Record<BudgetCategory, { budgeted: number; actual: number }> = {
      personnel: { budgeted: 0, actual: 0 },
      travel: { budgeted: 0, actual: 0 },
      subcontracting: { budgeted: 0, actual: 0 },
      other: { budgeted: 0, actual: 0 },
      indirect: { budgeted: 0, actual: 0 },
    }
    let totalBudgeted = 0
    let totalActual = 0

    for (const pb of projectBudgets) {
      for (const cat of CATEGORY_KEYS) {
        totals[cat.key].budgeted += pb.categories[cat.key].budgeted
        totals[cat.key].actual += pb.categories[cat.key].actual
      }
      totalBudgeted += pb.totalBudgeted
      totalActual += pb.totalActual
    }

    return { categories: totals, totalBudgeted, totalActual }
  }, [projectBudgets])

  if (isLoading) return <SkeletonTable columns={6} rows={6} />

  if (isError) {
    return (
      <ErrorState
        onRetry={() => {
          refetchBudgets()
          refetchProjects()
        }}
      />
    )
  }

  if (projectBudgets.length === 0) {
    return (
      <EmptyState
        icon={DollarSign}
        title={t('financials.noFinancialData')}
        description={t('financials.noFinancialDataDesc')}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2.5 text-left font-medium sticky left-0 bg-muted/50">{t('common.project')}</th>
              {CATEGORY_KEYS.map((cat) => (
                <th key={cat.key} className="px-3 py-2.5 text-center font-medium border-l text-xs">{t(cat.labelKey)}</th>
              ))}
              <th className="px-4 py-2.5 text-center font-semibold border-l">{t('common.total')}</th>
            </tr>
          </thead>
          <tbody>
            {projectBudgets.map((pb, idx) => (
              <tr key={pb.projectId} className={cn('border-b last:border-0 hover:bg-muted/20', idx % 2 === 1 && 'bg-muted/[0.03]')}>
                <td className="px-4 py-2.5 font-semibold text-primary sticky left-0 bg-background">{pb.acronym}</td>
                {CATEGORY_KEYS.map((cat) => {
                  const { budgeted, actual } = pb.categories[cat.key]
                  const pct = budgeted > 0 ? Math.min((actual / budgeted) * 100, 150) : 0
                  const variance = budgeted - actual
                  return (
                    <td key={cat.key} className="px-3 py-2.5 border-l">
                      <div className="flex flex-col gap-1 min-w-[100px]">
                        <div className="flex justify-between items-baseline">
                          <span className="text-[10px] text-muted-foreground">{t('common.budget')}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{formatCurrency(budgeted)}</span>
                        </div>
                        <div className="flex justify-between items-baseline">
                          <span className="text-[10px] text-muted-foreground">{t('common.actual')}</span>
                          <span className="text-xs font-medium tabular-nums">{formatCurrency(actual)}</span>
                        </div>
                        {budgeted > 0 && (
                          <>
                            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn('h-full rounded-full transition-all', pct <= 80 ? 'bg-emerald-500' : pct <= 100 ? 'bg-amber-500' : 'bg-red-500')}
                                style={{ width: `${Math.min(pct, 100)}%` }}
                              />
                            </div>
                            <span className={cn('text-[10px] text-right tabular-nums', variance >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                              {variance >= 0 ? `${t('common.remaining')}: ` : `${t('common.over')}: `}{formatCurrency(Math.abs(variance))}
                            </span>
                          </>
                        )}
                      </div>
                    </td>
                  )
                })}
                <td className="px-4 py-2.5 border-l">
                  <div className="flex flex-col gap-1 min-w-[100px]">
                    <div className="flex justify-between items-baseline">
                      <span className="text-[10px] text-muted-foreground">{t('common.budget')}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{formatCurrency(pb.totalBudgeted)}</span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-[10px] font-semibold">{t('common.actual')}</span>
                      <span className="text-xs font-semibold tabular-nums">{formatCurrency(pb.totalActual)}</span>
                    </div>
                    {pb.totalBudgeted > 0 && (
                      <>
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn('h-full rounded-full transition-all', (pb.totalActual / pb.totalBudgeted) <= 0.8 ? 'bg-emerald-500' : (pb.totalActual / pb.totalBudgeted) <= 1 ? 'bg-amber-500' : 'bg-red-500')}
                            style={{ width: `${Math.min((pb.totalActual / pb.totalBudgeted) * 100, 100)}%` }}
                          />
                        </div>
                        <span className={cn('text-[10px] text-right tabular-nums', (pb.totalBudgeted - pb.totalActual) >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                          {(pb.totalBudgeted - pb.totalActual) >= 0 ? `${t('common.remaining')}: ` : `${t('common.over')}: `}{formatCurrency(Math.abs(pb.totalBudgeted - pb.totalActual))}
                        </span>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {/* Grand total row */}
            <tr className="border-t-2 border-primary/20 bg-muted/50 font-semibold">
              <td className="px-4 py-3 sticky left-0 bg-muted/50 text-sm">{t('financials.grandTotal')}</td>
              {CATEGORY_KEYS.map((cat) => {
                const { budgeted, actual } = grandTotals.categories[cat.key]
                return (
                  <td key={cat.key} className="px-3 py-3 border-l">
                    <div className="flex flex-col gap-0.5 min-w-[100px]">
                      <div className="flex justify-between items-baseline">
                        <span className="text-[10px]">{t('common.budget')}</span>
                        <span className="text-xs tabular-nums">{formatCurrency(budgeted)}</span>
                      </div>
                      <div className="flex justify-between items-baseline">
                        <span className="text-[10px]">{t('common.actual')}</span>
                        <span className="text-xs tabular-nums font-bold">{formatCurrency(actual)}</span>
                      </div>
                    </div>
                  </td>
                )
              })}
              <td className="px-4 py-3 border-l">
                <div className="flex flex-col gap-0.5 min-w-[100px]">
                  <div className="flex justify-between items-baseline">
                    <span className="text-[10px]">{t('common.budget')}</span>
                    <span className="text-xs tabular-nums">{formatCurrency(grandTotals.totalBudgeted)}</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-[10px]">{t('common.actual')}</span>
                    <span className="text-xs tabular-nums font-bold">{formatCurrency(grandTotals.totalActual)}</span>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-6 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2 w-6 rounded-full bg-emerald-500" /> {t('financials.under80')}</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-6 rounded-full bg-amber-500" /> {t('financials.between80and100')}</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-6 rounded-full bg-red-500" /> {t('financials.overBudget')}</span>
      </div>
    </div>
  )
}
