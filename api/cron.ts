import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import {
  timesheetReminderEmail,
  projectEndingSoonEmail,
  trialExpiringEmail,
  trialExpiredEmail,
  collabReportReminderEmail,
  collabDeliverableReminderEmail,
  collabMilestoneReminderEmail,
  renderEmail,
} from './emails/templates.js'
import { appUrl } from './lib/appUrl.js'

/** Maps template names to user_preferences column */
/**
 * These jobs fan out across every organisation, so they need far more than the
 * default function timeout. Without this they were silently cut off part-way
 * through, sending some reminders and not others. See BACKLOG.md B14 for the
 * remaining batching / idempotency work.
 */
export const config = {
  maxDuration: 300,
}

function appUrlResolved(): string {
  return appUrl()
}

const CRON_PREF_MAP: Record<string, string> = {
  timesheetReminder: 'email_timesheet_reminders',
  projectEndingSoon: 'email_project_alerts',
  trialExpiring: 'email_trial_expiring',
  collabReportReminder: 'email_collab_notifications',
  collabDeliverableReminder: 'email_collab_notifications',
  collabMilestoneReminder: 'email_collab_notifications',
}

/**
 * Check if a user has opted out of a given email type.
 * Also returns their unsubscribe_token for footer personalization.
 */
async function checkCronRecipient(
  supabase: any,
  userId: string,
  templateName: string,
): Promise<{ allowed: boolean; unsubscribeToken: string | null }> {
  try {
    const prefCol = CRON_PREF_MAP[templateName]
    const selectCols = prefCol ? `${prefCol}, unsubscribe_token` : 'unsubscribe_token'

    const { data: prefs } = await supabase
      .from('user_preferences')
      .select(selectCols)
      .eq('user_id', userId)

    if (!prefs || prefs.length === 0) return { allowed: true, unsubscribeToken: null }

    const token = prefs[0]?.unsubscribe_token ?? null

    if (prefCol) {
      const optedOut = prefs.some((p: any) => p[prefCol] === false)
      if (optedOut) return { allowed: false, unsubscribeToken: token }
    }

    return { allowed: true, unsubscribeToken: token }
  } catch {
    return { allowed: true, unsubscribeToken: null }
  }
}

/** Build the per-recipient email-preferences URL. */
function prefsUrl(token: string | null, base: string): string | undefined {
  return token ? `${base}/email-preferences?token=${encodeURIComponent(token)}` : undefined
}

/**
 * Consolidated cron handler — dispatches by ?job= query parameter.
 * Jobs: timesheet-reminders, project-alerts, collab-reminders
 *
 * Vercel cron config calls this single function with different query params:
 *   /api/cron?job=timesheet-reminders
 *   /api/cron?job=project-alerts
 *   /api/cron?job=collab-reminders
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Require CRON_SECRET unconditionally. Missing env var → service
  // misconfiguration; never silently skip the check.
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[cron] CRON_SECRET env var is not set — refusing to run')
    return res.status(500).json({ error: 'Cron secret not configured' })
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const resendKey = process.env.RESEND_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!resendKey || !supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing environment variables' })
  }

  const supabase: any = createClient(supabaseUrl, supabaseKey)
  const resend = new Resend(resendKey)
  const appUrl = appUrlResolved()
  const from = 'GrantLume <notifications@grantlume.com>'

  const job = (req.query.job as string) || ''

  switch (job) {
    case 'timesheet-reminders':
      return runTimesheetReminders(supabase, resend, from, appUrl, res)
    case 'project-alerts':
      return runProjectAlerts(supabase, resend, from, appUrl, res)
    case 'collab-reminders':
      return runCollabReminders(supabase, resend, from, appUrl, res)
    default:
      return res.status(400).json({ error: `Unknown job: "${job}". Use ?job=timesheet-reminders|project-alerts|collab-reminders` })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Job 1: Timesheet Reminders (weekly, Monday 9am)
// ════════════════════════════════════════════════════════════════════════════
async function runTimesheetReminders(
  supabase: any,
  resend: InstanceType<typeof Resend>,
  from: string,
  appUrl: string,
  res: VercelResponse,
) {
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1
  const period = `${now.toLocaleString('en', { month: 'long' })} ${currentYear}`
  let totalSent = 0

  try {
    const { data: orgs } = await supabase
      .from('organisations')
      .select('id, name')
      .eq('is_active', true)

    if (!orgs || orgs.length === 0) {
      return res.status(200).json({ job: 'timesheet-reminders', sent: 0 })
    }

    for (const org of orgs) {
      const { data: members } = await supabase
        .from('org_members')
        .select('user_id, role')
        .eq('org_id', org.id)

      if (!members || members.length === 0) continue

      const { data: existingEntries } = await supabase
        .from('timesheet_entries')
        .select('person_id')
        .eq('org_id', org.id)
        .eq('year', currentYear)
        .eq('month', currentMonth)

      const submittedPersonIds = new Set((existingEntries ?? []).map((e: any) => e.person_id))

      const { data: persons } = await supabase
        .from('persons')
        .select('id, full_name, email')
        .eq('org_id', org.id)
        .eq('is_active', true)

      if (!persons) continue

      // Build email→userId map for preference checks
      const memberMap = new Map<string, string>()
      for (const m of members) {
        const { data: ud } = await supabase.auth.admin.getUserById(m.user_id)
        if (ud?.user?.email) memberMap.set(ud.user.email.toLowerCase(), m.user_id)
      }

      for (const person of persons) {
        if (!person.email || submittedPersonIds.has(person.id)) continue

        // Check email preferences
        const userId = memberMap.get(person.email.toLowerCase())
        if (userId) {
          const { allowed, unsubscribeToken } = await checkCronRecipient(supabase, userId, 'timesheetReminder')
          if (!allowed) continue

          const { subject, html } = renderEmail(timesheetReminderEmail, {
            userName: person.full_name,
            orgName: org.name,
            period,
            timesheetUrl: `${appUrl}/timesheets`,
          }, prefsUrl(unsubscribeToken, appUrl))

          try {
            await resend.emails.send({ from, to: person.email, subject, html })
            totalSent++
          } catch (emailErr) {
            console.error(`[cron] Failed to send timesheet reminder to ${person.email}:`, emailErr)
          }
        } else {
          // No user account found — send without preference check
          const { subject, html } = renderEmail(timesheetReminderEmail, {
            userName: person.full_name,
            orgName: org.name,
            period,
            timesheetUrl: `${appUrl}/timesheets`,
          })
          try {
            await resend.emails.send({ from, to: person.email, subject, html })
            totalSent++
          } catch (emailErr) {
            console.error(`[cron] Failed to send timesheet reminder to ${person.email}:`, emailErr)
          }
        }
      }
    }

    return res.status(200).json({ job: 'timesheet-reminders', sent: totalSent })
  } catch (err: any) {
    console.error('[cron] timesheet-reminders error:', err)
    return res.status(500).json({ error: err.message })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Job 2: Project Alerts — ending soon + trial expiring (daily 8am)
// ════════════════════════════════════════════════════════════════════════════
async function runProjectAlerts(
  supabase: any,
  resend: InstanceType<typeof Resend>,
  from: string,
  appUrl: string,
  res: VercelResponse,
) {
  const now = new Date()
  let totalSent = 0

  try {
    // ── 1. Project ending soon alerts (30, 14, 7 days) ──
    const alertDays = [30, 14, 7]

    for (const days of alertDays) {
      const targetDate = new Date(now)
      targetDate.setDate(targetDate.getDate() + days)
      const dateStr = targetDate.toISOString().split('T')[0]

      const { data: projects } = await supabase
        .from('projects')
        .select('id, org_id, acronym, title, end_date')
        .eq('status', 'Active')
        .eq('end_date', dateStr)

      if (!projects || projects.length === 0) continue

      for (const project of projects) {
        const { data: managers } = await supabase
          .from('org_members')
          .select('user_id, role')
          .eq('org_id', project.org_id)
          .in('role', ['Admin', 'Project Manager'])

        if (!managers || managers.length === 0) continue

        const { data: org } = await supabase
          .from('organisations')
          .select('name')
          .eq('id', project.org_id)
          .single()

        for (const manager of managers) {
          const { data: userData } = await supabase.auth.admin.getUserById(manager.user_id)
          const email = userData?.user?.email
          if (!email) continue

          const { allowed, unsubscribeToken } = await checkCronRecipient(supabase, manager.user_id, 'projectEndingSoon')
          if (!allowed) continue

          const { subject, html } = renderEmail(projectEndingSoonEmail, {
            recipientName: email.split('@')[0],
            orgName: org?.name ?? 'your organisation',
            projectAcronym: project.acronym,
            projectTitle: project.title,
            endDate: project.end_date,
            daysRemaining: days,
            projectUrl: `${appUrl}/projects/${project.id}`,
          }, prefsUrl(unsubscribeToken, appUrl))

          try {
            await resend.emails.send({ from, to: email, subject, html })
            totalSent++
          } catch (emailErr) {
            console.error(`[cron] Failed to send project alert to ${email}:`, emailErr)
          }
        }
      }
    }

    // ── 2. Trial expiring reminders (14, 7, 3, 1 days) + expired (0 days) ──
    //    Trial duration is 30 days. On expiry (0), downgrade plan to 'free'.
    const trialAlertDays = [14, 7, 3, 1, 0]

    for (const days of trialAlertDays) {
      const targetDate = new Date(now)
      targetDate.setDate(targetDate.getDate() + days)
      const dateStr = targetDate.toISOString().split('T')[0]

      const { data: orgs } = await supabase
        .from('organisations')
        .select('id, name, plan, trial_ends_at')
        .eq('is_active', true)
        .eq('plan', 'trial')
        .not('trial_ends_at', 'is', null)

      if (!orgs) continue

      for (const org of orgs) {
        if (!org.trial_ends_at) continue
        const trialDate = org.trial_ends_at.split('T')[0]
        if (trialDate !== dateStr) continue

        // On expiry day, downgrade to 'free' plan in the database
        if (days === 0) {
          await supabase.from('organisations').update({
            plan: 'free',
            updated_at: new Date().toISOString(),
          }).eq('id', org.id)
        }

        const { data: admins } = await supabase
          .from('org_members')
          .select('user_id')
          .eq('org_id', org.id)
          .eq('role', 'Admin')

        if (!admins) continue

        for (const admin of admins) {
          const { data: userData } = await supabase.auth.admin.getUserById(admin.user_id)
          const email = userData?.user?.email
          if (!email) continue

          const { allowed, unsubscribeToken } = await checkCronRecipient(supabase, admin.user_id, 'trialExpiring')
          if (!allowed) continue

          // Send appropriate email
          if (days === 0) {
            const { subject, html } = renderEmail(trialExpiredEmail, {
              userName: email.split('@')[0],
              orgName: org.name,
              upgradeUrl: `${appUrl}/settings?tab=subscription`,
            }, prefsUrl(unsubscribeToken, appUrl))
            try {
              await resend.emails.send({ from, to: email, subject, html })
              totalSent++
            } catch (emailErr) {
              console.error(`[cron] Failed to send trial expired email to ${email}:`, emailErr)
            }
          } else {
            const { subject, html } = renderEmail(trialExpiringEmail, {
              userName: email.split('@')[0],
              orgName: org.name,
              daysRemaining: days,
              upgradeUrl: `${appUrl}/settings?tab=subscription`,
            }, prefsUrl(unsubscribeToken, appUrl))
            try {
              await resend.emails.send({ from, to: email, subject, html })
              totalSent++
            } catch (emailErr) {
              console.error(`[cron] Failed to send trial alert to ${email}:`, emailErr)
            }
          }

          // In-app notification
          try {
            const notifTitle = days === 0
              ? 'Your free trial has expired'
              : `Trial expires in ${days} day${days === 1 ? '' : 's'}`
            const notifMessage = days === 0
              ? `Your free trial for ${org.name} has ended. You are now on the Free plan. Upgrade to Pro to restore full access.`
              : `Your free trial for ${org.name} expires in ${days} day${days === 1 ? '' : 's'}. Upgrade now to avoid losing features.`
            await supabase.from('notifications').insert({
              user_id: admin.user_id,
              org_id: org.id,
              type: days === 0 ? 'trial_expired' : 'trial_expiring',
              title: notifTitle,
              message: notifMessage,
              link: '/settings?tab=subscription',
            })
          } catch { /* ignore notification errors */ }
        }
      }
    }

    return res.status(200).json({ job: 'project-alerts', sent: totalSent })
  } catch (err: any) {
    console.error('[cron] project-alerts error:', err)
    return res.status(500).json({ error: err.message })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Job 3: Collab Reminders — per-project settings for reports, deliverables
//         and milestones (daily 9am). Also creates in-app notifications.
// ════════════════════════════════════════════════════════════════════════════

/** Convert reminder setting {lead_time, unit} to days */
function reminderToDays(leadTime: number, unit: string): number {
  switch (unit) {
    case 'weeks': return leadTime * 7
    case 'months': return leadTime * 30
    default: return leadTime
  }
}

async function runCollabReminders(
  supabase: any,
  resend: InstanceType<typeof Resend>,
  from: string,
  appUrl: string,
  res: VercelResponse,
) {
  const now = new Date()
  let totalSent = 0
  let totalNotifs = 0

  const defaultSettings = {
    deliverables: { enabled: true, lead_time: 14, unit: 'days' },
    milestones: { enabled: true, lead_time: 14, unit: 'days' },
    reports: { enabled: true, lead_time: 7, unit: 'days' },
  }

  try {
    // Load all active projects with their reminder settings
    const { data: activeProjects } = await supabase
      .from('projects')
      .select('id, acronym, title, start_date, duration_months, reminder_settings, org_id, created_by')
      .eq('status', 'Active')

    if (!activeProjects || activeProjects.length === 0) {
      return res.status(200).json({ job: 'collab-reminders', sent: 0, notifications: 0 })
    }

    for (const proj of activeProjects) {
      const settings = { ...defaultSettings, ...(proj.reminder_settings || {}) }

      // ── 1. Report due reminders ──
      if (settings.reports?.enabled) {
        const leadDays = reminderToDays(settings.reports.lead_time, settings.reports.unit)
        const reminderDate = new Date(now)
        reminderDate.setDate(reminderDate.getDate() + leadDays)
        const reminderDateStr = reminderDate.toISOString().split('T')[0]

        const { data: duePeriods } = await supabase
          .from('reporting_periods')
          .select('id, title, start_month, end_month, due_date')
          .eq('project_id', proj.id)
          .eq('due_date', reminderDateStr)
          .eq('reports_generated', true)

        if (duePeriods && duePeriods.length > 0) {
          for (const period of duePeriods) {
            const { data: draftReports } = await supabase
              .from('project_reports')
              .select('id, partner_id, status')
              .eq('period_id', period.id)
              .in('status', ['draft', 'rejected'])

            if (!draftReports || draftReports.length === 0) continue

            for (const report of draftReports) {
              const { data: partner } = await supabase
                .from('project_partners')
                .select('id, org_name, contact_name, contact_email, user_id')
                .eq('id', report.partner_id)
                .single()

              if (!partner) continue

              // Email
              if (partner.contact_email) {
                // Check preferences if user has an account
                let skipEmail = false
                let unsubToken: string | null = null
                if (partner.user_id) {
                  const { allowed, unsubscribeToken } = await checkCronRecipient(supabase, partner.user_id, 'collabReportReminder')
                  if (!allowed) skipEmail = true
                  unsubToken = unsubscribeToken
                }
                if (!skipEmail) {
                  try {
                    const template = renderEmail(collabReportReminderEmail, {
                      contactName: partner.contact_name || '',
                      orgName: partner.org_name,
                      projectAcronym: proj.acronym,
                      periodTitle: period.title,
                      dueDate: period.due_date,
                      reportUrl: `${appUrl}/projects/collaboration/report/${report.id}`,
                    }, prefsUrl(unsubToken, appUrl))
                    await resend.emails.send({ from, to: partner.contact_email, subject: template.subject, html: template.html })
                    totalSent++
                  } catch (err) {
                    console.error(`[cron] Failed to send report reminder to ${partner.contact_email}:`, err)
                  }
                }
              }

              // In-app notification
              if (partner.user_id) {
                try {
                  await supabase.from('notifications').insert({
                    user_id: partner.user_id,
                    org_id: proj.org_id,
                    type: 'collab_report_reminder',
                    title: `Report due: ${period.title} — ${proj.acronym}`,
                    message: `Your financial report for ${partner.org_name} is due on ${period.due_date}. Please submit it on time.`,
                    link: `/projects/collaboration/report/${report.id}`,
                  })
                  totalNotifs++
                } catch { /* ignore */ }
              }
            }
          }
        }
      }

      // ── 2. Deliverable due reminders ──
      if (settings.deliverables?.enabled && proj.start_date) {
        const leadDays = reminderToDays(settings.deliverables.lead_time, settings.deliverables.unit)
        const projectStart = new Date(proj.start_date)

        const { data: dels } = await supabase
          .from('deliverables')
          .select('id, number, title, due_month, leader_partner_id')
          .eq('project_id', proj.id)

        if (dels && dels.length > 0) {
          for (const del of dels) {
            if (!del.due_month) continue

            const dueDate = new Date(projectStart)
            dueDate.setMonth(dueDate.getMonth() + del.due_month - 1)
            dueDate.setMonth(dueDate.getMonth() + 1, 0) // last day of month

            const daysUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            if (daysUntilDue !== leadDays) continue

            // Send to leader partner + coordinator
            const partnerIds = new Set<string>()
            if (del.leader_partner_id) partnerIds.add(del.leader_partner_id)

            const { data: coordPartner } = await supabase
              .from('project_partners')
              .select('id')
              .eq('project_id', proj.id)
              .in('role', ['coordinator', 'host'])
              .limit(1)
              .maybeSingle()
            if (coordPartner) partnerIds.add(coordPartner.id)

            for (const pid of partnerIds) {
              const { data: partner } = await supabase
                .from('project_partners')
                .select('id, org_name, contact_name, contact_email, user_id')
                .eq('id', pid)
                .single()
              if (!partner) continue

              if (partner.contact_email) {
                let skipEmail = false
                let unsubToken: string | null = null
                if (partner.user_id) {
                  const { allowed, unsubscribeToken } = await checkCronRecipient(supabase, partner.user_id, 'collabDeliverableReminder')
                  if (!allowed) skipEmail = true
                  unsubToken = unsubscribeToken
                }
                if (!skipEmail) {
                  try {
                    const template = renderEmail(collabDeliverableReminderEmail, {
                      contactName: partner.contact_name || '',
                      orgName: partner.org_name,
                      projectAcronym: proj.acronym,
                      deliverableNumber: del.number,
                      deliverableTitle: del.title,
                      dueMonth: del.due_month,
                      dueDate: dueDate.toISOString().split('T')[0],
                      projectUrl: `${appUrl}/projects/collaboration/${proj.id}`,
                    }, prefsUrl(unsubToken, appUrl))
                    await resend.emails.send({ from, to: partner.contact_email, subject: template.subject, html: template.html })
                    totalSent++
                  } catch (err) {
                    console.error(`[cron] Failed to send deliverable reminder to ${partner.contact_email}:`, err)
                  }
                }
              }

              if (partner.user_id) {
                try {
                  await supabase.from('notifications').insert({
                    user_id: partner.user_id,
                    org_id: proj.org_id,
                    type: 'collab_deliverable_reminder',
                    title: `Deliverable due: ${del.number} — ${proj.acronym}`,
                    message: `Deliverable "${del.title}" is due in ${leadDays} day(s) (M${del.due_month}).`,
                    link: `/projects/collaboration/${proj.id}`,
                  })
                  totalNotifs++
                } catch { /* ignore */ }
              }
            }
          }
        }
      }

      // ── 3. Milestone due reminders ──
      if (settings.milestones?.enabled && proj.start_date) {
        const leadDays = reminderToDays(settings.milestones.lead_time, settings.milestones.unit)
        const projectStart = new Date(proj.start_date)

        const { data: milestones } = await supabase
          .from('milestones')
          .select('id, number, title, due_month, work_package_id')
          .eq('project_id', proj.id)

        if (milestones && milestones.length > 0) {
          for (const ms of milestones) {
            if (!ms.due_month) continue

            const dueDate = new Date(projectStart)
            dueDate.setMonth(dueDate.getMonth() + ms.due_month - 1)
            dueDate.setMonth(dueDate.getMonth() + 1, 0)

            const daysUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            if (daysUntilDue !== leadDays) continue

            // Notify the coordinator (milestones don't have a leader_partner_id)
            const { data: coordPartner } = await supabase
              .from('project_partners')
              .select('id, org_name, contact_name, contact_email, user_id')
              .eq('project_id', proj.id)
              .in('role', ['coordinator', 'host'])
              .limit(1)
              .maybeSingle()

            if (coordPartner) {
              if (coordPartner.contact_email) {
                let skipEmail = false
                let unsubToken: string | null = null
                if (coordPartner.user_id) {
                  const { allowed, unsubscribeToken } = await checkCronRecipient(supabase, coordPartner.user_id, 'collabMilestoneReminder')
                  if (!allowed) skipEmail = true
                  unsubToken = unsubscribeToken
                }
                if (!skipEmail) {
                  try {
                    const template = renderEmail(collabMilestoneReminderEmail, {
                      contactName: coordPartner.contact_name || '',
                      orgName: coordPartner.org_name,
                      projectAcronym: proj.acronym,
                      milestoneNumber: ms.number,
                      milestoneTitle: ms.title,
                      dueMonth: ms.due_month,
                      dueDate: dueDate.toISOString().split('T')[0],
                      projectUrl: `${appUrl}/projects/collaboration/${proj.id}`,
                    }, prefsUrl(unsubToken, appUrl))
                    await resend.emails.send({ from, to: coordPartner.contact_email, subject: template.subject, html: template.html })
                    totalSent++
                  } catch (err) {
                    console.error(`[cron] Failed to send milestone reminder to ${coordPartner.contact_email}:`, err)
                  }
                }
              }

              if (coordPartner.user_id) {
                try {
                  await supabase.from('notifications').insert({
                    user_id: coordPartner.user_id,
                    org_id: proj.org_id,
                    type: 'collab_milestone_reminder',
                    title: `Milestone due: ${ms.number} — ${proj.acronym}`,
                    message: `Milestone "${ms.title}" is due in ${leadDays} day(s) (M${ms.due_month}).`,
                    link: `/projects/collaboration/${proj.id}`,
                  })
                  totalNotifs++
                } catch { /* ignore */ }
              }
            }

            // Also notify project creator if different from coordinator
            if (proj.created_by && proj.created_by !== coordPartner?.user_id) {
              try {
                await supabase.from('notifications').insert({
                  user_id: proj.created_by,
                  org_id: proj.org_id,
                  type: 'collab_milestone_reminder',
                  title: `Milestone due: ${ms.number} — ${proj.acronym}`,
                  message: `Milestone "${ms.title}" is due in ${leadDays} day(s) (M${ms.due_month}).`,
                  link: `/projects/collaboration/${proj.id}`,
                })
                totalNotifs++
              } catch { /* ignore */ }
            }
          }
        }
      }
    }

    return res.status(200).json({ job: 'collab-reminders', sent: totalSent, notifications: totalNotifs })
  } catch (err) {
    console.error('[cron] collab-reminders error:', err)
    return res.status(500).json({ error: 'Cron job failed', details: String(err) })
  }
}
