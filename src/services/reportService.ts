import { supabase } from '@/lib/supabase'
import * as XLSX from 'xlsx'
import {
  generateProjectSummaryPDF,
  generateFinancialReportPDF,
  generateTimesheetReportPDF,
} from './reportGenerator'
import type { Project, Person, TimesheetEntry } from '@/types'

export type ReportType =
  | 'project_summary'
  | 'staff_allocations'
  | 'timesheet_summary'
  | 'budget_overview'
  | 'absence_summary'

interface ReportConfig {
  label: string
  description: string
}

export const REPORT_TYPES: Record<ReportType, ReportConfig> = {
  project_summary: {
    label: 'Project Summary',
    description: 'Overview of all projects with status, budget, and timeline',
  },
  staff_allocations: {
    label: 'Staff Allocations',
    description: 'Person-month allocations per staff member per project',
  },
  timesheet_summary: {
    label: 'Timesheet Summary',
    description: 'Timesheet status overview across all staff and projects',
  },
  budget_overview: {
    label: 'Budget Overview',
    description: 'Budget vs actuals across all projects and categories',
  },
  absence_summary: {
    label: 'Absence Summary',
    description: 'Staff absence days by type and person',
  },
}

async function fetchReportData(
  orgId: string,
  year: number,
  type: ReportType,
): Promise<{ headers: string[]; rows: (string | number)[][] }> {
  switch (type) {
    case 'project_summary': {
      const { data, error } = await supabase
        .from('projects')
        .select('acronym, title, status, start_date, end_date, total_budget')
        .eq('org_id', orgId)
        .order('acronym')
      if (error) throw error
      return {
        headers: ['Acronym', 'Title', 'Status', 'Start', 'End', 'Budget'],
        rows: (data ?? []).map((p) => [
          p.acronym, p.title, p.status, p.start_date, p.end_date, p.total_budget ?? 0,
        ]),
      }
    }
    case 'staff_allocations': {
      const { data, error } = await supabase
        .from('assignments')
        .select('pms, month, persons(full_name), projects(acronym)')
        .eq('org_id', orgId)
        .eq('year', year)
        .eq('type', 'actual')
        .order('month')
      if (error) throw error
      return {
        headers: ['Person', 'Project', 'Month', 'PMs'],
        rows: (data ?? []).map((a: any) => [
          a.persons?.full_name ?? '', a.projects?.acronym ?? '', a.month, a.pms,
        ]),
      }
    }
    case 'timesheet_summary': {
      const { data, error } = await supabase
        .from('timesheet_entries')
        .select('month, status, planned_hours, actual_hours, working_days, persons(full_name), projects(acronym)')
        .eq('org_id', orgId)
        .eq('year', year)
        .order('month')
      if (error) throw error
      return {
        headers: ['Person', 'Project', 'Month', 'Planned Hours', 'Actual Hours', 'Status'],
        rows: (data ?? []).map((t: any) => [
          t.persons?.full_name ?? '', t.projects?.acronym ?? '', t.month,
          t.planned_hours ?? '', t.actual_hours ?? '', t.status,
        ]),
      }
    }
    case 'budget_overview': {
      const { data, error } = await supabase
        .from('financial_budgets')
        .select('category, budgeted, actual, projects(acronym)')
        .eq('org_id', orgId)
        .eq('year', year)
      if (error) throw error
      return {
        headers: ['Project', 'Category', 'Budgeted', 'Actual', 'Variance'],
        rows: (data ?? []).map((b: any) => [
          b.projects?.acronym ?? '', b.category, b.budgeted, b.actual, b.budgeted - b.actual,
        ]),
      }
    }
    case 'absence_summary': {
      const { data, error } = await supabase
        .from('absences')
        .select('type, days, start_date, end_date, persons!absences_person_id_fkey(full_name)')
        .eq('org_id', orgId)
      if (error) throw error
      return {
        headers: ['Person', 'Type', 'Start', 'End', 'Days'],
        rows: (data ?? []).map((a: any) => [
          a.persons?.full_name ?? '', a.type, a.start_date ?? '', a.end_date ?? '', a.days ?? 0,
        ]),
      }
    }
    default:
      return { headers: [], rows: [] }
  }
}

export const reportService = {
  async generateExcel(orgId: string, year: number, type: ReportType): Promise<void> {
    const { headers, rows } = await fetchReportData(orgId, year, type)
    const wsData = [headers, ...rows]
    const ws = XLSX.utils.aoa_to_sheet(wsData)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, REPORT_TYPES[type].label)
    XLSX.writeFile(wb, `${type}_${year}.xlsx`)
  },

  async generatePdf(orgId: string, year: number, type: ReportType): Promise<void> {
    // Fetch org name for report header
    const { data: org } = await supabase
      .from('organisations')
      .select('name')
      .eq('id', orgId)
      .single()
    const orgName = (org as any)?.name ?? ''

    switch (type) {
      case 'project_summary': {
        const { data: projects } = await supabase
          .from('projects')
          .select('*, funding_schemes(*)')
          .eq('org_id', orgId)
          .order('acronym')
        const { data: staff } = await supabase
          .from('persons_secure')
          .select('*')
          .eq('org_id', orgId)
        const { data: assignments } = await supabase
          .from('assignments')
          .select('person_id, pms')
          .eq('org_id', orgId)
          .eq('year', year)
          .eq('type', 'actual')

        const proj = (projects ?? [])[0] as Project | undefined
        if (proj) {
          generateProjectSummaryPDF(
            proj,
            (staff ?? []) as Person[],
            (assignments ?? []) as { person_id: string; pms: number }[],
            orgName,
          )
        }
        break
      }
      case 'budget_overview': {
        const { data: projects } = await supabase
          .from('projects')
          .select('*')
          .eq('org_id', orgId)
          .order('acronym')
        const { data: expenses } = await supabase
          .from('project_expenses')
          .select('project_id, category, amount, description, expense_date')
          .eq('org_id', orgId)

        generateFinancialReportPDF(
          (projects ?? []) as Project[],
          (expenses ?? []).map((e: any) => ({ project_id: e.project_id, category: e.category, amount: e.amount, description: e.description ?? '', date: e.expense_date ?? '' })),
          orgName,
        )
        break
      }
      case 'timesheet_summary': {
        const { data: entries } = await supabase
          .from('timesheet_entries')
          .select('*')
          .eq('org_id', orgId)
          .eq('year', year)
        const { data: staff } = await supabase
          .from('persons_secure')
          .select('*')
          .eq('org_id', orgId)
        const { data: projects } = await supabase
          .from('projects')
          .select('*')
          .eq('org_id', orgId)

        generateTimesheetReportPDF(
          (entries ?? []) as TimesheetEntry[],
          (staff ?? []) as Person[],
          (projects ?? []) as Project[],
          year,
          orgName,
        )
        break
      }
      default: {
        // Fallback: use the generic table approach for staff_allocations and absence_summary
        const { headers, rows } = await fetchReportData(orgId, year, type)
        const jsPDF = (await import('jspdf')).default
        const doc = new jsPDF({ orientation: 'landscape' })

        doc.setFontSize(16)
        doc.text(`${REPORT_TYPES[type].label} — ${year}`, 14, 20)
        doc.setFontSize(10)

        let y = 35
        const colWidth = (doc.internal.pageSize.getWidth() - 28) / headers.length

        doc.setFont('helvetica', 'bold')
        headers.forEach((h, i) => {
          doc.text(String(h), 14 + i * colWidth, y)
        })
        doc.setFont('helvetica', 'normal')
        y += 8

        for (const row of rows) {
          if (y > doc.internal.pageSize.getHeight() - 20) {
            doc.addPage()
            y = 20
          }
          row.forEach((cell, i) => {
            doc.text(String(cell ?? ''), 14 + i * colWidth, y)
          })
          y += 6
        }

        doc.save(`${type}_${year}.pdf`)
        break
      }
    }
  },
}
