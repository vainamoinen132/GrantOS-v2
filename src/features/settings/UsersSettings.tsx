import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase'
import { apiFetch } from '@/lib/apiClient'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { ConfirmModal } from '@/components/common/ConfirmModal'
import { toast } from '@/components/ui/use-toast'
import { Plus, Trash2 } from 'lucide-react'
import { emailService } from '@/services/emailService'
import { notificationService } from '@/services/notificationService'
import type { OrgRole, InvitableRole } from '@/types'
import { usePlanLimits } from '@/hooks/usePlanLimits'
import { UpgradeBanner } from '@/components/ui/UpgradeBanner'

interface OrgMember {
  id: string
  user_id: string
  role: OrgRole
  created_at: string
  user_email?: string
  person_name?: string
}

const INVITABLE_ROLES: InvitableRole[] = ['Admin', 'Project Manager', 'Finance Officer']
const ALL_ROLES: OrgRole[] = ['Admin', 'Project Manager', 'Finance Officer', 'External Participant']

export function UsersSettings() {
  const { t } = useTranslation()
  const { orgId, orgName, user } = useAuthStore()
  const planLimits = usePlanLimits()
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<InvitableRole>('Project Manager')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<OrgMember | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchMembers = async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('org_members')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at')

      if (error) throw error
      const rows = (data ?? []) as OrgMember[]

      // Resolve emails from user IDs via server-side API
      if (rows.length > 0) {
        try {
          const res = await apiFetch('/api/members?action=resolve-emails', {
            method: 'POST',
            body: JSON.stringify({ userIds: rows.map((r) => r.user_id) }),
          })
          if (res.ok) {
            const { emails } = await res.json()
            for (const row of rows) {
              row.user_email = emails[row.user_id] ?? undefined
            }
          }
        } catch {
          // Non-critical — emails just won't display
        }
      }

      // Resolve linked person names from persons table
      if (orgId && rows.length > 0) {
        try {
          const { data: persons } = await supabase
            .from('persons')
            .select('user_id, full_name')
            .eq('org_id', orgId)
          if (persons) {
            const personMap: Record<string, string> = {}
            for (const p of persons as any[]) {
              if (p.user_id) personMap[p.user_id] = p.full_name
            }
            for (const row of rows) {
              row.person_name = personMap[row.user_id] ?? undefined
            }
          }
        } catch {
          // Non-critical
        }
      }

      setMembers(rows)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.failedToSave')
      toast({ title: t('common.error'), description: message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchMembers()
  }, [orgId])

  const handleInvite = async () => {
    if (!orgId || !inviteEmail) return
    setSaving(true)
    try {
      // Call server-side API that can use the service role key to
      // create/find the auth user and insert the org_members row.
      const res = await apiFetch('/api/members?action=invite-member', {
        method: 'POST',
        body: JSON.stringify({
          email: inviteEmail,
          orgId,
          role: inviteRole,
          invitedBy: user?.id,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        const detail = data.detail ? ` (${data.detail})` : ''
        toast({
          title: res.status === 409 ? t('settings.alreadyMember') : t('common.error'),
          description: (data.error ?? t('common.failedToSave')) + detail,
          variant: 'destructive',
        })
        setSaving(false)
        return
      }

      const isNew = data.isNewUser
      toast({
        title: isNew ? t('settings.memberInvited') : t('settings.memberAdded'),
        description: isNew
          ? t('settings.invitationSentTo', { email: inviteEmail })
          : t('settings.memberAddedAs', { email: inviteEmail, role: inviteRole }),
      })

      // Send GrantLume-branded invitation email (fire-and-forget)
      const baseUrl = window.location.origin
      const inviteParams = new URLSearchParams({
        type: 'org',
        email: inviteEmail,
        org: orgName ?? 'your organisation',
        role: inviteRole,
        invitedBy: user?.email ?? 'An administrator',
        orgId: orgId,
      })
      emailService.sendInvitation({
        invitedEmail: inviteEmail,
        orgName: orgName ?? 'your organisation',
        role: inviteRole,
        invitedByName: user?.email ?? 'An administrator',
        signUpUrl: `${baseUrl}/invite/accept?${inviteParams.toString()}`,
      }).catch(() => { /* non-blocking */ })

      // In-app notification to admins about the new member
      if (orgId) {
        notificationService.getAdminUserIds(orgId).then((adminIds) => {
          notificationService.notifyMany({
            orgId,
            userIds: adminIds.filter((id) => id !== user?.id),
            type: 'invitation',
            title: t('settings.memberInvited'),
            message: `${inviteEmail} has been invited as ${inviteRole}.`,
            link: '/settings',
          }).catch(() => {})
        }).catch(() => {})
      }

      setInviteOpen(false)
      setInviteEmail('')
      fetchMembers()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.failedToSave')
      toast({ title: t('common.error'), description: message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const handleRoleChange = async (member: OrgMember, newRole: OrgRole) => {
    try {
      const { error } = await supabase
        .from('org_members')
        .update({ role: newRole, updated_at: new Date().toISOString() })
        .eq('id', member.id)

      if (error) throw error
      toast({ title: t('settings.memberRoleUpdated') })

      // Send role change notification email (fire-and-forget)
      if (member.user_email) {
        const baseUrl = window.location.origin
        emailService.sendRoleChanged({
          to: member.user_email,
          userName: member.user_email,
          orgName: orgName ?? 'your organisation',
          oldRole: member.role,
          newRole: newRole,
          dashboardUrl: `${baseUrl}/dashboard`,
        }).catch(() => { /* non-blocking */ })
      }

      // In-app notification to the affected user
      if (orgId) {
        notificationService.notify({
          orgId,
          userId: member.user_id,
          type: 'info',
          title: t('settings.yourRoleHasBeenUpdated'),
          message: t('settings.yourRoleHasBeenUpdatedTo', { role: newRole }),
          link: '/dashboard',
        }).catch(() => {})
      }

      fetchMembers()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.failedToSave')
      toast({ title: t('common.error'), description: message, variant: 'destructive' })
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const memberEmail = deleteTarget.user_email
      const memberName = deleteTarget.person_name || memberEmail?.split('@')[0] || 'User'

      // Send the notice BEFORE removing the membership.
      //
      // /api/send-email now only accepts recipients that are reachable from
      // the caller's organisation. Once the org_members row is gone this
      // address no longer qualifies, so the "you have been removed" email
      // would be rejected. Sending first keeps the recipient provably a member
      // at send time; the trade-off — a spurious notice if the delete below
      // then fails — is both rare and harmless.
      if (memberEmail) {
        await emailService.sendMemberRemoved({
          to: memberEmail,
          userName: memberName,
          orgName: orgName ?? 'the organisation',
        }).catch(() => { /* best effort — never block the removal */ })
      }

      const { error } = await supabase
        .from('org_members')
        .delete()
        .eq('id', deleteTarget.id)

      if (error) throw error
      toast({ title: t('settings.memberRemoved') })
      setDeleteTarget(null)
      fetchMembers()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.failedToDelete')
      toast({ title: t('common.error'), description: message, variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">{t('settings.members')}</CardTitle>
          <Button size="sm" onClick={() => setInviteOpen(true)} disabled={!planLimits.canInviteMember(members.length)}>
            <Plus className="mr-1 h-4 w-4" /> {t('settings.addMember')}
          </Button>
        </CardHeader>
        <CardContent>
          {!planLimits.canInviteMember(members.length) && (
            <UpgradeBanner message={`You have ${members.length} user seats. Your plan allows ${planLimits.limits.maxSeats}. Upgrade to Pro for unlimited seats.`} className="mb-4" />
          )}
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">{t('common.noResults')}</p>
          ) : (
            <div className="rounded-lg border overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">{t('common.member')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('common.role')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('settings.joined')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <div>
                            {m.person_name && (
                              <div className="text-sm font-medium">{m.person_name}</div>
                            )}
                            <span className={m.person_name ? 'text-xs text-muted-foreground' : 'text-sm'}>
                              {m.user_email ?? `${m.user_id.slice(0, 8)}...`}
                            </span>
                          </div>
                          {m.user_id === user?.id && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{t('settings.you')}</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={m.role}
                          onChange={(e) => handleRoleChange(m, e.target.value as OrgRole)}
                          disabled={m.user_id === user?.id}
                          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {new Date(m.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {m.user_id !== user?.id && (
                          <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(m)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.addMember')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('common.email')}</Label>
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('common.role')}</Label>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as InvitableRole)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {INVITABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleInvite} disabled={saving || !inviteEmail}>
              {saving ? t('common.adding') : t('settings.addMember')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('settings.removeMember')}
        message={t('settings.removeMemberConfirm')}
        confirmLabel={t('common.remove')}
        destructive
        loading={deleting}
        onConfirm={handleDelete}
      />
    </>
  )
}
