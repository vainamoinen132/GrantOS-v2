import { useMemo, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjects } from '@/hooks/useProjects'
import { useStaff } from '@/hooks/useStaff'
import { useAssignments, usePmBudgets } from '@/hooks/useAllocations'
import { useAuthStore } from '@/stores/authStore'
import { useUiStore } from '@/stores/uiStore'
import { useProposals } from '@/hooks/useProposals'
import { useCollabProjects } from '@/hooks/useCollabProjects'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils'
import { useNavigate } from 'react-router-dom'
import {
  FolderKanban,
  Users,
  CalendarDays,
  DollarSign,
  AlertTriangle,
  Lightbulb,
  Globe,
  LayoutDashboard,
} from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { SalaryCoverageChart } from './SalaryCoverageChart'
import { YearSelector } from '@/components/common/YearSelector'
import { AiQuotaWidget } from '@/components/ai/AiQuotaWidget'
import { SetupChecklist } from './SetupChecklist'
import { reportTemplateService } from '@/services/reportTemplateService'
import { ReportWidget } from '@/features/reports/ReportWidget'
import type { ReportTemplate } from '@/types'

const STATUS_COLORS: Record<string, string> = {
  Upcoming: '#3b82f6',
  Active: '#22c55e',
  Completed: '#6b7280',
  Suspended: '#ef4444',
}

export function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { orgId, can } = useAuthStore()
  const { globalYear } = useUiStore()
  const { projects, isLoading: loadingProjects, isError: projectsError, refetch: refetchProjects } = useProjects()
  const { staff, isLoading: loadingStaff, isError: staffError, refetch: refetchStaff } = useStaff({})
  const { assignments, isLoading: loadingAssignments, isError: assignmentsError, refetch: refetchAssignments } = useAssignments('actual')
  const { budgets: pmBudgets, isLoading: loadingBudgets, isError: budgetsError, refetch: refetchBudgets } = usePmBudgets('actual')

  const { proposals } = useProposals()
  const { collabProjects } = useCollabProjects()

  const isLoading = loadingProjects || loadingStaff || loadingAssignments || loadingBudgets
  const isError = projectsError || staffError || assignmentsError || budgetsError
  const retryAll = () => {
    refetchProjects()
    refetchStaff()
    refetchAssignments()
    refetchBudgets()
  }

  // Pinned report widgets
  const [pinnedReports, setPinnedReports] = useState<ReportTemplate[]>([])
  const [pinnedLoading, setPinnedLoading] = useState(true)

  const loadPinned = useCallback(async () => {
    if (!orgId) return
    setPinnedLoading(true)
    try {
      const data = await reportTemplateService.listPinned(orgId)
      setPinnedReports(data)
    } catch {
      setPinnedReports([])
    } finally {
      setPinnedLoading(false)
    }
  }, [orgId])

  useEffect(() => { loadPinned() }, [loadPinned])

  const handleToggleDashboard = useCallback(async (t: ReportTemplate) => {
    try {
      await reportTemplateService.update(t.id, { is_pinned: false })
      setPinnedReports(prev => prev.filter(p => p.id !== t.id))
    } catch { /* ignore */ }
  }, [])

  // KPI data
  const kpis = useMemo(() => {
    const activeProjects = projects.filter((p) => p.status === 'Active')
    const totalBudget = projects.reduce((sum, p) => sum + (p.total_budget ?? 0), 0)
    const activeStaff = staff.filter((s) => s.is_active)
    const totalPms = assignments.reduce((sum, a) => sum + a.pms, 0)
    const totalPlannedPms = pmBudgets.reduce((sum, b) => sum + b.target_pms, 0)

    return {
      totalProjects: projects.length,
      activeProjects: activeProjects.length,
      totalStaff: staff.length,
      activeStaff: activeStaff.length,
      totalBudget,
      totalPms: totalPms > 0 ? totalPms.toFixed(1) : totalPlannedPms.toFixed(1),
      totalPlannedPms: totalPlannedPms.toFixed(1),
      hasActualPms: totalPms > 0,
    }
  }, [projects, staff, assignments, pmBudgets])

  // Status distribution for pie chart
  const statusData = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of projects) {
      counts[p.status] = (counts[p.status] ?? 0) + 1
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }))
  }, [projects])

  // Monthly allocation bar chart
  const monthlyData = useMemo(() => {
    const months = [t('time.jan'), t('time.feb'), t('time.mar'), t('time.apr'), t('time.may'), t('time.jun'), t('time.jul'), t('time.aug'), t('time.sep'), t('time.oct'), t('time.nov'), t('time.dec')]
    const data = months.map((name) => ({
      name,
      pms: 0,
    }))
    for (const a of assignments) {
      if (a.month >= 1 && a.month <= 12) {
        data[a.month - 1].pms += a.pms
      }
    }
    return data.map((d) => ({ ...d, pms: Number(d.pms.toFixed(2)) }))
  }, [assignments])

  // Alerts
  const alerts = useMemo(() => {
    const items: { message: string; type: 'warning' | 'info' }[] = []

    const now = new Date()
    const sixMonthsFromNow = new Date(now.getFullYear(), now.getMonth() + 6, now.getDate())
    const endingSoon = projects.filter((p) => p.status === 'Active' && new Date(p.end_date) <= sixMonthsFromNow)
    if (endingSoon.length > 0) {
      items.push({
        message: t('dashboard.projectsEndingSoon', { count: endingSoon.length, names: endingSoon.map((p) => p.acronym).join(', ') }),
        type: 'warning',
      })
    }

    // Over-allocated staff
    const personTotals = new Map<string, number>()
    for (const a of assignments) {
      personTotals.set(a.person_id, (personTotals.get(a.person_id) ?? 0) + a.pms)
    }
    const overAllocated = staff.filter((s) => {
      const total = personTotals.get(s.id) ?? 0
      return total > s.fte * 12
    })
    if (overAllocated.length > 0) {
      items.push({
        message: t('dashboard.staffOverAllocated', { count: overAllocated.length }),
        type: 'warning',
      })
    }

    return items
  }, [projects, staff, assignments])

  return (
    <div className="space-y-6">
      <PageHeader title={t('dashboard.title')} description={t('dashboard.portfolioOverview', { year: globalYear })} actions={<YearSelector />} />

      {/* Surface load failures so zeroed KPIs aren't mistaken for real data */}
      {isError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{t('common.loadErrorPartial', 'Some data could not be loaded, so figures below may be incomplete.')}</span>
          </div>
          <Button variant="outline" size="sm" onClick={retryAll}>{t('common.retry', 'Try again')}</Button>
        </div>
      )}

      {/* Setup Checklist — shown for new orgs until dismissed */}
      <SetupChecklist />

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: t('dashboard.kpiProjects'), value: kpis.totalProjects, sub: t('dashboard.activeCount', { count: kpis.activeProjects }), icon: FolderKanban, color: 'text-blue-600', href: '/projects' },
          { label: t('dashboard.kpiStaff'), value: kpis.totalStaff, sub: t('dashboard.activeCount', { count: kpis.activeStaff }), icon: Users, color: 'text-emerald-600', href: '/staff' },
          ...(can('canSeeFinancialDetails') ? [{ label: t('dashboard.kpiTotalBudget'), value: formatCurrency(kpis.totalBudget), sub: t('dashboard.acrossAllProjects'), icon: DollarSign, color: 'text-amber-600', href: '/financials' }] : []),
          { label: t('dashboard.kpiPersonMonths'), value: kpis.totalPms, sub: kpis.hasActualPms ? t('dashboard.actualIn', { year: globalYear }) : t('dashboard.plannedIn', { year: globalYear }), icon: CalendarDays, color: 'text-purple-600', href: '/allocations' },
          ...(can('canSeeProposals') ? [{ label: t('dashboard.kpiProposals'), value: proposals.length, sub: t('dashboard.submittedCount', { count: proposals.filter(p => p.status === 'Submitted').length }), icon: Lightbulb, color: 'text-orange-500', href: '/proposals' }] : []),
          ...(collabProjects.length > 0 ? [{ label: t('dashboard.kpiCollaborations'), value: collabProjects.length, sub: t('dashboard.activeCount', { count: collabProjects.filter(p => p.status === 'active').length }), icon: Globe, color: 'text-sky-600', href: '/projects/collaboration' }] : []),
        ].map((kpi) => (
          <Card
            key={kpi.label}
            className="cursor-pointer transition-shadow hover:shadow-md"
            onClick={() => navigate(kpi.href)}
          >
            <CardContent className="pt-6">
              {isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">{kpi.label}</p>
                    <p className="text-2xl font-bold mt-1">{kpi.value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{kpi.sub}</p>
                  </div>
                  <div className={`rounded-lg bg-muted p-2`}>
                    <kpi.icon className={`h-5 w-5 ${kpi.color}`} />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
              <span className="text-sm text-amber-800">{alert.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Charts */}
      {!isLoading && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('dashboard.monthlyAllocations')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="pms" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('dashboard.projectStatusDistribution')}</CardTitle>
            </CardHeader>
            <CardContent>
              {statusData.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">{t('dashboard.noProjectsYet')}</p>
              ) : (
                <div className="space-y-4">
                  {/* Stacked bar */}
                  <div className="flex h-8 w-full overflow-hidden rounded-lg">
                    {statusData.map((entry) => {
                      const total = statusData.reduce((s, d) => s + d.value, 0)
                      const pct = total > 0 ? (entry.value / total) * 100 : 0
                      return (
                        <div
                          key={entry.name}
                          className="flex items-center justify-center text-xs font-semibold text-white transition-all"
                          style={{ width: `${pct}%`, backgroundColor: STATUS_COLORS[entry.name] ?? '#6b7280', minWidth: pct > 0 ? '24px' : '0' }}
                          title={`${entry.name}: ${entry.value}`}
                        >
                          {pct >= 12 ? entry.value : ''}
                        </div>
                      )
                    })}
                  </div>
                  {/* Legend */}
                  <div className="flex flex-wrap gap-4">
                    {statusData.map((entry) => (
                      <div key={entry.name} className="flex items-center gap-2">
                        <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: STATUS_COLORS[entry.name] ?? '#6b7280' }} />
                        <span className="text-sm text-muted-foreground">{entry.name}</span>
                        <span className="text-sm font-semibold">{entry.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* AI Usage + Salary Coverage */}
      {!isLoading && (
        <div className="grid gap-4 lg:grid-cols-2">
          <AiQuotaWidget variant="full" />
          {can('canSeeSalary') && <SalaryCoverageChart />}
        </div>
      )}

      {/* Project Table */}
      {!isLoading && projects.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.projectsOverview')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">{t('common.acronym')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('common.title')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('common.status')}</th>
                    {can('canSeeFinancialDetails') && <th className="px-4 py-2 text-right font-medium">{t('common.budget')}</th>}
                    <th className="px-4 py-2 text-right font-medium">{t('dashboard.pmsYear', { year: globalYear })}</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => {
                    const projectActualPms = assignments
                      .filter((a) => a.project_id === p.id)
                      .reduce((sum, a) => sum + a.pms, 0)
                    const projectPlannedPms = pmBudgets
                      .filter((b) => b.project_id === p.id)
                      .reduce((sum, b) => sum + b.target_pms, 0)
                    const projectPms = projectActualPms > 0 ? projectActualPms : projectPlannedPms
                    return (
                      <tr
                        key={p.id}
                        className="border-b last:border-0 hover:bg-muted/20 cursor-pointer"
                        onClick={() => navigate(`/projects/${p.id}`)}
                      >
                        <td className="px-4 py-2 font-semibold text-primary">{p.acronym}</td>
                        <td className="px-4 py-2 text-muted-foreground">{p.title}</td>
                        <td className="px-4 py-2"><StatusBadge status={p.status} /></td>
                        {can('canSeeFinancialDetails') && <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(p.total_budget)}</td>}
                        <td className="px-4 py-2 text-right tabular-nums">{projectPms > 0 ? projectPms.toFixed(2) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pinned Report Widgets */}
      {!pinnedLoading && pinnedReports.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Pinned Reports</h2>
            <span className="text-[10px] text-muted-foreground">({pinnedReports.length})</span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {pinnedReports.map(r => (
              <ReportWidget
                key={r.id}
                template={r}
                compact
                showDashboardToggle
                onToggleDashboard={handleToggleDashboard}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
