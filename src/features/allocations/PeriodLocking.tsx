import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { allocationsService } from '@/services/allocationsService'
import { useAuthStore } from '@/stores/authStore'
import { useUiStore } from '@/stores/uiStore'
import { usePeriodLocks } from '@/hooks/useAllocations'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import { emailService } from '@/services/emailService'
import { memberDirectory } from '@/services/memberDirectoryService'
import { supabase } from '@/lib/supabase'
import { logger } from '@/lib/logger'
import { Lock, Unlock } from 'lucide-react'
import { cn } from '@/lib/utils'

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function PeriodLocking() {
  const { t } = useTranslation()
  const { orgId, orgName, user } = useAuthStore()
  const { globalYear } = useUiStore()
  const { isLoading, isLocked, refetch } = usePeriodLocks()
  const [toggling, setToggling] = useState<number | null>(null)

  const handleToggle = async (month: number) => {
    if (!orgId || !user) return
    setToggling(month)
    try {
      const result = await allocationsService.togglePeriodLock(orgId, globalYear, month, user.id)
      toast({
        title: result.locked ? t('allocations.periodLocked') : t('allocations.periodUnlocked'),
        description: t('allocations.periodToggleDesc', { month: MONTH_LABELS[month - 1], year: globalYear, action: result.locked ? t('allocations.locked') : t('allocations.unlocked') }),
      })

      // Send period locked notification (fire-and-forget).
      //
      // This used to call supabase.auth.admin.getUserById() straight from the
      // browser. Admin APIs require the service-role key, which the browser
      // does not have, so every call 403'd and NO period-locked email was ever
      // sent. Resolve the addresses through the server instead.
      if (result.locked) {
        const period = `${MONTH_LABELS[month - 1]} ${globalYear}`
        void (async () => {
          try {
            const { data: members } = await supabase
              .from('org_members')
              .select('user_id')
              .eq('org_id', orgId)
              .neq('user_id', user.id)

            const userIds = (members ?? []).map((m: { user_id: string }) => m.user_id)
            if (userIds.length === 0) return

            const emails = await memberDirectory.resolveEmails(orgId, userIds)
            for (const email of Object.values(emails)) {
              await emailService.sendPeriodLocked({
                to: email,
                recipientName: email.split('@')[0],
                orgName: orgName ?? 'the organisation',
                period,
                lockedBy: user.email ?? 'An administrator',
              })
            }
          } catch (err) {
            logger.warn('Failed to send period-locked notifications', { source: 'PeriodLocking' }, err)
          }
        })()
      }

      refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('allocations.failedToToggle')
      toast({ title: t('common.error'), description: message, variant: 'destructive' })
    } finally {
      setToggling(null)
    }
  }

  if (isLoading) return <Skeleton className="h-32 w-full" />

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('allocations.periodLocks')} — {globalYear}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-2">
          {MONTH_LABELS.map((label, i) => {
            const month = i + 1
            const locked = isLocked(month)
            return (
              <Button
                key={month}
                variant={locked ? 'default' : 'outline'}
                size="sm"
                className={cn(
                  'flex flex-col gap-0.5 h-auto py-2',
                  locked && 'bg-amber-500 hover:bg-amber-600 text-white',
                )}
                onClick={() => handleToggle(month)}
                disabled={toggling === month}
              >
                {locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                <span className="text-xs">{label}</span>
              </Button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
