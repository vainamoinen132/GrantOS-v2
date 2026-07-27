import { describe, it, expect } from 'vitest'
import {
  computePermissions,
  rolePermissionToPermissions,
  DEFAULT_PERMISSIONS,
  ROUTE_PERMISSIONS,
} from './permissions'
import type { RolePermission } from '@/types'

describe('computePermissions', () => {
  it('Admin has all permissions', () => {
    const p = computePermissions('Admin')
    expect(p.canSeeDashboard).toBe(true)
    expect(p.canSeeProjects).toBe(true)
    expect(p.canSeeStaff).toBe(true)
    expect(p.canSeeAllocations).toBe(true)
    expect(p.canSeeTimesheets).toBe(true)
    expect(p.canSeeAbsences).toBe(true)
    expect(p.canSeeFinancials).toBe(true)
    expect(p.canSeeTimeline).toBe(true)
    expect(p.canSeeReports).toBe(true)
    expect(p.canSeeImport).toBe(true)
    expect(p.canSeeAudit).toBe(true)
    expect(p.canSeeSalary).toBe(true)
    expect(p.canSeeFinancialDetails).toBe(true)
    expect(p.canSeePersonnelRates).toBe(true)
    expect(p.canManageProjects).toBe(true)
    expect(p.canManageAllocations).toBe(true)
    expect(p.canApproveTimesheets).toBe(true)
    expect(p.canSubmitTimesheets).toBe(true)
    expect(p.canManageBudgets).toBe(true)
    expect(p.canGenerateReports).toBe(true)
    expect(p.canManageUsers).toBe(true)
    expect(p.canWrite).toBe(true)
    expect(p.canManageOrg).toBe(true)
  })

  it('Project Manager can manage projects but not org', () => {
    const p = computePermissions('Project Manager')
    expect(p.canManageProjects).toBe(true)
    expect(p.canManageAllocations).toBe(true)
    expect(p.canSeeImport).toBe(true)
    expect(p.canApproveTimesheets).toBe(false)
    expect(p.canSubmitTimesheets).toBe(true)
    expect(p.canWrite).toBe(true)
    expect(p.canManageOrg).toBe(false)
    expect(p.canManageUsers).toBe(false)
    expect(p.canSeeSalary).toBe(false)
  })

  it('Finance Officer can see salary, approve timesheets, manage allocations and budgets', () => {
    const p = computePermissions('Finance Officer')
    expect(p.canSeeSalary).toBe(true)
    expect(p.canSeeFinancialDetails).toBe(true)
    expect(p.canSeePersonnelRates).toBe(true)
    expect(p.canApproveTimesheets).toBe(true)
    expect(p.canManageAllocations).toBe(true)
    expect(p.canManageBudgets).toBe(true)
    expect(p.canWrite).toBe(true)
    expect(p.canManageProjects).toBe(false)
    expect(p.canManageOrg).toBe(false)
  })

  it('External Participant can only see collaboration module', () => {
    const p = computePermissions('External Participant')
    expect(p.canSeeDashboard).toBe(false)
    expect(p.canSeeProjects).toBe(false)
    expect(p.canSeeCollaboration).toBe(true)
    expect(p.canSeeTimesheets).toBe(false)
    expect(p.canSubmitTimesheets).toBe(false)
    expect(p.canWrite).toBe(true)
    expect(p.canSeeStaff).toBe(false)
    expect(p.canSeeFinancials).toBe(false)
    expect(p.canManageOrg).toBe(false)
  })

  it('returns DEFAULT_PERMISSIONS for unknown role', () => {
    const p = computePermissions('NonExistentRole' as any)
    expect(p).toEqual(DEFAULT_PERMISSIONS)
  })
})

describe('rolePermissionToPermissions', () => {
  it('converts a DB RolePermission to Permissions object', () => {
    const rp: RolePermission = {
      id: 'test-id',
      org_id: 'org-1',
      role: 'Admin',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
      can_see_dashboard: true,
      can_see_projects: true,
      can_see_staff: false,
      can_see_allocations: true,
      can_see_timesheets: true,
      can_see_absences: true,
      can_see_financials: false,
      can_see_timeline: true,
      can_see_reports: true,
      can_see_import: false,
      can_see_audit: true,
      can_see_salary_info: true,
      can_see_financial_details: false,
      can_see_personnel_rates: true,
      can_edit_projects: true,
      can_edit_allocations: false,
      can_approve_timesheets: true,
      can_submit_timesheets: true,
      can_manage_budgets: true,
      can_generate_reports: false,
      can_manage_users: true,
      can_manage_org: true,
      can_see_proposals: true,
    } satisfies RolePermission

    const p = rolePermissionToPermissions(rp)

    expect(p.canSeeDashboard).toBe(true)
    expect(p.canSeeStaff).toBe(false)
    expect(p.canSeeFinancials).toBe(false)
    expect(p.canSeeSalary).toBe(true)
    expect(p.canManageProjects).toBe(true)
    expect(p.canManageAllocations).toBe(false)
    // canWrite = can_edit_projects || can_edit_allocations || can_submit_timesheets
    expect(p.canWrite).toBe(true)
    expect(p.canManageOrg).toBe(true)
  })

  it('derives canWrite from edit/submit permissions', () => {
    const rp = {
      id: 'test',
      org_id: 'org',
      role: 'Project Manager' as const,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
      can_see_dashboard: true,
      can_see_projects: true,
      can_see_staff: true,
      can_see_allocations: false,
      can_see_timesheets: false,
      can_see_absences: false,
      can_see_financials: false,
      can_see_timeline: true,
      can_see_reports: false,
      can_see_import: false,
      can_see_audit: false,
      can_see_salary_info: false,
      can_see_financial_details: false,
      can_see_personnel_rates: false,
      can_edit_projects: false,
      can_edit_allocations: false,
      can_approve_timesheets: false,
      can_submit_timesheets: false,
      can_manage_budgets: false,
      can_generate_reports: false,
      can_manage_users: false,
      can_manage_org: false,
      can_see_proposals: false,
    } satisfies RolePermission

    const p = rolePermissionToPermissions(rp)
    expect(p.canWrite).toBe(false)
  })
})

describe('DEFAULT_PERMISSIONS', () => {
  it('denies all access', () => {
    for (const value of Object.values(DEFAULT_PERMISSIONS)) {
      expect(value).toBe(false)
    }
  })
})

describe('ROUTE_PERMISSIONS', () => {
  it('has entries for all major routes', () => {
    const paths = ROUTE_PERMISSIONS.map((r) => r.path)
    expect(paths).toContain('/dashboard')
    expect(paths).toContain('/projects')
    expect(paths).toContain('/staff')
    expect(paths).toContain('/allocations')
    expect(paths).toContain('/timesheets')
    expect(paths).toContain('/absences')
    expect(paths).toContain('/financials')
    expect(paths).toContain('/timeline')
    expect(paths).toContain('/reports')
    // NOTE: '/import' is deliberately absent. The Import feature
    // (src/features/import/) has no route and is not imported anywhere — it is
    // unreachable dead code, and the `canSeeImport` toggle on the Role
    // Permissions screen therefore controls nothing. Tracked as BACKLOG.md B13:
    // either wire the feature up (and restore this assertion) or delete it
    // along with the permission.
    expect(paths).toContain('/audit')
    expect(paths).toContain('/proposals')
    expect(paths).toContain('/settings')
  })

  it('each route has a minPermission key', () => {
    for (const route of ROUTE_PERMISSIONS) {
      expect(route.minPermission).toBeDefined()
    }
  })
})
