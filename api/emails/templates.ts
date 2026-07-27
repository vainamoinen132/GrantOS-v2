/**
 * Email HTML templates for GrantLume
 * Each function returns { subject, html } for use with Resend
 *
 * Redesigned March 2026 — modern layout with GrantLume logo SVG,
 * improved typography, refined color palette, and all new templates.
 *
 * SECURITY — call templates through `renderEmail()`, never directly
 * -----------------------------------------------------------------
 * Every value below is interpolated straight into an HTML string, and these
 * emails go out from a verified GrantLume domain. `renderEmail()` escapes the
 * params first (see api/lib/html.ts) so a person name, project title or
 * support message cannot inject markup or a look-alike link into a message
 * that carries our branding and our SPF/DKIM alignment.
 *
 * `renderEmail()` also supplies the per-recipient preferences URL. The old
 * approach string-replaced `href="https://app.grantlume.com/profile"` in the
 * finished HTML, which was brittle and — because it ran once for a whole batch
 * — handed every recipient the FIRST recipient's unsubscribe token.
 */

import { escapeParams } from '../lib/html.js'

/**
 * Per-render preferences URL. Set only for the duration of one synchronous
 * template call by renderEmail(), so concurrent requests cannot see each
 * other's value (template functions never await).
 */
let _preferencesUrl: string | undefined

/**
 * Render a template with escaped params and a recipient-specific preferences
 * link. This is the only supported way to produce an email.
 */
export function renderEmail<P extends Record<string, any>>(
  template: (params: P) => EmailTemplate,
  params: P,
  preferencesUrl?: string,
): EmailTemplate {
  const previous = _preferencesUrl
  _preferencesUrl = preferencesUrl
  try {
    return template(escapeParams(params ?? ({} as P)))
  } finally {
    _preferencesUrl = previous
  }
}

// ── Brand palette ──────────────────────────────────────
const BRAND     = '#0d9488'   // teal-600 — primary brand
const NAVY      = '#1a2744'   // dark navy — headings, icon bg
const GOLD      = '#f59e0b'   // amber-500 — star accent
const MUTED     = '#6b7280'   // gray-500
const TEXT      = '#1f2937'   // gray-800
const TEXT_SEC  = '#4b5563'   // gray-600
const BG        = '#f8fafc'   // slate-50
const CARD_BG   = '#ffffff'
const BORDER    = '#e2e8f0'   // slate-200
const SUCCESS   = '#059669'   // emerald-600
const DANGER    = '#dc2626'   // red-600
const WARNING   = '#d97706'   // amber-600

// ── Inline SVG logo for emails (checkmark + star) ──────
const LOGO_SVG = `<svg width="36" height="36" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M8 26 L14 20 L22 32 L40 8" stroke="white" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<path d="M38 6 L39.2 2 L40.4 6 L44 7.2 L40.4 8.4 L39.2 12 L38 8.4 L34 7.2 Z" fill="${GOLD}"/>
</svg>`

const WORDMARK = `<span style="font-size:20px;font-weight:700;letter-spacing:-0.3px;">
<span style="color:white;">Grant</span><span style="color:#6ee7b7;">Lume</span>
</span>`

// ── Shared helpers ─────────────────────────────────────

function layout(title: string, body: string, unsubscribeUrl?: string): string {
  // Resolution order: explicit argument → the per-recipient URL supplied by
  // renderEmail() → a generic profile link for anything rendered outside it.
  const resolved = unsubscribeUrl || _preferencesUrl
  const prefsLink = resolved || 'https://app.grantlume.com/profile'
  const hasToken = !!resolved
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:40px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:${CARD_BG};border-radius:16px;border:1px solid ${BORDER};overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
<!-- Header -->
<tr><td style="background:linear-gradient(135deg,${NAVY} 0%,#243456 100%);padding:28px 36px;">
  <table cellpadding="0" cellspacing="0"><tr>
    <td style="vertical-align:middle;">${LOGO_SVG}</td>
    <td style="padding-left:14px;vertical-align:middle;">${WORDMARK}</td>
  </tr></table>
</td></tr>
<!-- Body -->
<tr><td style="padding:36px 36px 28px;">${body}</td></tr>
<!-- Footer -->
<tr><td style="padding:20px 36px 24px;border-top:1px solid ${BORDER};background:#f8fafc;">
  <p style="margin:0 0 6px;font-size:12px;color:${MUTED};text-align:center;line-height:1.5;">
    This is an automated message from GrantLume. Please do not reply directly.
  </p>
  <p style="margin:0;font-size:11px;color:${MUTED};text-align:center;">
    <a href="${prefsLink}" style="color:${BRAND};text-decoration:underline;">Manage notification preferences</a>
    &nbsp;&middot;&nbsp;
    <a href="${prefsLink}${hasToken ? '&action=unsubscribe-all' : ''}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a>
    &nbsp;&middot;&nbsp;
    <a href="https://grantlume.com" style="color:${BRAND};text-decoration:underline;">grantlume.com</a>
  </p>
</td></tr>
</table>
<!-- Sub-footer -->
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin-top:16px;">
<tr><td style="text-align:center;font-size:11px;color:#94a3b8;">
  &copy; ${new Date().getFullYear()} GrantLume. All rights reserved.
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

function button(text: string, href: string, color: string = BRAND): string {
  return `<table cellpadding="0" cellspacing="0" style="margin:28px 0 8px;"><tr><td>
<a href="${href}" style="display:inline-block;background:${color};color:white;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:14px;font-weight:600;letter-spacing:0.2px;">${text}</a>
</td></tr></table>`
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 18px;font-size:24px;font-weight:700;color:${NAVY};letter-spacing:-0.3px;">${text}</h1>`
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:${TEXT_SEC};">${text}</p>`
}

function detailRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:10px 14px;font-size:13px;color:${MUTED};font-weight:500;border-bottom:1px solid #f1f5f9;white-space:nowrap;">${label}</td>
    <td style="padding:10px 14px;font-size:13px;font-weight:600;color:${TEXT};border-bottom:1px solid #f1f5f9;">${value}</td>
  </tr>`
}

function detailTable(rows: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid ${BORDER};border-radius:10px;overflow:hidden;background:#fafbfc;">
${rows}
</table>`
}

function statusBadge(label: string, color: string, bgColor: string): string {
  return `<span style="display:inline-block;background:${bgColor};color:${color};font-size:12px;font-weight:700;padding:4px 12px;border-radius:20px;letter-spacing:0.3px;text-transform:uppercase;">${label}</span>`
}

function infoBox(content: string, borderColor: string = BRAND, bgColor: string = '#f0fdfa'): string {
  return `<div style="margin:20px 0;padding:18px 20px;background:${bgColor};border-radius:10px;border-left:4px solid ${borderColor};font-size:14px;line-height:1.6;color:${TEXT_SEC};">
${content}
</div>`
}

// ─── Templates ───────────────────────────────────────────

export interface EmailTemplate {
  subject: string
  html: string
}

// ── Existing templates (redesigned) ─────────────────────

export function invitationEmail(params: {
  invitedEmail: string; orgName: string; role: string; invitedByName: string; signUpUrl: string
}): EmailTemplate {
  return {
    subject: `You've been invited to join ${params.orgName} on GrantLume`,
    html: layout('Invitation', [
      heading('You\'re Invited!'),
      paragraph(`<strong>${params.invitedByName}</strong> has invited you to join <strong>${params.orgName}</strong> on GrantLume as a <strong>${params.role}</strong>.`),
      paragraph('GrantLume helps research teams manage grant projects, allocations, timesheets, and budgets — all in one beautifully designed platform.'),
      detailTable(
        detailRow('Organisation', params.orgName) +
        detailRow('Your Role', params.role) +
        detailRow('Invited By', params.invitedByName)
      ),
      button('Accept Invitation', params.signUpUrl),
      paragraph(`<span style="font-size:13px;color:${MUTED};">If you weren't expecting this invitation, you can safely ignore this email.</span>`),
    ].join('')),
  }
}

export function welcomeEmail(params: {
  userName: string; orgName: string; dashboardUrl: string
}): EmailTemplate {
  return {
    subject: `Welcome to GrantLume — ${params.orgName}`,
    html: layout('Welcome', [
      heading(`Welcome, ${params.userName}!`),
      paragraph(`Your account for <strong>${params.orgName}</strong> is ready. Start managing your grant projects, allocations, and timesheets today.`),
      infoBox(`
        <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:${NAVY};">Getting started</p>
        <ol style="margin:0;padding-left:18px;font-size:13px;line-height:2;color:${TEXT_SEC};">
          <li>Add your first project</li>
          <li>Invite team members</li>
          <li>Configure person-month allocations</li>
          <li>Set up timesheets</li>
        </ol>
      `),
      button('Go to Dashboard', params.dashboardUrl),
    ].join('')),
  }
}

export function roleChangedEmail(params: {
  userName: string; orgName: string; oldRole: string; newRole: string; dashboardUrl: string
}): EmailTemplate {
  return {
    subject: `Your role in ${params.orgName} has been updated`,
    html: layout('Role Updated', [
      heading('Role Updated'),
      paragraph(`Hi ${params.userName}, your role in <strong>${params.orgName}</strong> has been changed.`),
      detailTable(
        detailRow('Previous Role', params.oldRole) +
        detailRow('New Role', `<strong style="color:${BRAND};">${params.newRole}</strong>`)
      ),
      paragraph('Your accessible modules and permissions may have changed. Contact your administrator if you have questions.'),
      button('Go to Dashboard', params.dashboardUrl),
    ].join('')),
  }
}

export function timesheetReminderEmail(params: {
  userName: string; orgName: string; period: string; timesheetUrl: string
}): EmailTemplate {
  return {
    subject: `Timesheet reminder — ${params.period}`,
    html: layout('Timesheet Reminder', [
      heading('Timesheet Reminder'),
      paragraph(`Hi ${params.userName}, this is a friendly reminder to submit your timesheet for <strong>${params.period}</strong> in <strong>${params.orgName}</strong>.`),
      paragraph('Please log your hours and submit before the deadline.'),
      button('Open Timesheets', params.timesheetUrl),
    ].join('')),
  }
}

export function timesheetSubmittedEmail(params: {
  approverName: string; submitterName: string; orgName: string; period: string; timesheetUrl: string
}): EmailTemplate {
  return {
    subject: `Timesheet submitted by ${params.submitterName} — ${params.period}`,
    html: layout('Timesheet Submitted', [
      heading('Timesheet Submitted'),
      paragraph(`Hi ${params.approverName}, <strong>${params.submitterName}</strong> has submitted their timesheet for <strong>${params.period}</strong>.`),
      detailTable(
        detailRow('Submitted By', params.submitterName) +
        detailRow('Period', params.period) +
        detailRow('Status', statusBadge('Pending Review', WARNING, '#fef3c7'))
      ),
      button('Review Timesheet', params.timesheetUrl),
    ].join('')),
  }
}

export function projectEndingSoonEmail(params: {
  recipientName: string; orgName: string; projectAcronym: string; projectTitle: string; endDate: string; daysRemaining: number; projectUrl: string
}): EmailTemplate {
  const urgency = params.daysRemaining <= 7 ? DANGER : params.daysRemaining <= 14 ? WARNING : BRAND
  return {
    subject: `Project "${params.projectAcronym}" ending in ${params.daysRemaining} days`,
    html: layout('Project Alert', [
      heading('Project Ending Soon'),
      paragraph(`Hi ${params.recipientName}, the following project in <strong>${params.orgName}</strong> is ending soon.`),
      detailTable(
        detailRow('Project', `<strong>${params.projectAcronym}</strong> — ${params.projectTitle}`) +
        detailRow('End Date', params.endDate) +
        detailRow('Days Remaining', `<strong style="color:${urgency};">${params.daysRemaining}</strong>`)
      ),
      paragraph('Please ensure all deliverables and reports are in order.'),
      button('View Project', params.projectUrl),
    ].join('')),
  }
}

export function budgetAlertEmail(params: {
  recipientName: string; orgName: string; projectAcronym: string; budgetCategory: string; percentUsed: number; projectUrl: string
}): EmailTemplate {
  const exceeded = params.percentUsed >= 100
  const severity = exceeded ? 'exceeded' : `reached ${params.percentUsed}%`
  return {
    subject: `Budget alert: ${params.projectAcronym} ${params.budgetCategory} ${severity}`,
    html: layout('Budget Alert', [
      heading('Budget Alert'),
      paragraph(`Hi ${params.recipientName}, a budget threshold has been ${severity} in <strong>${params.orgName}</strong>.`),
      detailTable(
        detailRow('Project', params.projectAcronym) +
        detailRow('Category', params.budgetCategory) +
        detailRow('Usage', `<strong style="color:${exceeded ? DANGER : WARNING};">${params.percentUsed}%</strong>`)
      ),
      exceeded
        ? infoBox('This budget category has exceeded its limit. Immediate attention is required.', DANGER, '#fef2f2')
        : '',
      button('View Project', params.projectUrl),
    ].join('')),
  }
}

export function trialExpiringEmail(params: {
  userName: string; orgName: string; daysRemaining: number; upgradeUrl: string
}): EmailTemplate {
  const urgent = params.daysRemaining <= 3
  return {
    subject: `Your GrantLume trial expires in ${params.daysRemaining} day${params.daysRemaining === 1 ? '' : 's'}`,
    html: layout('Trial Expiring', [
      heading(urgent ? 'Trial Expiring Tomorrow!' : 'Trial Expiring Soon'),
      paragraph(`Hi ${params.userName}, your free trial for <strong>${params.orgName}</strong> on GrantLume expires in <strong>${params.daysRemaining} day${params.daysRemaining === 1 ? '' : 's'}</strong>.`),
      urgent
        ? infoBox('Upgrade now to avoid any interruption. Your data will be preserved.', WARNING, '#fffbeb')
        : paragraph('Upgrade now to keep your data and continue using all features without interruption.'),
      button('Upgrade Now', params.upgradeUrl, urgent ? WARNING : BRAND),
      paragraph(`<span style="font-size:13px;color:${MUTED};">Questions about pricing? Contact us at hello@grantlume.com.</span>`),
    ].join('')),
  }
}

export function trialExpiredEmail(params: {
  userName: string; orgName: string; upgradeUrl: string
}): EmailTemplate {
  return {
    subject: `Your GrantLume trial has expired — upgrade to continue`,
    html: layout('Trial Expired', [
      heading('Your Trial Has Expired'),
      paragraph(`Hi ${params.userName}, the free trial for <strong>${params.orgName}</strong> on GrantLume has ended.`),
      infoBox('Your data is safe and preserved for 90 days. Upgrade now to restore full access to all features.', DANGER, '#fef2f2'),
      paragraph('Here\'s what happens next:'),
      paragraph(`<ul style="margin:0;padding-left:18px;font-size:14px;line-height:2;color:${TEXT_SEC};">
        <li>Your projects and data remain intact</li>
        <li>Read-only access continues for a limited time</li>
        <li>Upgrade anytime to restore full functionality</li>
      </ul>`),
      button('Upgrade Now', params.upgradeUrl, DANGER),
      paragraph(`<span style="font-size:13px;color:${MUTED};">Need more time? Contact us at hello@grantlume.com and we'll be happy to help.</span>`),
    ].join('')),
  }
}

export function periodLockedEmail(params: {
  recipientName: string; orgName: string; period: string; lockedBy: string
}): EmailTemplate {
  return {
    subject: `Period "${params.period}" has been locked — ${params.orgName}`,
    html: layout('Period Locked', [
      heading('Period Locked'),
      paragraph(`Hi ${params.recipientName}, the period <strong>${params.period}</strong> in <strong>${params.orgName}</strong> has been locked by <strong>${params.lockedBy}</strong>.`),
      infoBox('No further edits can be made to timesheets or allocations for this period. Contact your administrator if you need changes.', NAVY, '#f1f5f9'),
    ].join('')),
  }
}

export function signupConfirmationEmail(params: {
  firstName: string; confirmUrl: string
}): EmailTemplate {
  return {
    subject: 'Confirm your GrantLume account',
    html: layout('Confirm Email', [
      heading(`Welcome, ${params.firstName}!`),
      paragraph('Thank you for signing up for GrantLume. Please confirm your email address to activate your account and start your <strong>14-day free trial</strong>.'),
      button('Confirm Email Address', params.confirmUrl),
      infoBox(`
        <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:${NAVY};">What happens next?</p>
        <ol style="margin:0;padding-left:18px;font-size:13px;line-height:2;color:${TEXT_SEC};">
          <li>Confirm your email (click the button above)</li>
          <li>Set up your organisation</li>
          <li>Invite your team and start managing projects</li>
        </ol>
      `),
      paragraph(`<span style="font-size:13px;color:${MUTED};">This link will expire in 24 hours. If you didn't create a GrantLume account, you can safely ignore this email.</span>`),
    ].join('')),
  }
}

export function socialWelcomeEmail(params: {
  firstName: string; provider: string; dashboardUrl: string
}): EmailTemplate {
  return {
    subject: 'Welcome to GrantLume — Your account is ready',
    html: layout('Welcome', [
      heading(`Welcome, ${params.firstName}!`),
      paragraph(`You've successfully signed up for GrantLume using your <strong>${params.provider}</strong> account. Your account is already verified and ready to use.`),
      paragraph('Start your <strong>14-day free trial</strong> now — no credit card required.'),
      infoBox(`
        <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:${NAVY};">Quick start guide</p>
        <ul style="margin:0;padding-left:18px;font-size:13px;line-height:2;color:${TEXT_SEC};">
          <li>Create your organisation</li>
          <li>Add your first project</li>
          <li>Invite team members</li>
          <li>Configure allocations and timesheets</li>
        </ul>
      `),
      button('Go to Dashboard', params.dashboardUrl),
    ].join('')),
  }
}

export function emailChangedEmail(params: {
  firstName: string; newEmail: string
}): EmailTemplate {
  return {
    subject: 'Your GrantLume email address has been changed',
    html: layout('Email Changed', [
      heading('Email Address Changed'),
      paragraph(`Hi ${params.firstName}, your GrantLume account email has been updated to <strong>${params.newEmail}</strong>.`),
      infoBox(`If you did not make this change, please contact us immediately at <strong>hello@grantlume.com</strong> to secure your account.`, DANGER, '#fef2f2'),
    ].join('')),
  }
}

export function passwordChangedEmail(params: {
  firstName: string
}): EmailTemplate {
  return {
    subject: 'Your GrantLume password has been changed',
    html: layout('Password Changed', [
      heading('Password Changed'),
      paragraph(`Hi ${params.firstName}, your GrantLume account password was successfully changed.`),
      infoBox(`If you did not make this change, please reset your password immediately or contact us at <strong>hello@grantlume.com</strong>.`, DANGER, '#fef2f2'),
      button('Reset Password', 'https://app.grantlume.com/forgot-password', DANGER),
    ].join('')),
  }
}

export function absenceRequestedEmail(params: {
  approverName: string; requesterName: string; absenceType: string; startDate: string; endDate: string; days: string; absencesUrl: string
}): EmailTemplate {
  return {
    subject: `Absence Request: ${params.requesterName} — ${params.absenceType}`,
    html: layout('Absence Request', [
      heading('New Absence Request'),
      paragraph(`Hi ${params.approverName},`),
      paragraph(`<strong>${params.requesterName}</strong> has submitted an absence request that requires your approval:`),
      detailTable(
        detailRow('Employee', params.requesterName) +
        detailRow('Type', params.absenceType) +
        detailRow('Period', `${params.startDate} — ${params.endDate}`) +
        detailRow('Days', params.days) +
        detailRow('Status', statusBadge('Pending', WARNING, '#fef3c7'))
      ),
      button('Review Request', params.absencesUrl),
    ].join('')),
  }
}

export function absenceApprovedEmail(params: {
  employeeName: string; absenceType: string; startDate: string; endDate: string; days: string; absencesUrl: string
}): EmailTemplate {
  return {
    subject: `Absence Approved: ${params.absenceType} (${params.startDate} — ${params.endDate})`,
    html: layout('Absence Approved', [
      heading('Absence Approved'),
      paragraph(`Hi ${params.employeeName},`),
      paragraph(`Your absence request has been ${statusBadge('Approved', SUCCESS, '#ecfdf5')}:`),
      detailTable(
        detailRow('Type', params.absenceType) +
        detailRow('Period', `${params.startDate} — ${params.endDate}`) +
        detailRow('Days', params.days)
      ),
      button('View Absences', params.absencesUrl),
    ].join('')),
  }
}

export function absenceRejectedEmail(params: {
  employeeName: string; absenceType: string; startDate: string; endDate: string; days: string; absencesUrl: string
}): EmailTemplate {
  return {
    subject: `Absence Rejected: ${params.absenceType} (${params.startDate} — ${params.endDate})`,
    html: layout('Absence Rejected', [
      heading('Absence Rejected'),
      paragraph(`Hi ${params.employeeName},`),
      paragraph(`Unfortunately, your absence request has been ${statusBadge('Rejected', DANGER, '#fef2f2')}:`),
      detailTable(
        detailRow('Type', params.absenceType) +
        detailRow('Period', `${params.startDate} — ${params.endDate}`) +
        detailRow('Days', params.days)
      ),
      paragraph('Please contact your manager for further details or to discuss alternative dates.'),
      button('View Absences', params.absencesUrl),
    ].join('')),
  }
}

// ── NEW templates ───────────────────────────────────────

/** #20 — Notify approvers that an employee cancelled their absence */
export function absenceCancelledEmail(params: {
  approverName: string; employeeName: string; absenceType: string; startDate: string; endDate: string; days: string; absencesUrl: string
}): EmailTemplate {
  return {
    subject: `Absence Cancelled: ${params.employeeName} — ${params.absenceType}`,
    html: layout('Absence Cancelled', [
      heading('Absence Cancelled'),
      paragraph(`Hi ${params.approverName},`),
      paragraph(`<strong>${params.employeeName}</strong> has cancelled their absence request:`),
      detailTable(
        detailRow('Employee', params.employeeName) +
        detailRow('Type', params.absenceType) +
        detailRow('Period', `${params.startDate} — ${params.endDate}`) +
        detailRow('Days', params.days) +
        detailRow('Status', statusBadge('Cancelled', MUTED, '#f1f5f9'))
      ),
      paragraph(`<span style="font-size:13px;color:${MUTED};">No action is required on your part.</span>`),
    ].join('')),
  }
}

/** #21 — Notify org admins that a new project was created */
export function projectCreatedEmail(params: {
  recipientName: string; orgName: string; projectAcronym: string; projectTitle: string; createdBy: string; projectUrl: string
}): EmailTemplate {
  return {
    subject: `New Project: ${params.projectAcronym} — ${params.projectTitle}`,
    html: layout('New Project', [
      heading('New Project Created'),
      paragraph(`Hi ${params.recipientName},`),
      paragraph(`A new project has been added to <strong>${params.orgName}</strong>:`),
      detailTable(
        detailRow('Acronym', `<strong>${params.projectAcronym}</strong>`) +
        detailRow('Title', params.projectTitle) +
        detailRow('Created By', params.createdBy)
      ),
      button('View Project', params.projectUrl),
    ].join('')),
  }
}

/** #22 — Notify a person that their staff record has been deactivated */
export function staffDeactivatedEmail(params: {
  employeeName: string; orgName: string
}): EmailTemplate {
  return {
    subject: `Your account in ${params.orgName} has been deactivated`,
    html: layout('Account Deactivated', [
      heading('Account Deactivated'),
      paragraph(`Hi ${params.employeeName},`),
      paragraph(`Your staff account in <strong>${params.orgName}</strong> has been deactivated. You may no longer have access to certain modules.`),
      paragraph('If you believe this was done in error, please contact your organisation administrator.'),
    ].join('')),
  }
}

/** #23 — Notify a staff member that their PM allocation was changed */
export function allocationChangedEmail(params: {
  employeeName: string; orgName: string; projectAcronym: string; year: number; oldPms: string; newPms: string; allocationsUrl: string
}): EmailTemplate {
  return {
    subject: `Allocation Updated: ${params.projectAcronym} (${params.year})`,
    html: layout('Allocation Updated', [
      heading('Allocation Updated'),
      paragraph(`Hi ${params.employeeName},`),
      paragraph(`Your person-month allocation on <strong>${params.projectAcronym}</strong> in <strong>${params.orgName}</strong> has been updated:`),
      detailTable(
        detailRow('Project', params.projectAcronym) +
        detailRow('Year', String(params.year)) +
        detailRow('Previous PMs', params.oldPms) +
        detailRow('New PMs', `<strong style="color:${BRAND};">${params.newPms}</strong>`)
      ),
      button('View Allocations', params.allocationsUrl),
    ].join('')),
  }
}

/** #25 — Notify proposal team that the status changed */
export function proposalStatusChangedEmail(params: {
  recipientName: string; orgName: string; proposalTitle: string; oldStatus: string; newStatus: string; changedBy: string; proposalsUrl: string
}): EmailTemplate {
  const color = params.newStatus === 'Approved' ? SUCCESS : params.newStatus === 'Rejected' ? DANGER : BRAND
  const bg = params.newStatus === 'Approved' ? '#ecfdf5' : params.newStatus === 'Rejected' ? '#fef2f2' : '#f0fdfa'
  return {
    subject: `Proposal "${params.proposalTitle}" — ${params.newStatus}`,
    html: layout('Proposal Update', [
      heading('Proposal Status Updated'),
      paragraph(`Hi ${params.recipientName},`),
      paragraph(`A proposal in <strong>${params.orgName}</strong> has been updated:`),
      detailTable(
        detailRow('Proposal', params.proposalTitle) +
        detailRow('Previous Status', params.oldStatus) +
        detailRow('New Status', statusBadge(params.newStatus, color, bg)) +
        detailRow('Updated By', params.changedBy)
      ),
      button('View Proposals', params.proposalsUrl),
    ].join('')),
  }
}

/** #26 — Notify a user that they have been removed from an organisation */
export function memberRemovedEmail(params: {
  userName: string; orgName: string
}): EmailTemplate {
  return {
    subject: `You've been removed from ${params.orgName} on GrantLume`,
    html: layout('Membership Removed', [
      heading('Organisation Access Removed'),
      paragraph(`Hi ${params.userName},`),
      paragraph(`Your membership in <strong>${params.orgName}</strong> on GrantLume has been removed. You will no longer have access to this organisation's data.`),
      paragraph('If you believe this was done in error, please contact the organisation administrator.'),
      paragraph(`<span style="font-size:13px;color:${MUTED};">You can still access GrantLume with any other organisations you belong to.</span>`),
    ].join('')),
  }
}

/** #27 — Notify a substitute that they are covering for a colleague's absence */
export function substituteNotificationEmail(params: {
  substituteName: string; absenteeName: string; absenceType: string;
  startDate: string; endDate: string; days: string; absencesUrl: string
}): EmailTemplate {
  return {
    subject: `You've been nominated as substitute for ${params.absenteeName}`,
    html: layout('Substitute Coverage', [
      heading('Substitute Nomination'),
      paragraph(`Hi ${params.substituteName},`),
      paragraph(`<strong>${params.absenteeName}</strong> has nominated you as their substitute during their upcoming absence. Their leave has been approved.`),
      infoBox([
        `<strong>Type:</strong> ${params.absenceType}`,
        `<strong>Period:</strong> ${params.startDate} – ${params.endDate}`,
        `<strong>Duration:</strong> ${params.days} day${params.days === '1' ? '' : 's'}`,
      ].join('<br/>')),
      paragraph('Please coordinate with your colleague before their leave begins to ensure a smooth handover of any ongoing tasks or responsibilities.'),
      button('View Absences', params.absencesUrl),
      paragraph(`<span style="font-size:13px;color:${MUTED};">You can manage your notification preferences in your GrantLume profile settings.</span>`),
    ].join('')),
  }
}

export function collabPartnerInvitationEmail(params: {
  contactName: string; orgName: string; projectAcronym: string; projectTitle: string;
  coordinatorOrg: string; senderName: string; role: string; acceptUrl: string
}): EmailTemplate {
  return {
    subject: `You're invited to join "${params.projectAcronym}" on GrantLume`,
    html: layout('Collaboration Invitation', [
      heading('Project Collaboration Invitation'),
      paragraph(`Hi ${params.contactName || 'there'},`),
      paragraph(`<strong>${params.senderName}</strong> from <strong>${params.coordinatorOrg}</strong> has invited <strong>${params.orgName}</strong> to collaborate on a research project via GrantLume.`),
      detailTable(
        detailRow('Project', `${params.projectAcronym} — ${params.projectTitle}`) +
        detailRow('Your Role', params.role === 'coordinator' ? 'Coordinator' : 'Partner') +
        detailRow('Coordinator', params.coordinatorOrg)
      ),
      paragraph('By accepting this invitation, you will be able to submit financial reports and track your project contributions directly on GrantLume.'),
      button('Accept Invitation', params.acceptUrl),
      paragraph(`<span style="font-size:13px;color:${MUTED};">If you weren't expecting this invitation, you can safely ignore this email. The link will remain valid.</span>`),
    ].join('')),
  }
}

export function collabReportReminderEmail(params: {
  contactName: string; orgName: string; projectAcronym: string;
  periodTitle: string; dueDate: string; reportUrl: string
}): EmailTemplate {
  return {
    subject: `Reporting reminder: ${params.periodTitle} for ${params.projectAcronym}`,
    html: layout('Report Reminder', [
      heading('Financial Report Due'),
      paragraph(`Hi ${params.contactName || 'there'},`),
      paragraph(`This is a reminder that the financial report for <strong>${params.orgName}</strong> is due for the reporting period below.`),
      detailTable(
        detailRow('Project', params.projectAcronym) +
        detailRow('Period', params.periodTitle) +
        detailRow('Due Date', params.dueDate)
      ),
      button('Submit Report', params.reportUrl),
      paragraph(`<span style="font-size:13px;color:${MUTED};">You can manage your notification preferences in your GrantLume profile settings.</span>`),
    ].join('')),
  }
}

export function collabDeliverableReminderEmail(params: {
  contactName: string; orgName: string; projectAcronym: string;
  deliverableNumber: string; deliverableTitle: string; dueMonth: number;
  dueDate: string; projectUrl: string
}): EmailTemplate {
  return {
    subject: `Deliverable due soon: ${params.deliverableNumber} — ${params.projectAcronym}`,
    html: layout('Deliverable Reminder', [
      heading('Deliverable Due Soon'),
      paragraph(`Hi ${params.contactName || 'there'},`),
      paragraph(`A deliverable assigned to <strong>${params.orgName}</strong> is due soon. Please ensure it is prepared and submitted on time.`),
      detailTable(
        detailRow('Project', params.projectAcronym) +
        detailRow('Deliverable', `${params.deliverableNumber} — ${params.deliverableTitle}`) +
        detailRow('Due', `Month ${params.dueMonth} (${params.dueDate})`)
      ),
      button('View Project', params.projectUrl),
      paragraph(`<span style="font-size:13px;color:${MUTED};">You can manage your notification preferences in your GrantLume profile settings.</span>`),
    ].join('')),
  }
}

export function collabMilestoneReminderEmail(params: {
  contactName: string; orgName: string; projectAcronym: string;
  milestoneNumber: string; milestoneTitle: string; dueMonth: number;
  dueDate: string; projectUrl: string
}): EmailTemplate {
  return {
    subject: `Milestone due soon: ${params.milestoneNumber} — ${params.projectAcronym}`,
    html: layout('Milestone Reminder', [
      heading('Milestone Due Soon'),
      paragraph(`Hi ${params.contactName || 'there'},`),
      paragraph(`A milestone in project <strong>${params.projectAcronym}</strong> is due soon. Please ensure all verification means are prepared.`),
      detailTable(
        detailRow('Project', params.projectAcronym) +
        detailRow('Milestone', `${params.milestoneNumber} — ${params.milestoneTitle}`) +
        detailRow('Due', `Month ${params.dueMonth} (${params.dueDate})`)
      ),
      button('View Project', params.projectUrl),
      paragraph(`<span style="font-size:13px;color:${MUTED};">You can manage your notification preferences in your GrantLume profile settings.</span>`),
    ].join('')),
  }
}

// ── Timesheet Signing Flow ──────────────────────────────

export function timesheetReadyToSignEmail(params: {
  personName: string; period: string; totalHours: string;
  signingUrl: string; orgName: string
}): EmailTemplate {
  return {
    subject: `Timesheet ready for signing: ${params.period}`,
    html: layout('Sign Your Timesheet', [
      heading('Your Timesheet Is Ready to Sign'),
      paragraph(`Hi ${params.personName},`),
      paragraph(`Your timesheet for <strong>${params.period}</strong> has been submitted and is now ready for your e-signature.`),
      detailTable(
        detailRow('Period', params.period) +
        detailRow('Total Hours', params.totalHours) +
        detailRow('Organisation', params.orgName)
      ),
      paragraph('Please review your timesheet and sign it using DocuSign by clicking the button below.'),
      button('Sign Timesheet', params.signingUrl, WARNING),
      paragraph(`<span style="font-size:13px;color:${MUTED};">If the button doesn't work, copy and paste this URL into your browser:<br/><a href="${params.signingUrl}" style="color:${BRAND};word-break:break-all;">${params.signingUrl}</a></span>`),
    ].join('')),
  }
}

export function timesheetSignedEmail(params: {
  approverName: string; personName: string; period: string;
  totalHours: string; timesheetUrl: string
}): EmailTemplate {
  return {
    subject: `Timesheet signed: ${params.personName} — ${params.period}`,
    html: layout('Timesheet Signed', [
      heading('Timesheet Signed — Ready for Approval'),
      paragraph(`Hi ${params.approverName},`),
      paragraph(`<strong>${params.personName}</strong> has signed their timesheet for <strong>${params.period}</strong>. It is now ready for your review and approval.`),
      detailTable(
        detailRow('Employee', params.personName) +
        detailRow('Period', params.period) +
        detailRow('Total Hours', params.totalHours)
      ),
      button('Review Timesheets', params.timesheetUrl),
    ].join('')),
  }
}

export function timesheetApprovedEmail(params: {
  personName: string; period: string; approverName: string;
  timesheetUrl: string
}): EmailTemplate {
  return {
    subject: `Timesheet approved: ${params.period}`,
    html: layout('Timesheet Approved', [
      heading('Your Timesheet Has Been Approved'),
      paragraph(`Hi ${params.personName},`),
      paragraph(`Great news! Your timesheet for <strong>${params.period}</strong> has been <strong style="color:${SUCCESS};">approved</strong> by ${params.approverName}.`),
      detailTable(
        detailRow('Period', params.period) +
        detailRow('Status', `<span style="color:${SUCCESS};font-weight:700;">✓ Approved</span>`) +
        detailRow('Approved by', params.approverName)
      ),
      button('View Timesheet', params.timesheetUrl),
    ].join('')),
  }
}

export function timesheetRejectedEmail(params: {
  personName: string; period: string; approverName: string;
  reason?: string; timesheetUrl: string
}): EmailTemplate {
  return {
    subject: `Timesheet rejected: ${params.period}`,
    html: layout('Timesheet Rejected', [
      heading('Your Timesheet Needs Revision'),
      paragraph(`Hi ${params.personName},`),
      paragraph(`Your timesheet for <strong>${params.period}</strong> has been <strong style="color:${DANGER};">rejected</strong> by ${params.approverName}. Please review and resubmit.`),
      detailTable(
        detailRow('Period', params.period) +
        detailRow('Status', `<span style="color:${DANGER};font-weight:700;">✗ Rejected</span>`) +
        detailRow('Reviewed by', params.approverName)
      ),
      params.reason ? infoBox(`<strong>Reason:</strong> ${params.reason}`, DANGER, '#fef2f2') : '',
      button('Revise Timesheet', params.timesheetUrl),
    ].join('')),
  }
}

export function collabReportStatusEmail(params: {
  contactName: string; orgName: string; projectAcronym: string;
  periodTitle: string; status: string; reviewerName: string;
  rejectionNote?: string; reportUrl: string
}): EmailTemplate {
  const approved = params.status === 'approved'
  return {
    subject: `Report ${approved ? 'approved' : 'returned'}: ${params.periodTitle} — ${params.projectAcronym}`,
    html: layout(approved ? 'Report Approved' : 'Report Returned', [
      heading(approved ? 'Report Approved' : 'Report Returned for Corrections'),
      paragraph(`Hi ${params.contactName || 'there'},`),
      paragraph(approved
        ? `Your financial report for <strong>${params.orgName}</strong> has been <strong style="color:${SUCCESS};">approved</strong> by ${params.reviewerName}.`
        : `Your financial report for <strong>${params.orgName}</strong> has been <strong style="color:${DANGER};">returned</strong> by ${params.reviewerName} with corrections needed.`
      ),
      detailTable(
        detailRow('Project', params.projectAcronym) +
        detailRow('Period', params.periodTitle) +
        detailRow('Status', approved ? '✓ Approved' : '✗ Needs Corrections')
      ),
      params.rejectionNote
        ? infoBox(`<strong>Reviewer note:</strong> ${params.rejectionNote}`, DANGER, '#fef2f2')
        : '',
      button(approved ? 'View Report' : 'Revise Report', params.reportUrl),
    ].join('')),
  }
}

// ── Support Request (sent to hello@grantlume.com) ────────────
export function supportRequestEmail(params: {
  senderName: string; senderEmail: string; orgName: string; subject: string; message: string
}): EmailTemplate {
  return {
    subject: `[Support] ${params.subject}`,
    html: layout('Support Request', [
      heading('New Support Request'),
      detailTable(
        detailRow('From', `${params.senderName} &lt;${params.senderEmail}&gt;`) +
        detailRow('Organisation', params.orgName || '—') +
        detailRow('Subject', params.subject)
      ),
      paragraph(params.message.replace(/\n/g, '<br/>')),
      paragraph(`<span style="font-size:12px;color:${MUTED};">Reply directly to this email to respond to the user at ${params.senderEmail}.</span>`),
    ].join('')),
  }
}
