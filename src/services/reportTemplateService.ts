import { supabase } from '@/lib/supabase'
import type { ReportDataSource, ReportConfig, ReportTemplate } from '@/types'

// ════════════════════════════════════════════════════════════════
// Data Source Definitions — describes every reportable entity
// ════════════════════════════════════════════════════════════════

export interface ColumnDef {
  key: string
  label: string
  type: 'string' | 'number' | 'date' | 'currency' | 'percent' | 'status'
  /** If true, included by default when creating a new report for this source */
  default?: boolean
}

export interface DataSourceDef {
  key: ReportDataSource
  label: string
  description: string
  icon: string  // lucide icon name
  columns: ColumnDef[]
  groupableBy: string[]  // column keys that can be used for grouping
  filterableBy: FilterDef[]
}

export interface FilterDef {
  key: string
  label: string
  type: 'select' | 'multi-select' | 'year' | 'month' | 'date-range' | 'text'
  options?: { value: string; label: string }[]  // populated dynamically for some
}

export const DATA_SOURCES: DataSourceDef[] = [
  {
    key: 'projects',
    label: 'Projects',
    description: 'All projects with status, budget, timeline, and funding info',
    icon: 'FolderKanban',
    columns: [
      { key: 'acronym', label: 'Acronym', type: 'string', default: true },
      { key: 'title', label: 'Title', type: 'string', default: true },
      { key: 'status', label: 'Status', type: 'status', default: true },
      { key: 'start_date', label: 'Start Date', type: 'date', default: true },
      { key: 'end_date', label: 'End Date', type: 'date', default: true },
      { key: 'total_budget', label: 'Total Budget', type: 'currency', default: true },
      { key: 'budget_personnel', label: 'Personnel Budget', type: 'currency' },
      { key: 'budget_travel', label: 'Travel Budget', type: 'currency' },
      { key: 'budget_subcontracting', label: 'Subcontracting Budget', type: 'currency' },
      { key: 'budget_other', label: 'Other Budget', type: 'currency' },
      { key: 'overhead_rate', label: 'Overhead Rate', type: 'percent' },
      { key: 'grant_number', label: 'Grant Number', type: 'string' },
      { key: 'funding_scheme', label: 'Funding Scheme', type: 'string' },
      { key: 'responsible_person', label: 'Responsible Person', type: 'string' },
      { key: 'is_lead_organisation', label: 'Lead Org?', type: 'string' },
    ],
    groupableBy: ['status', 'funding_scheme'],
    filterableBy: [
      { key: 'status', label: 'Status', type: 'select', options: [
        { value: 'Upcoming', label: 'Upcoming' }, { value: 'Active', label: 'Active' },
        { value: 'Completed', label: 'Completed' }, { value: 'Suspended', label: 'Suspended' },
      ]},
    ],
  },
  {
    key: 'staff',
    label: 'Staff',
    description: 'All staff members with department, employment, and contract details',
    icon: 'Users',
    columns: [
      { key: 'full_name', label: 'Name', type: 'string', default: true },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'department', label: 'Department', type: 'string', default: true },
      { key: 'role', label: 'Role', type: 'string', default: true },
      { key: 'employment_type', label: 'Employment Type', type: 'string', default: true },
      { key: 'fte', label: 'FTE', type: 'number', default: true },
      { key: 'start_date', label: 'Start Date', type: 'date' },
      { key: 'end_date', label: 'End Date', type: 'date' },
      { key: 'annual_salary', label: 'Annual Salary', type: 'currency' },
      { key: 'country', label: 'Country', type: 'string' },
      { key: 'is_active', label: 'Active', type: 'string', default: true },
      { key: 'vacation_days_per_year', label: 'Vacation Days', type: 'number' },
    ],
    groupableBy: ['department', 'employment_type', 'is_active', 'country'],
    filterableBy: [
      { key: 'department', label: 'Department', type: 'select' },
      { key: 'employment_type', label: 'Employment Type', type: 'select', options: [
        { value: 'Full-time', label: 'Full-time' }, { value: 'Part-time', label: 'Part-time' },
        { value: 'Contractor', label: 'Contractor' },
      ]},
      { key: 'is_active', label: 'Active', type: 'select', options: [
        { value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' },
      ]},
    ],
  },
  {
    key: 'effort',
    label: 'Effort Overview',
    description: 'Person-month allocations by staff × project × month (actual vs official)',
    icon: 'CalendarDays',
    columns: [
      { key: 'person_name', label: 'Person', type: 'string', default: true },
      { key: 'department', label: 'Department', type: 'string' },
      { key: 'project_acronym', label: 'Project', type: 'string', default: true },
      { key: 'month', label: 'Month', type: 'number', default: true },
      { key: 'actual_pms', label: 'Actual PMs', type: 'number', default: true },
      { key: 'official_pms', label: 'Official PMs', type: 'number', default: true },
      { key: 'difference', label: 'Difference', type: 'number', default: true },
    ],
    groupableBy: ['person_name', 'project_acronym', 'department', 'month'],
    filterableBy: [
      { key: 'year', label: 'Year', type: 'year' },
      { key: 'project_id', label: 'Project', type: 'select' },
      { key: 'person_id', label: 'Person', type: 'select' },
    ],
  },
  {
    key: 'timesheets',
    label: 'Timesheets',
    description: 'Timesheet entries with hours, status, and approval details',
    icon: 'ClipboardCheck',
    columns: [
      { key: 'person_name', label: 'Person', type: 'string', default: true },
      { key: 'project_acronym', label: 'Project', type: 'string', default: true },
      { key: 'month', label: 'Month', type: 'number', default: true },
      { key: 'planned_hours', label: 'Planned Hours', type: 'number' },
      { key: 'actual_hours', label: 'Actual Hours', type: 'number', default: true },
      { key: 'total_hours', label: 'Total Hours', type: 'number' },
      { key: 'working_days', label: 'Working Days', type: 'number' },
      { key: 'status', label: 'Status', type: 'status', default: true },
      { key: 'submitted_at', label: 'Submitted', type: 'date' },
      { key: 'approved_at', label: 'Approved', type: 'date' },
    ],
    groupableBy: ['person_name', 'project_acronym', 'status', 'month'],
    filterableBy: [
      { key: 'year', label: 'Year', type: 'year' },
      { key: 'month', label: 'Month', type: 'month' },
      { key: 'status', label: 'Status', type: 'select', options: [
        { value: 'Draft', label: 'Draft' }, { value: 'Submitted', label: 'Submitted' },
        { value: 'Approved', label: 'Approved' }, { value: 'Rejected', label: 'Rejected' },
        { value: 'Signed', label: 'Signed' },
      ]},
      { key: 'project_id', label: 'Project', type: 'select' },
      { key: 'person_id', label: 'Person', type: 'select' },
    ],
  },
  {
    key: 'financials',
    label: 'Financials',
    description: 'Budget vs actual by project and cost category',
    icon: 'DollarSign',
    columns: [
      { key: 'project_acronym', label: 'Project', type: 'string', default: true },
      { key: 'category', label: 'Category', type: 'string', default: true },
      { key: 'budgeted', label: 'Budgeted', type: 'currency', default: true },
      { key: 'actual', label: 'Actual', type: 'currency', default: true },
      { key: 'variance', label: 'Variance', type: 'currency', default: true },
      { key: 'utilisation', label: 'Utilisation %', type: 'percent', default: true },
    ],
    groupableBy: ['project_acronym', 'category'],
    filterableBy: [
      { key: 'year', label: 'Year', type: 'year' },
      { key: 'project_id', label: 'Project', type: 'select' },
      { key: 'category', label: 'Category', type: 'select', options: [
        { value: 'personnel', label: 'Personnel' }, { value: 'travel', label: 'Travel' },
        { value: 'subcontracting', label: 'Subcontracting' }, { value: 'other', label: 'Other' },
        { value: 'indirect', label: 'Indirect' },
      ]},
    ],
  },
  {
    key: 'expenses',
    label: 'Expenses',
    description: 'Individual expense records with vendor, category, and amounts',
    icon: 'Receipt',
    columns: [
      { key: 'project_acronym', label: 'Project', type: 'string', default: true },
      { key: 'category', label: 'Category', type: 'string', default: true },
      { key: 'description', label: 'Description', type: 'string', default: true },
      { key: 'amount', label: 'Amount', type: 'currency', default: true },
      { key: 'expense_date', label: 'Date', type: 'date', default: true },
      { key: 'vendor', label: 'Vendor', type: 'string' },
      { key: 'reference', label: 'Reference', type: 'string' },
      { key: 'person_name', label: 'Recorded By', type: 'string' },
    ],
    groupableBy: ['project_acronym', 'category', 'vendor'],
    filterableBy: [
      { key: 'project_id', label: 'Project', type: 'select' },
      { key: 'category', label: 'Category', type: 'select', options: [
        { value: 'travel', label: 'Travel' }, { value: 'subcontracting', label: 'Subcontracting' },
        { value: 'other', label: 'Other' }, { value: 'indirect', label: 'Indirect' },
      ]},
    ],
  },
  {
    key: 'absences',
    label: 'Absences',
    description: 'Leave records by person, type, and status',
    icon: 'CalendarOff',
    columns: [
      { key: 'person_name', label: 'Person', type: 'string', default: true },
      { key: 'type', label: 'Type', type: 'string', default: true },
      { key: 'start_date', label: 'Start', type: 'date', default: true },
      { key: 'end_date', label: 'End', type: 'date', default: true },
      { key: 'days', label: 'Days', type: 'number', default: true },
      { key: 'status', label: 'Status', type: 'status', default: true },
      { key: 'department', label: 'Department', type: 'string' },
      { key: 'substitute_name', label: 'Substitute', type: 'string' },
    ],
    groupableBy: ['person_name', 'type', 'status', 'department'],
    filterableBy: [
      { key: 'type', label: 'Type', type: 'select', options: [
        { value: 'Annual Leave', label: 'Annual Leave' }, { value: 'Sick Leave', label: 'Sick Leave' },
        { value: 'Training', label: 'Training' }, { value: 'Public Holiday', label: 'Public Holiday' },
        { value: 'Other', label: 'Other' },
      ]},
      { key: 'status', label: 'Status', type: 'select', options: [
        { value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' },
        { value: 'rejected', label: 'Rejected' },
      ]},
      { key: 'person_id', label: 'Person', type: 'select' },
    ],
  },
  {
    key: 'travel',
    label: 'Travel',
    description: 'Travel records by person, project, and location',
    icon: 'Plane',
    columns: [
      { key: 'person_name', label: 'Person', type: 'string', default: true },
      { key: 'project_acronym', label: 'Project', type: 'string', default: true },
      { key: 'date', label: 'Date', type: 'date', default: true },
      { key: 'location', label: 'Location', type: 'string', default: true },
      { key: 'notes', label: 'Notes', type: 'string' },
    ],
    groupableBy: ['person_name', 'project_acronym', 'location'],
    filterableBy: [
      { key: 'project_id', label: 'Project', type: 'select' },
      { key: 'person_id', label: 'Person', type: 'select' },
    ],
  },
  {
    key: 'proposals',
    label: 'Proposals',
    description: 'Proposal pipeline with budgets, status, and deadlines',
    icon: 'Lightbulb',
    columns: [
      { key: 'project_name', label: 'Project Name', type: 'string', default: true },
      { key: 'call_identifier', label: 'Call', type: 'string', default: true },
      { key: 'funding_scheme', label: 'Funding Scheme', type: 'string' },
      { key: 'status', label: 'Status', type: 'status', default: true },
      { key: 'our_pms', label: 'Our PMs', type: 'number', default: true },
      { key: 'total_budget', label: 'Total Budget', type: 'currency', default: true },
      { key: 'personnel_budget', label: 'Personnel Budget', type: 'currency' },
      { key: 'travel_budget', label: 'Travel Budget', type: 'currency' },
      { key: 'submission_deadline', label: 'Deadline', type: 'date', default: true },
      { key: 'responsible_person', label: 'Responsible', type: 'string' },
    ],
    groupableBy: ['status', 'funding_scheme'],
    filterableBy: [
      { key: 'status', label: 'Status', type: 'select', options: [
        { value: 'In Preparation', label: 'In Preparation' }, { value: 'Submitted', label: 'Submitted' },
        { value: 'Granted', label: 'Granted' }, { value: 'Rejected', label: 'Rejected' },
      ]},
    ],
  },
  {
    key: 'project_health',
    label: 'Project Health',
    description: 'Cross-entity view: project + budget utilisation + effort + deliverables',
    icon: 'Activity',
    columns: [
      { key: 'acronym', label: 'Project', type: 'string', default: true },
      { key: 'status', label: 'Status', type: 'status', default: true },
      { key: 'total_budget', label: 'Budget', type: 'currency', default: true },
      { key: 'total_spent', label: 'Spent', type: 'currency', default: true },
      { key: 'budget_utilisation', label: 'Budget %', type: 'percent', default: true },
      { key: 'total_pms_actual', label: 'Actual PMs', type: 'number', default: true },
      { key: 'total_pms_official', label: 'Official PMs', type: 'number' },
      { key: 'deliverables_count', label: 'Deliverables', type: 'number', default: true },
      { key: 'milestones_count', label: 'Milestones', type: 'number' },
      { key: 'days_remaining', label: 'Days Left', type: 'number', default: true },
    ],
    groupableBy: ['status'],
    filterableBy: [
      { key: 'status', label: 'Status', type: 'select', options: [
        { value: 'Upcoming', label: 'Upcoming' }, { value: 'Active', label: 'Active' },
        { value: 'Completed', label: 'Completed' }, { value: 'Suspended', label: 'Suspended' },
      ]},
      { key: 'year', label: 'Year', type: 'year' },
    ],
  },
]

export function getDataSource(key: ReportDataSource): DataSourceDef | undefined {
  return DATA_SOURCES.find(ds => ds.key === key)
}

export function getDefaultColumns(source: ReportDataSource): string[] {
  const ds = getDataSource(source)
  if (!ds) return []
  return ds.columns.filter(c => c.default).map(c => c.key)
}

// ════════════════════════════════════════════════════════════════
// Data Fetching Engine — runs a report config against the DB
// ════════════════════════════════════════════════════════════════

export type ReportRow = Record<string, unknown>

export async function executeReport(
  orgId: string,
  year: number,
  source: ReportDataSource,
  config: ReportConfig,
): Promise<ReportRow[]> {
  let rows: ReportRow[] = []

  switch (source) {
    case 'projects':
      rows = await fetchProjects(orgId, config)
      break
    case 'staff':
      rows = await fetchStaff(orgId, config)
      break
    case 'effort':
      rows = await fetchEffort(orgId, year, config)
      break
    case 'timesheets':
      rows = await fetchTimesheets(orgId, year, config)
      break
    case 'financials':
      rows = await fetchFinancials(orgId, year, config)
      break
    case 'expenses':
      rows = await fetchExpenses(orgId, config)
      break
    case 'absences':
      rows = await fetchAbsences(orgId, config)
      break
    case 'travel':
      rows = await fetchTravel(orgId, config)
      break
    case 'proposals':
      rows = await fetchProposals(orgId, config)
      break
    case 'project_health':
      rows = await fetchProjectHealth(orgId, year, config)
      break
  }

  // Apply sorting
  if (config.sort_by) {
    const { field, direction } = config.sort_by
    rows.sort((a, b) => {
      const va = a[field] ?? ''
      const vb = b[field] ?? ''
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb))
      return direction === 'desc' ? -cmp : cmp
    })
  }

  return rows
}

// ── Individual data source fetchers ──

async function fetchProjects(orgId: string, config: ReportConfig): Promise<ReportRow[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*, funding_schemes(name), persons!projects_responsible_person_id_fkey(full_name)')
    .eq('org_id', orgId)
    .order('acronym')
  if (error) throw error
  let rows = (data ?? []).map((p: any) => ({
    acronym: p.acronym,
    title: p.title,
    status: p.status,
    start_date: p.start_date,
    end_date: p.end_date,
    total_budget: p.total_budget ?? 0,
    budget_personnel: p.budget_personnel ?? 0,
    budget_travel: p.budget_travel ?? 0,
    budget_subcontracting: p.budget_subcontracting ?? 0,
    budget_other: p.budget_other ?? 0,
    overhead_rate: p.overhead_rate ?? 0,
    grant_number: p.grant_number ?? '',
    funding_scheme: p.funding_schemes?.name ?? '',
    responsible_person: p.persons?.full_name ?? '',
    is_lead_organisation: p.is_lead_organisation ? 'Yes' : 'No',
  }))
  if (config.filters.status) rows = rows.filter(r => r.status === config.filters.status)
  return rows
}

async function fetchStaff(orgId: string, config: ReportConfig): Promise<ReportRow[]> {
  // persons_secure returns annual_salary only when the caller has the
  // can_see_salary permission; otherwise it comes back NULL.
  const { data, error } = await (supabase as any)
    .from('persons_secure')
    .select('*')
    .eq('org_id', orgId)
    .order('full_name')
  if (error) throw error
  let rows = (data ?? []).map((p: any) => ({
    full_name: p.full_name,
    email: p.email ?? '',
    department: p.department ?? '',
    role: p.role ?? '',
    employment_type: p.employment_type,
    fte: p.fte,
    start_date: p.start_date ?? '',
    end_date: p.end_date ?? '',
    annual_salary: p.annual_salary ?? 0,
    country: p.country ?? '',
    is_active: p.is_active ? 'Yes' : 'No',
    vacation_days_per_year: p.vacation_days_per_year ?? 0,
  }))
  if (config.filters.department) rows = rows.filter((r: ReportRow) => r.department === config.filters.department)
  if (config.filters.employment_type) rows = rows.filter((r: ReportRow) => r.employment_type === config.filters.employment_type)
  if (config.filters.is_active) rows = rows.filter((r: ReportRow) => r.is_active === (config.filters.is_active === 'true' ? 'Yes' : 'No'))
  return rows
}

async function fetchEffort(orgId: string, year: number, config: ReportConfig): Promise<ReportRow[]> {
  const y = (config.filters.year as number) || year
  const { data: actuals, error: e1 } = await supabase
    .from('assignments')
    .select('person_id, project_id, month, pms, persons(full_name, department), projects(acronym)')
    .eq('org_id', orgId)
    .eq('year', y)
    .eq('type', 'actual')
  if (e1) throw e1
  const { data: officials, error: e2 } = await supabase
    .from('assignments')
    .select('person_id, project_id, month, pms')
    .eq('org_id', orgId)
    .eq('year', y)
    .eq('type', 'official')
  if (e2) throw e2

  const officialMap = new Map<string, number>()
  for (const o of (officials ?? [])) {
    officialMap.set(`${o.person_id}:${o.project_id}:${o.month}`, (o as any).pms)
  }

  let rows: ReportRow[] = (actuals ?? []).map((a: any) => {
    const key = `${a.person_id}:${a.project_id}:${a.month}`
    const officialPms = officialMap.get(key) ?? 0
    return {
      person_name: a.persons?.full_name ?? '',
      department: a.persons?.department ?? '',
      project_acronym: a.projects?.acronym ?? '',
      month: a.month,
      actual_pms: a.pms,
      official_pms: officialPms,
      difference: a.pms - officialPms,
    }
  })
  if (config.filters.project_id) rows = rows.filter(r => r.project_acronym === config.filters.project_id)
  if (config.filters.person_id) rows = rows.filter(r => r.person_name === config.filters.person_id)
  return rows
}

async function fetchTimesheets(orgId: string, year: number, config: ReportConfig): Promise<ReportRow[]> {
  const y = (config.filters.year as number) || year
  let q = supabase
    .from('timesheet_entries')
    .select('*, persons(full_name), projects(acronym)')
    .eq('org_id', orgId)
    .eq('year', y)
    .order('month')
  if (config.filters.month) q = q.eq('month', Number(config.filters.month))
  if (config.filters.status) q = q.eq('status', String(config.filters.status))
  if (config.filters.project_id) q = q.eq('project_id', String(config.filters.project_id))
  if (config.filters.person_id) q = q.eq('person_id', String(config.filters.person_id))

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((t: any) => ({
    person_name: t.persons?.full_name ?? '',
    project_acronym: t.projects?.acronym ?? '',
    month: t.month,
    planned_hours: t.planned_hours ?? 0,
    actual_hours: t.actual_hours ?? 0,
    total_hours: t.total_hours ?? 0,
    working_days: t.working_days ?? 0,
    status: t.status,
    submitted_at: t.submitted_at ?? '',
    approved_at: t.approved_at ?? '',
  }))
}

async function fetchFinancials(orgId: string, year: number, config: ReportConfig): Promise<ReportRow[]> {
  const y = (config.filters.year as number) || year
  let q = supabase
    .from('financial_budgets')
    .select('*, projects(acronym)')
    .eq('org_id', orgId)
    .eq('year', y)
  if (config.filters.project_id) q = q.eq('project_id', String(config.filters.project_id))
  if (config.filters.category) q = q.eq('category', String(config.filters.category))

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((b: any) => ({
    project_acronym: b.projects?.acronym ?? '',
    category: (b.category as string).charAt(0).toUpperCase() + (b.category as string).slice(1),
    budgeted: b.budgeted ?? 0,
    actual: b.actual ?? 0,
    variance: (b.budgeted ?? 0) - (b.actual ?? 0),
    utilisation: b.budgeted > 0 ? ((b.actual / b.budgeted) * 100) : 0,
  }))
}

async function fetchExpenses(orgId: string, config: ReportConfig): Promise<ReportRow[]> {
  let q = supabase
    .from('project_expenses')
    .select('*, projects(acronym), persons(full_name)')
    .eq('org_id', orgId)
    .order('expense_date', { ascending: false })
  if (config.filters.project_id) q = q.eq('project_id', String(config.filters.project_id))
  if (config.filters.category) q = q.eq('category', String(config.filters.category))

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((e: any) => ({
    project_acronym: e.projects?.acronym ?? '',
    category: (e.category as string).charAt(0).toUpperCase() + (e.category as string).slice(1),
    description: e.description ?? '',
    amount: e.amount ?? 0,
    expense_date: e.expense_date ?? '',
    vendor: e.vendor ?? '',
    reference: e.reference ?? '',
    person_name: e.persons?.full_name ?? '',
  }))
}

async function fetchAbsences(orgId: string, config: ReportConfig): Promise<ReportRow[]> {
  let q = supabase
    .from('absences')
    .select('*, persons!absences_person_id_fkey(full_name, department), substitute:persons!absences_substitute_person_id_fkey(full_name)')
    .eq('org_id', orgId)
    .order('start_date', { ascending: false })
  if (config.filters.type) q = q.eq('type', String(config.filters.type))
  if (config.filters.status) q = q.eq('status', String(config.filters.status))
  if (config.filters.person_id) q = q.eq('person_id', String(config.filters.person_id))

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((a: any) => ({
    person_name: a.persons?.full_name ?? '',
    type: a.type,
    start_date: a.start_date ?? a.date ?? '',
    end_date: a.end_date ?? a.date ?? '',
    days: a.days ?? 1,
    status: a.status,
    department: a.persons?.department ?? '',
    substitute_name: a.substitute?.full_name ?? '',
  }))
}

async function fetchTravel(orgId: string, config: ReportConfig): Promise<ReportRow[]> {
  let q = (supabase as any)
    .from('travels')
    .select('*, persons(full_name), projects(acronym)')
    .eq('org_id', orgId)
    .order('date', { ascending: false })
  if (config.filters.project_id) q = q.eq('project_id', String(config.filters.project_id))
  if (config.filters.person_id) q = q.eq('person_id', String(config.filters.person_id))

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((t: any) => ({
    person_name: t.persons?.full_name ?? '',
    project_acronym: t.projects?.acronym ?? '',
    date: t.date,
    location: t.location,
    notes: t.notes ?? '',
  }))
}

async function fetchProposals(orgId: string, config: ReportConfig): Promise<ReportRow[]> {
  const { data, error } = await supabase
    .from('proposals')
    .select('*, persons(full_name)')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
  if (error) throw error
  let rows = (data ?? []).map((p: any) => ({
    project_name: p.project_name,
    call_identifier: p.call_identifier ?? '',
    funding_scheme: p.funding_scheme ?? '',
    status: p.status,
    our_pms: p.our_pms ?? 0,
    total_budget: (p.personnel_budget ?? 0) + (p.travel_budget ?? 0) + (p.subcontracting_budget ?? 0) + (p.other_budget ?? 0),
    personnel_budget: p.personnel_budget ?? 0,
    travel_budget: p.travel_budget ?? 0,
    submission_deadline: p.submission_deadline ?? '',
    responsible_person: p.persons?.full_name ?? '',
  }))
  if (config.filters.status) rows = rows.filter(r => r.status === config.filters.status)
  return rows
}

async function fetchProjectHealth(orgId: string, year: number, config: ReportConfig): Promise<ReportRow[]> {
  const y = (config.filters.year as number) || year
  // Fetch all needed data in parallel
  const [projectsRes, budgetsRes, assignmentsActRes, assignmentsOffRes, deliverablesRes, milestonesRes] = await Promise.all([
    supabase.from('projects').select('id, acronym, status, total_budget, start_date, end_date').eq('org_id', orgId),
    supabase.from('financial_budgets').select('project_id, actual').eq('org_id', orgId).eq('year', y),
    supabase.from('assignments').select('project_id, pms').eq('org_id', orgId).eq('year', y).eq('type', 'actual'),
    supabase.from('assignments').select('project_id, pms').eq('org_id', orgId).eq('year', y).eq('type', 'official'),
    (supabase as any).from('deliverables').select('project_id').eq('org_id', orgId),
    (supabase as any).from('milestones').select('project_id').eq('org_id', orgId),
  ])
  if (projectsRes.error) throw projectsRes.error

  const projects = projectsRes.data ?? []
  const budgets = budgetsRes.data ?? []
  const actualsArr = assignmentsActRes.data ?? []
  const officialsArr = assignmentsOffRes.data ?? []
  const delivs = deliverablesRes.data ?? []
  const miles = milestonesRes.data ?? []

  // Aggregate
  const spentByProject = new Map<string, number>()
  for (const b of budgets) spentByProject.set(b.project_id, (spentByProject.get(b.project_id) ?? 0) + ((b as any).actual ?? 0))
  const actualPmsByProject = new Map<string, number>()
  for (const a of actualsArr) actualPmsByProject.set((a as any).project_id, (actualPmsByProject.get((a as any).project_id) ?? 0) + ((a as any).pms ?? 0))
  const officialPmsByProject = new Map<string, number>()
  for (const a of officialsArr) officialPmsByProject.set((a as any).project_id, (officialPmsByProject.get((a as any).project_id) ?? 0) + ((a as any).pms ?? 0))
  const delivCount = new Map<string, number>()
  for (const d of delivs) delivCount.set((d as any).project_id, (delivCount.get((d as any).project_id) ?? 0) + 1)
  const mileCount = new Map<string, number>()
  for (const m of miles) mileCount.set((m as any).project_id, (mileCount.get((m as any).project_id) ?? 0) + 1)

  let rows: ReportRow[] = projects.map((p: any) => {
    const spent = spentByProject.get(p.id) ?? 0
    const budget = p.total_budget ?? 0
    const daysLeft = p.end_date ? Math.max(0, Math.ceil((new Date(p.end_date).getTime() - Date.now()) / 86400000)) : 0
    return {
      acronym: p.acronym,
      status: p.status,
      total_budget: budget,
      total_spent: spent,
      budget_utilisation: budget > 0 ? (spent / budget) * 100 : 0,
      total_pms_actual: actualPmsByProject.get(p.id) ?? 0,
      total_pms_official: officialPmsByProject.get(p.id) ?? 0,
      deliverables_count: delivCount.get(p.id) ?? 0,
      milestones_count: mileCount.get(p.id) ?? 0,
      days_remaining: daysLeft,
    }
  })
  if (config.filters.status) rows = rows.filter(r => r.status === config.filters.status)
  return rows
}

// ════════════════════════════════════════════════════════════════
// 10 System Default Report Templates
// ════════════════════════════════════════════════════════════════

export interface SystemReportDef {
  name: string
  description: string
  data_source: ReportDataSource
  config: ReportConfig
}

export const SYSTEM_REPORT_TEMPLATES: SystemReportDef[] = [
  {
    name: 'Project Portfolio Overview',
    description: 'All projects with status, budget, and timeline — grouped by status',
    data_source: 'projects',
    config: {
      columns: ['acronym', 'title', 'status', 'total_budget', 'start_date', 'end_date', 'funding_scheme'],
      filters: {},
      group_by: 'status',
      sort_by: { field: 'acronym', direction: 'asc' },
      chart_type: 'bar',
    },
  },
  {
    name: 'Budget vs Actuals',
    description: 'Financial budget utilisation across all projects by category',
    data_source: 'financials',
    config: {
      columns: ['project_acronym', 'category', 'budgeted', 'actual', 'variance', 'utilisation'],
      filters: {},
      group_by: 'project_acronym',
      sort_by: { field: 'variance', direction: 'desc' },
      chart_type: 'bar',
    },
  },
  {
    name: 'Staff Directory',
    description: 'Complete staff list with department, FTE, and employment status',
    data_source: 'staff',
    config: {
      columns: ['full_name', 'department', 'role', 'employment_type', 'fte', 'is_active'],
      filters: {},
      group_by: 'department',
      sort_by: { field: 'full_name', direction: 'asc' },
      chart_type: 'pie',
    },
  },
  {
    name: 'Monthly Effort Allocation',
    description: 'Person-month allocations by staff and project for the current year',
    data_source: 'effort',
    config: {
      columns: ['person_name', 'project_acronym', 'month', 'actual_pms', 'official_pms', 'difference'],
      filters: {},
      group_by: 'person_name',
      sort_by: { field: 'month', direction: 'asc' },
      chart_type: 'bar',
    },
  },
  {
    name: 'Timesheet Status Tracker',
    description: 'Timesheet submission and approval status across all staff',
    data_source: 'timesheets',
    config: {
      columns: ['person_name', 'project_acronym', 'month', 'actual_hours', 'status'],
      filters: {},
      group_by: 'status',
      sort_by: { field: 'month', direction: 'asc' },
      chart_type: 'pie',
    },
  },
  {
    name: 'Absence Summary',
    description: 'All leave records grouped by type — annual leave, sick leave, etc.',
    data_source: 'absences',
    config: {
      columns: ['person_name', 'type', 'start_date', 'end_date', 'days', 'status'],
      filters: {},
      group_by: 'type',
      sort_by: { field: 'start_date', direction: 'desc' },
      chart_type: 'pie',
    },
  },
  {
    name: 'Expense Breakdown',
    description: 'All recorded expenses by project and category',
    data_source: 'expenses',
    config: {
      columns: ['project_acronym', 'category', 'description', 'amount', 'expense_date'],
      filters: {},
      group_by: 'category',
      sort_by: { field: 'amount', direction: 'desc' },
      chart_type: 'bar',
    },
  },
  {
    name: 'Travel Log',
    description: 'Travel records by person and project',
    data_source: 'travel',
    config: {
      columns: ['person_name', 'project_acronym', 'date', 'location', 'notes'],
      filters: {},
      group_by: 'project_acronym',
      sort_by: { field: 'date', direction: 'desc' },
      chart_type: 'table',
    },
  },
  {
    name: 'Proposal Pipeline',
    description: 'All proposals with status, budget, and deadlines',
    data_source: 'proposals',
    config: {
      columns: ['project_name', 'call_identifier', 'status', 'total_budget', 'our_pms', 'submission_deadline'],
      filters: {},
      group_by: 'status',
      sort_by: { field: 'submission_deadline', direction: 'asc' },
      chart_type: 'pie',
    },
  },
  {
    name: 'Project Health Dashboard',
    description: 'Cross-entity view showing budget utilisation, effort, and progress per project',
    data_source: 'project_health',
    config: {
      columns: ['acronym', 'status', 'total_budget', 'total_spent', 'budget_utilisation', 'total_pms_actual', 'deliverables_count', 'days_remaining'],
      filters: {},
      group_by: 'status',
      sort_by: { field: 'budget_utilisation', direction: 'desc' },
      chart_type: 'bar',
    },
  },
]

/**
 * Seeds the 10 system default reports for an org if none exist yet.
 * Called on first load of the reports page. Idempotent — checks first.
 */
export async function seedSystemTemplates(orgId: string, userId: string, _userName?: string): Promise<boolean> {
  // Check if this org already has system-seeded templates
  const { data: existing, error: checkErr } = await supabase
    .from('report_templates')
    .select('id')
    .eq('org_id', orgId)
    .eq('created_by_name', '__system__')
    .limit(1)
  if (checkErr) throw checkErr
  if (existing && existing.length > 0) return false // already seeded

  // Seed all 10
  const inserts = SYSTEM_REPORT_TEMPLATES.map(t => ({
    org_id: orgId,
    name: t.name,
    description: t.description,
    data_source: t.data_source,
    config: t.config as any,
    is_shared: true,
    is_pinned: false,
    created_by: userId,
    created_by_name: '__system__',
  }))
  const { error } = await supabase.from('report_templates').insert(inserts)
  if (error) throw error
  return true // seeded
}

// ════════════════════════════════════════════════════════════════
// Template CRUD
// ════════════════════════════════════════════════════════════════

export const reportTemplateService = {
  async list(orgId: string): Promise<ReportTemplate[]> {
    const { data, error } = await supabase
      .from('report_templates')
      .select('*')
      .eq('org_id', orgId)
      .order('updated_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map(parseTemplate)
  },

  async create(template: {
    org_id: string
    name: string
    description?: string
    data_source: ReportDataSource
    config: ReportConfig
    is_shared: boolean
    created_by: string
    created_by_name: string
  }): Promise<ReportTemplate> {
    const { data, error } = await supabase
      .from('report_templates')
      .insert({
        org_id: template.org_id,
        name: template.name,
        description: template.description ?? null,
        data_source: template.data_source,
        config: template.config as any,
        is_shared: template.is_shared,
        created_by: template.created_by,
        created_by_name: template.created_by_name,
      })
      .select()
      .single()
    if (error) throw error
    return parseTemplate(data)
  },

  async update(id: string, updates: Partial<{
    name: string
    description: string | null
    data_source: ReportDataSource
    config: ReportConfig
    is_shared: boolean
    is_pinned: boolean
  }>): Promise<ReportTemplate> {
    const { data, error } = await supabase
      .from('report_templates')
      .update({ ...updates, config: updates.config as any, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return parseTemplate(data)
  },

  async remove(id: string): Promise<void> {
    const { error } = await supabase
      .from('report_templates')
      .delete()
      .eq('id', id)
    if (error) throw error
  },

  async listPinned(orgId: string): Promise<ReportTemplate[]> {
    const { data, error } = await supabase
      .from('report_templates')
      .select('*')
      .eq('org_id', orgId)
      .eq('is_pinned', true)
      .order('name')
    if (error) throw error
    return (data ?? []).map(parseTemplate)
  },
}

function parseTemplate(row: any): ReportTemplate {
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
  }
}
