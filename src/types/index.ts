export type OrgRole = 'Admin' | 'Project Manager' | 'Finance Officer' | 'External Participant'

/** Roles that can be selected when inviting internal org members */
export type InvitableRole = 'Admin' | 'Project Manager' | 'Finance Officer'
export type AccessType = 'member' | 'collab_partner'
export type OrgPlan = 'trial' | 'free' | 'pro'

export type ProjectStatus = 'Upcoming' | 'Active' | 'Completed' | 'Suspended'
export type AssignmentType = 'actual' | 'official'
export type TimesheetStatus = 'Draft' | 'Submitted' | 'Signing' | 'Signed' | 'Approved' | 'Rejected'
export type SignatureStatus = 'pending' | 'sent' | 'signed' | 'declined' | 'voided'
export type EmploymentType = 'Full-time' | 'Part-time' | 'Contractor'
export type AbsenceType = 'Annual Leave' | 'Sick Leave' | 'Training' | 'Public Holiday' | 'Other'
export type AbsencePeriod = 'full' | 'am' | 'pm'
export type AbsenceStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'
export type FinancialCategory = 'personnel' | 'travel' | 'subcontracting' | 'other' | 'indirect'
export type AllocationsMode = 'actual' | 'official' | 'compare'
export type Granularity = 'monthly' | 'quarterly' | 'annual' | 'custom'

export interface Organisation {
  id: string
  name: string
  country: string | null
  currency: string
  working_hours_per_day: number
  working_days_per_year: number
  default_overhead_rate: number
  average_personnel_rate_pm: number
  departments: string[]
  default_vacation_days: number
  ai_enabled: boolean
  timesheets_drive_allocations: boolean
  private_absence_types: string[]
  plan: OrgPlan
  trial_ends_at: string | null
  is_active: boolean
  // Stripe billing
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  subscription_status: string | null
  // DocuSign integration
  docusign_integration_key: string | null
  docusign_user_id: string | null
  docusign_account_id: string | null
  docusign_rsa_private_key: string | null
  docusign_base_url: string | null
  docusign_oauth_base_url: string | null
  created_at: string
  updated_at: string
}

export interface OrgMember {
  id: string
  user_id: string
  org_id: string
  role: OrgRole
  invited_by: string | null
  created_at: string
  updated_at: string
}

export interface RolePermission {
  id: string
  org_id: string
  role: OrgRole
  // Module visibility
  can_see_dashboard: boolean
  can_see_projects: boolean
  can_see_staff: boolean
  can_see_allocations: boolean
  can_see_timesheets: boolean
  can_see_absences: boolean
  can_see_financials: boolean
  can_see_timeline: boolean
  can_see_reports: boolean
  can_see_import: boolean
  can_see_audit: boolean
  can_see_proposals: boolean
  // Data privacy
  can_see_salary_info: boolean
  can_see_financial_details: boolean
  can_see_personnel_rates: boolean
  // Action permissions
  can_edit_projects: boolean
  can_edit_allocations: boolean
  can_approve_timesheets: boolean
  can_submit_timesheets: boolean
  can_manage_budgets: boolean
  can_generate_reports: boolean
  can_manage_users: boolean
  can_manage_org: boolean
  created_at: string
  updated_at: string
}

export type InviteStatus = 'pending' | 'accepted' | null

export interface Person {
  id: string
  org_id: string
  full_name: string
  email: string | null
  department: string | null
  role: string | null
  employment_type: EmploymentType
  fte: number
  start_date: string | null
  end_date: string | null
  annual_salary: number | null
  overhead_rate: number | null
  country: string | null
  region: string | null
  is_active: boolean
  avatar_url: string | null
  vacation_days_per_year: number | null
  user_id: string | null
  invite_status: InviteStatus
  invite_role: string | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  org_id: string
  acronym: string
  title: string
  funding_scheme_id: string | null
  grant_number: string | null
  status: ProjectStatus
  start_date: string
  end_date: string
  total_budget: number | null
  overhead_rate: number | null
  has_wps: boolean
  is_lead_organisation: boolean
  our_pm_rate: number | null
  budget_personnel: number | null
  budget_travel: number | null
  budget_subcontracting: number | null
  budget_other: number | null
  responsible_person_id: string | null
  created_at: string
  updated_at: string
  funding_schemes?: FundingScheme | null
  responsible_person?: Person | null
}

export interface WorkPackage {
  id: string
  org_id: string
  project_id: string
  number: number | null
  name: string
  description: string | null
  lead_person_id: string | null
  start_month: number | null
  end_month: number | null
  start_date: string | null
  end_date: string | null
  created_at: string
  updated_at: string
}

export interface Assignment {
  id: string
  org_id: string
  person_id: string
  project_id: string
  work_package_id: string | null
  year: number
  month: number
  pms: number
  type: AssignmentType
  created_at: string
  updated_at: string
}

export interface PmBudget {
  id: string
  org_id: string
  project_id: string
  work_package_id: string | null
  year: number
  target_pms: number
  type: AssignmentType
  created_at: string
  updated_at: string
}

export interface TimesheetEntry {
  id: string
  org_id: string
  person_id: string
  project_id: string
  work_package_id: string | null
  year: number
  month: number
  planned_hours: number | null
  actual_hours: number | null
  total_hours: number | null
  working_days: number | null
  hours: number | null
  planned_percentage: number | null
  confirmed_percentage: number | null
  status: TimesheetStatus
  submitted_at: string | null
  submitted_by: string | null
  confirmed_at: string | null
  confirmed_by: string | null
  approved_at: string | null
  approved_by: string | null
  notes: string | null
  signature_status: SignatureStatus | null
  signature_envelope_id: string | null
  signature_url: string | null
  signed_at: string | null
  signed_document_url: string | null
  created_at: string
  updated_at: string
}

export interface TimesheetDay {
  id: string
  org_id: string
  person_id: string
  project_id: string
  work_package_id: string | null
  date: string
  hours: number
  start_time: string | null
  end_time: string | null
  description: string | null
  created_at: string
  updated_at: string
}

export interface Holiday {
  id: string
  org_id: string
  date: string
  name: string
  country_code: string | null
  region_code: string | null
  created_at: string
}

export interface Absence {
  id: string
  org_id: string
  person_id: string
  type: AbsenceType
  start_date: string | null
  end_date: string | null
  days: number | null
  notes: string | null
  date: string | null
  period: AbsencePeriod | null
  note: string | null
  status: AbsenceStatus
  approved_by: string | null
  approved_at: string | null
  requested_by: string | null
  substitute_person_id: string | null
  created_at: string
  updated_at: string
  // Joined relations
  persons?: { full_name: string } | null
  substitute_person?: { full_name: string } | null
}

export interface Travel {
  id: string
  org_id: string
  person_id: string
  project_id: string | null
  date: string
  location: string
  notes: string | null
  created_at: string
  updated_at: string
  // Joined relations
  persons?: { full_name: string } | null
  projects?: { acronym: string; title: string } | null
}

export interface AbsenceApprover {
  id: string
  org_id: string
  person_id: string
  user_id: string | null
  department: string | null  // null = org-wide, string = department-scoped
  created_at: string
  person?: Person
}

export interface TimesheetApprover {
  id: string
  org_id: string
  person_id: string
  user_id: string | null
  department: string | null  // null = org-wide, string = department-scoped
  created_at: string
  person?: Person
}

export interface FinancialBudget {
  id: string
  org_id: string
  project_id: string
  category: FinancialCategory
  year: number
  budgeted: number
  actual: number
  created_at: string
  updated_at: string
}

export type ExpenseCategory = 'travel' | 'subcontracting' | 'other' | 'indirect'

export interface ProjectExpense {
  id: string
  org_id: string
  project_id: string
  category: ExpenseCategory
  description: string
  amount: number
  expense_date: string
  vendor: string | null
  reference: string | null
  person_id: string | null
  notes: string | null
  recorded_by: string | null
  created_at: string
  updated_at: string
}

export interface UserPreferences {
  id: string
  user_id: string
  org_id: string
  display_name: string | null
  unsubscribe_token: string
  email_timesheet_reminders: boolean
  email_timesheet_submitted: boolean
  email_project_alerts: boolean
  email_budget_alerts: boolean
  email_period_locked: boolean
  email_role_changes: boolean
  email_invitations: boolean
  email_welcome: boolean
  email_trial_expiring: boolean
  email_substitute_notifications: boolean
  email_absence_notifications: boolean
  email_collab_notifications: boolean
  created_at: string
  updated_at: string
}

export type ProposalStatus = 'In Preparation' | 'Submitted' | 'Rejected' | 'Granted'

export interface Proposal {
  id: string
  org_id: string
  project_name: string
  call_identifier: string
  funding_scheme: string
  submission_deadline: string | null
  expected_decision: string | null
  our_pms: number
  personnel_budget: number
  travel_budget: number
  subcontracting_budget: number
  other_budget: number
  status: ProposalStatus
  converted_project_id: string | null
  converted_at: string | null
  call_template_id: string | null
  responsible_person_id: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  responsible_person?: Person | null
}

// ── Proposals consortium workflow ───────────────────────────────

export type ProposalDocumentHandler = 'form' | 'upload' | 'upload_with_template'
export type ProposalSubmissionStatus =
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'approved'
  | 'needs_revision'
export type ProposalPartnerRole = 'host' | 'coordinator' | 'partner'
export type ProposalPartnerInviteStatus = 'pending' | 'accepted' | 'declined'
export type ProposalPartnerBudgetRole = 'lead' | 'partner' | 'contributor'

/** Configuration of one expected document type in a call template. */
export interface ProposalCallTemplateDoc {
  type: string
  label: string
  handler: ProposalDocumentHandler
  required: boolean
  template_url: string | null
  description: string | null
}

export interface ProposalCallTemplate {
  id: string
  org_id: string | null  // null = built-in global template
  name: string
  description: string | null
  default_documents: ProposalCallTemplateDoc[]
  is_builtin: boolean
  created_at: string
  updated_at: string
}

export interface ProposalPartner {
  id: string
  proposal_id: string
  org_name: string
  role: ProposalPartnerRole
  participant_number: number | null
  contact_name: string | null
  contact_email: string | null
  country: string | null
  org_type: string | null
  pic: string | null
  user_id: string | null
  linked_org_id: string | null
  is_host: boolean
  invite_status: ProposalPartnerInviteStatus
  invite_token: string | null
  created_at: string
  updated_at: string
}

export interface ProposalWorkPackage {
  id: string
  proposal_id: string
  wp_number: number
  title: string
  description: string | null
  leader_partner_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface ProposalDocument {
  id: string
  proposal_id: string
  document_type: string
  label: string
  description: string | null
  handler: ProposalDocumentHandler
  template_url: string | null
  required: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export interface ProposalSubmissionVersion {
  id: string
  submission_id: string
  storage_bucket: string
  storage_path: string
  file_name: string
  original_file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  uploaded_by: string | null
  uploaded_at: string
  note: string | null
}

export interface ProposalSubmission {
  id: string
  proposal_id: string
  partner_id: string
  document_id: string
  status: ProposalSubmissionStatus
  part_a_id: string | null
  budget_id: string | null
  current_version_id: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  submitted_at: string | null
  created_at: string
  updated_at: string
  // Joined, optional
  document?: ProposalDocument
  partner?: ProposalPartner
  current_version?: ProposalSubmissionVersion | null
}

/** A single repeated contact / researcher / publication row used in Part A. */
export interface PartAContact {
  title?: string
  first_name?: string
  last_name?: string
  gender?: 'woman' | 'man' | 'nonbinary' | 'other'
  position?: string
  email?: string
  phone?: string
  address?: string
}

export interface PartAResearcher {
  title?: string
  first_name: string
  last_name: string
  gender?: 'woman' | 'man' | 'nonbinary' | 'other'
  nationality?: string
  email?: string
  career_stage?: 'A' | 'B' | 'C' | 'D'
  role?: 'leading' | 'team_member'
  orcid?: string
  person_id?: string  // link to persons table when auto-populated
}

export interface PartAAchievement {
  kind: 'publication' | 'dataset' | 'software' | 'good' | 'service' | 'other'
  description: string
}

export interface PartAProject {
  name: string
  description: string
}

export interface PartAInfrastructure {
  name: string
  description: string
}

export interface PartADirectCost {
  label: string
  amount: number | null
  justification?: string
}

export interface PartARiAsset {
  asset_name: string
  partners?: string
  reference_projects?: string
  current_trl?: number
  target_trl?: number
  description?: string
}

export interface PartAAffiliatedEntity {
  legal_name: string
  pic?: string
}

export interface PartAPlannedEvent {
  kind: string  // e.g. "Workshop", "Training", "Showcase", "Webinar"
  description: string
}

export interface ProposalPartA {
  id: string
  proposal_id: string
  partner_id: string
  // 1.1
  legal_name: string | null
  acronym: string | null
  city: string | null
  country: string | null
  website: string | null
  is_non_profit: boolean | null
  pic: string | null
  org_type: 'academic' | 'industrial' | 'rto' | 'public' | 'sme' | 'other' | null
  org_type_other: string | null
  // 1.2
  ubo_location: 'eu' | 'outside_eu' | 'unknown' | null
  ubo_country: string | null
  ubo_notes: string | null
  // 1.3
  main_contact: PartAContact | null
  other_contacts: PartAContact[]
  // 1.4
  departments: string[]
  // 1.5
  researchers: PartAResearcher[]
  // 1.6
  roles: string[]
  // 1.7
  achievements: PartAAchievement[]
  // 1.8
  previous_projects: PartAProject[]
  // 1.9
  infrastructure: PartAInfrastructure[]
  // 1.10
  has_gep: boolean | null
  gep_notes: string | null
  // 2
  pm_rate_currency: string
  pm_rate_amount: number | null
  other_direct_costs: PartADirectCost[]
  // 3.1
  standards_bodies: string[]
  // 3.2
  ri_assets: PartARiAsset[]
  similar_projects: string[]
  // 4
  dissemination_plan: string | null
  exploitation_plan: string | null
  planned_events: PartAPlannedEvent[]
  planned_publications: string | null
  dissemination_bodies: string | null
  standardisation_involvement: string | null
  patents_planned: string | null
  // 5.1
  short_profile: string | null
  role_description: string | null
  // 6
  affiliated_entities: PartAAffiliatedEntity[]
  created_at: string
  updated_at: string
}

export interface ProposalBudget {
  id: string
  proposal_id: string
  partner_id: string
  pm_rate_currency: string
  pm_rate_amount: number | null
  budget_travel: number
  budget_subcontracting: number
  budget_equipment: number
  budget_other_goods: number
  funding_rate: number
  indirect_cost_rate: number
  indirect_cost_base: 'all_direct' | 'personnel_only' | 'all_except_subcontracting'
  notes: string | null
  created_at: string
  updated_at: string
  // Joined
  lines?: ProposalBudgetLine[]
}

export interface ProposalBudgetLine {
  id: string
  budget_id: string
  wp_id: string
  person_months: number
  partner_role: ProposalPartnerBudgetRole
  notes: string | null
  created_at: string
  // Joined
  wp?: ProposalWorkPackage
}

export type ProposalAuditEventType =
  | 'partner_invited'
  | 'partner_accepted'
  | 'partner_declined'
  | 'partner_removed'
  | 'document_added'
  | 'document_removed'
  | 'submission_started'
  | 'submission_updated'
  | 'submission_submitted'
  | 'submission_approved'
  | 'submission_rejected'
  | 'proposal_status_changed'
  | 'proposal_converted'

export interface ProposalAuditEvent {
  id: string
  proposal_id: string
  actor_user_id: string | null
  actor_name: string | null
  actor_role: 'coordinator' | 'partner' | 'system' | null
  event_type: ProposalAuditEventType
  target_partner_id: string | null
  target_document_id: string | null
  target_submission_id: string | null
  note: string | null
  created_at: string
}

/**
 * Must stay in sync with the `notifications_type_check` constraint in
 * supabase/2026_07_critical_security_fixes.sql.
 *
 * The original constraint only allowed the eight generic values below, but the
 * cron jobs and the Stripe webhook inserted types like 'trial_expiring' and
 * 'collab_report_reminder'. Every one of those inserts violated the CHECK and
 * was swallowed by a try/catch — so those notifications silently never
 * appeared. Both sides now list the same values.
 */
export type NotificationType =
  // generic
  | 'info' | 'success' | 'warning' | 'alert' | 'system'
  // workflow
  | 'assignment' | 'approval' | 'invitation'
  // billing / lifecycle
  | 'trial_expiring' | 'trial_expired'
  | 'subscription_upgraded' | 'subscription_cancelled' | 'payment_failed'
  // collaboration reminders
  | 'collab_report_reminder' | 'collab_deliverable_reminder'
  | 'collab_milestone_reminder' | 'collab_report_status'
  // timesheets
  | 'timesheet_submitted' | 'timesheet_approved' | 'timesheet_rejected'
  | 'timesheet_ready_to_sign' | 'timesheet_signed'
  // periods / projects
  | 'period_locked' | 'project_alert' | 'budget_alert'

export interface AppNotification {
  id: string
  org_id: string
  user_id: string
  type: NotificationType
  title: string
  message: string
  link: string | null
  is_read: boolean
  created_at: string
}

export interface FundingScheme {
  id: string
  org_id: string
  name: string
  type: string
  overhead_rate: number
  requires_time_range?: boolean
  created_at: string
  updated_at: string
}

export interface ProjectDocument {
  id: string
  org_id: string
  project_id: string
  title: string | null
  name: string | null
  document_type: string | null
  description: string | null
  file_name: string | null
  file_url: string | null
  file_size: string | null
  file_size_bytes: number | null
  uploaded_by: string | null
  uploaded_at: string | null
  valid_from: string | null
  valid_until: string | null
  tags: string[] | null
  created_at: string
  updated_at: string
}

export interface AuditLog {
  id: string
  org_id: string
  user_id: string | null
  user_email: string | null
  entity_type: string | null
  action: string | null
  entity_id: string | null
  details: string | null
  created_at: string
}

export interface AuditChange {
  id: string
  org_id: string
  user_id: string | null
  entity_type: string | null
  entity_id: string | null
  field_name: string | null
  old_value: string | null
  new_value: string | null
  action: string | null
  changed_by_name: string | null
  notes: string | null
  created_at: string
}


export interface PeriodLock {
  id: string
  org_id: string
  year: number
  month: number
  locked_by: string | null
  locked_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Deliverable {
  id: string
  org_id: string
  project_id: string
  work_package_id: string | null
  number: string
  title: string
  description: string | null
  lead_person_id: string | null
  due_month: number | null
  created_at: string
  updated_at: string
}

export interface Milestone {
  id: string
  org_id: string
  project_id: string
  work_package_id: string | null
  number: string
  title: string
  description: string | null
  due_month: number | null
  verification_means: string | null
  created_at: string
  updated_at: string
}

export interface ReportingPeriod {
  id: string
  org_id: string
  project_id: string
  period_number: number
  start_month: number
  end_month: number
  technical_report_due: string | null
  financial_report_due: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

// ── AI Grant Agreement Extraction ─────────────────────────────
export interface GrantAIExtraction {
  project: {
    acronym: string
    title: string
    grant_number: string | null
    start_date: string
    end_date: string
    total_budget: number | null
    overhead_rate: number | null
    has_wps: boolean
    is_lead_organisation: boolean
    our_pm_rate: number | null
    budget_personnel: number | null
    budget_travel: number | null
    budget_subcontracting: number | null
    budget_other: number | null
  }
  work_packages: {
    number: number
    name: string
    description: string | null
    start_month: number
    end_month: number
    person_months: number | null
  }[]
  deliverables: {
    number: string
    title: string
    description: string | null
    wp_number: number | null
    due_month: number
  }[]
  milestones: {
    number: string
    title: string
    description: string | null
    wp_number: number | null
    due_month: number
    verification_means: string | null
  }[]
  reporting_periods: {
    period_number: number
    start_month: number
    end_month: number
  }[]
  confidence_notes: string
}

// ============================================================================
// External Project Collaboration Module
// ============================================================================

export type CollabProjectStatus = 'draft' | 'active' | 'archived'
export type CollabPartnerRole = 'coordinator' | 'partner'
export type CollabPartnerInviteStatus = 'pending' | 'invited' | 'accepted' | 'declined'
export type CollabPeriodType = 'formal' | 'informal'
export type CollabReportStatus = 'draft' | 'submitted' | 'approved' | 'rejected'
export type CollabIndirectCostBase = 'all_direct' | 'personnel_only' | 'all_except_subcontracting'
export type CollabReportSection = 'personnel_effort' | 'personnel_costs' | 'subcontracting' | 'travel' | 'equipment' | 'other_goods'
export type CollabEventType = 'generated' | 'saved' | 'submitted' | 'approved' | 'rejected' | 'resubmitted' | 'notified' | 'comment'
export type CollabOrgType = 'HES' | 'REC' | 'PRC' | 'PUB' | 'OTH'
export type CollabDeliverableType = 'report' | 'data' | 'software' | 'demonstrator' | 'other'
export type CollabDisseminationLevel = 'public' | 'confidential' | 'classified'

export type CollabReminderUnit = 'days' | 'weeks' | 'months'

export interface CollabReminderSetting {
  enabled: boolean
  lead_time: number
  unit: CollabReminderUnit
}

export interface CollabReminderSettings {
  deliverables: CollabReminderSetting
  milestones: CollabReminderSetting
  reports: CollabReminderSetting
}

export interface CollabProject {
  id: string
  host_org_id: string
  title: string
  acronym: string
  grant_number: string | null
  funding_programme: string | null
  funding_scheme: string | null
  start_date: string | null
  end_date: string | null
  duration_months: number | null
  status: CollabProjectStatus
  deviation_personnel_effort: number
  deviation_personnel_costs: number
  deviation_pm_rate: number
  reminder_settings: CollabReminderSettings
  created_by: string | null
  created_at: string
  updated_at: string
  // Joined data
  partners?: CollabPartner[]
  work_packages?: CollabWorkPackage[]
}

export interface CollabPartner {
  id: string
  project_id: string
  org_name: string
  role: CollabPartnerRole
  participant_number: number | null
  contact_name: string | null
  contact_email: string | null
  country: string | null
  org_type: string | null
  budget_personnel: number
  budget_subcontracting: number
  budget_travel: number
  budget_equipment: number
  budget_other_goods: number
  total_person_months: number
  funding_rate: number
  indirect_cost_rate: number
  indirect_cost_base: CollabIndirectCostBase
  user_id: string | null
  linked_org_id: string | null
  invite_status: CollabPartnerInviteStatus
  invite_token: string | null
  is_host: boolean
  created_at: string
  updated_at: string
  // Joined data
  contacts?: CollabContact[]
  wp_allocations?: CollabPartnerWpAlloc[]
}

export interface CollabWorkPackage {
  id: string
  project_id: string
  wp_number: number
  title: string
  total_person_months: number
  start_month: number | null
  end_month: number | null
  leader_partner_id: string | null
  created_at: string
  // Joined
  tasks?: CollabTask[]
}

export interface CollabTask {
  id: string
  wp_id: string
  project_id: string
  task_number: string
  title: string
  description: string | null
  start_month: number | null
  end_month: number | null
  leader_partner_id: string | null
  person_months: number
  created_at: string
  // Joined
  effort?: CollabPartnerTaskEffort[]
}

export interface CollabPartnerTaskEffort {
  id: string
  task_id: string
  partner_id: string
  person_months: number
  created_at: string
}

export interface CollabDeliverable {
  id: string
  project_id: string
  wp_id: string | null
  task_id: string | null
  number: string
  title: string
  description: string | null
  type: CollabDeliverableType | null
  dissemination: CollabDisseminationLevel | null
  due_month: number
  leader_partner_id: string | null
  created_at: string
}

export interface CollabMilestone {
  id: string
  project_id: string
  wp_id: string | null
  number: string
  title: string
  description: string | null
  due_month: number
  verification_means: string | null
  created_at: string
}

export interface CollabPartnerWpAlloc {
  id: string
  partner_id: string
  wp_id: string
  person_months: number
  created_at: string
  // Joined
  work_package?: CollabWorkPackage
}

export interface CollabContact {
  id: string
  partner_id: string
  name: string
  email: string
  role_note: string | null
  notify_reminders: boolean
  notify_approvals: boolean
  notify_rejections: boolean
  created_at: string
}

export interface CollabReportingPeriod {
  id: string
  project_id: string
  period_type: CollabPeriodType
  title: string
  start_month: number
  end_month: number
  due_date: string | null
  reports_generated: boolean
  beneficiaries_notified: boolean
  created_at: string
  updated_at: string
  // Joined
  reports?: CollabReport[]
}

export interface CollabReport {
  id: string
  period_id: string
  partner_id: string
  status: CollabReportStatus
  submitted_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  rejection_note: string | null
  created_at: string
  updated_at: string
  // Joined
  partner?: CollabPartner
  period?: CollabReportingPeriod
  lines?: CollabReportLine[]
  events?: CollabReportEvent[]
}

export interface CollabReportLine {
  id: string
  report_id: string
  section: CollabReportSection
  wp_id: string | null
  line_order: number
  data: Record<string, any>
  justification: string | null
  justification_required: boolean
  created_at: string
  updated_at: string
  // Joined
  work_package?: CollabWorkPackage
}

export interface CollabReportEvent {
  id: string
  report_id: string
  event_type: CollabEventType
  actor_user_id: string | null
  actor_name: string | null
  actor_role: 'coordinator' | 'partner' | 'system' | null
  note: string | null
  created_at: string
}

// ── AI Usage & Quota ────────────────────────────────────────
export interface AiUsage {
  id: string
  org_id: string
  month: string          // 'YYYY-MM'
  tokens_in: number
  tokens_out: number
  request_count: number
  updated_at: string
}

export interface AiQuotaLimits {
  monthly_tokens: number    // total (in + out) per month
  monthly_requests: number  // max requests per month
}

// ── Report Builder ─────────────────────────────────────────────
export type ReportDataSource =
  | 'projects'
  | 'staff'
  | 'effort'
  | 'timesheets'
  | 'financials'
  | 'expenses'
  | 'absences'
  | 'travel'
  | 'proposals'
  | 'project_health'

export type ReportChartType = 'table' | 'bar' | 'line' | 'pie' | 'stacked_bar'

export interface ReportSortConfig {
  field: string
  direction: 'asc' | 'desc'
}

export interface ReportConfig {
  columns: string[]
  filters: Record<string, unknown>
  group_by: string | null
  sort_by: ReportSortConfig | null
  chart_type: ReportChartType
}

export interface ReportTemplate {
  id: string
  org_id: string
  name: string
  description: string | null
  data_source: ReportDataSource
  config: ReportConfig
  is_shared: boolean
  is_pinned: boolean
  created_by: string | null
  created_by_name: string | null
  updated_at: string
  created_at: string
}

/** Monthly AI limits per plan tier */
export const AI_PLAN_LIMITS: Record<OrgPlan, AiQuotaLimits> = {
  trial: { monthly_tokens: 500_000,   monthly_requests: 5 },
  free:  { monthly_tokens: 0,         monthly_requests: 0 },
  pro:   { monthly_tokens: 10_000_000, monthly_requests: 100 },
}

/** Feature limits per plan tier (Infinity = unlimited) */
export interface PlanLimits {
  maxProjects: number
  maxStaff: number
  maxSeats: number
  maxAiRequests: number
  hasReportExport: boolean
  hasCollaboration: boolean
  hasCustomRoles: boolean
  supportLevel: 'email' | 'priority_email'
  trialDays: number
}

export const PLAN_LIMITS: Record<OrgPlan, PlanLimits> = {
  trial: {
    maxProjects: Infinity,
    maxStaff: Infinity,
    maxSeats: Infinity,
    maxAiRequests: 5,
    hasReportExport: true,
    hasCollaboration: true,
    hasCustomRoles: true,
    supportLevel: 'email',
    trialDays: 30,
  },
  free: {
    maxProjects: 5,
    maxStaff: 10,
    maxSeats: 1,
    maxAiRequests: 0,
    hasReportExport: false,
    hasCollaboration: false,
    hasCustomRoles: false,
    supportLevel: 'email',
    trialDays: 0,
  },
  pro: {
    maxProjects: Infinity,
    maxStaff: Infinity,
    maxSeats: Infinity,
    maxAiRequests: 100,
    hasReportExport: true,
    hasCollaboration: true,
    hasCustomRoles: true,
    supportLevel: 'priority_email',
    trialDays: 0,
  },
}
