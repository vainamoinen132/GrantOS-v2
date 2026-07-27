import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/authStore'
import { apiFetch } from '@/lib/apiClient'
import { settingsService } from '@/services/settingsService'
import { aiUsageService } from '@/services/aiUsageService'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import {
  Check,
  Crown,
  Sparkles,
  AlertTriangle,
  ExternalLink,
  CreditCard,
  ArrowRight,
  Shield,
  Users,
  FolderKanban,
  Bot,
  FileText,
  Globe,
  Lock,
  Loader2,
  Tag,
  Infinity,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInCalendarDays } from 'date-fns'
import type { OrgPlan, AiUsage } from '@/types'
import { AI_PLAN_LIMITS } from '@/types'

// ── Pricing ──────────────────────────────────────────────

type BillingInterval = 'monthly' | 'yearly'

const PRO_FEATURES = [
  'Unlimited projects',
  'Unlimited staff members',
  'Unlimited user seats',
  '100 AI requests per month',
  'Full report builder & export',
  'Collaboration module',
  'Custom role permissions',
  'Priority email support',
]

// ── Component ────────────────────────────────────────────

export function SubscriptionSettings() {
  const { t } = useTranslation()
  const { orgId, user, trialEndsAt } = useAuthStore()
  const [loading, setLoading] = useState(true)
  const [currentPlan, setCurrentPlan] = useState<OrgPlan>('trial')
  const [trialEnd, setTrialEnd] = useState<string | null>(null)
  const [stripeSubscriptionId, setStripeSubscriptionId] = useState<string | null>(null)
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null)
  const [aiUsage, setAiUsage] = useState<AiUsage | null>(null)
  const [upgrading, setUpgrading] = useState(false)
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly')
  const [promoCode, setPromoCode] = useState('')
  const [managingBilling, setManagingBilling] = useState(false)

  const fetchData = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const [org, usage] = await Promise.all([
        settingsService.getOrganisation(orgId),
        aiUsageService.getCurrentUsage(orgId),
      ])
      if (org) {
        // Map legacy plan values to new type
        const rawPlan = org.plan as OrgPlan
        let plan: OrgPlan = rawPlan === 'pro' ? 'pro' : rawPlan === 'free' ? 'free' : 'trial'
        // If trial has expired, treat as free
        if (plan === 'trial' && org.trial_ends_at && new Date(org.trial_ends_at) < new Date()) {
          plan = 'free'
        }
        setCurrentPlan(plan)
        setTrialEnd(org.trial_ends_at)
        setStripeSubscriptionId((org as any).stripe_subscription_id ?? null)
        setSubscriptionStatus((org as any).subscription_status ?? null)
      }
      setAiUsage(usage)
    } catch {
      // Ignore
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => { fetchData() }, [fetchData])

  // Check for ?upgraded=true in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('upgraded') === 'true') {
      toast({
        title: 'Welcome to GrantLume Pro!',
        description: 'Your subscription is now active. Enjoy unlimited access to all features.',
      })
      // Clean up URL
      const url = new URL(window.location.href)
      url.searchParams.delete('upgraded')
      window.history.replaceState({}, '', url.toString())
      // Refresh data
      fetchData()
    }
  }, [fetchData])

  // Trial days remaining — calendar-day semantics so the counter decrements
  // at midnight, not at the exact clock time the trial was created.
  const trialDaysLeft = currentPlan === 'trial' && (trialEnd || trialEndsAt)
    ? Math.max(0, differenceInCalendarDays(new Date(trialEnd || trialEndsAt!), new Date()))
    : null

  const trialExpired = trialDaysLeft !== null && trialDaysLeft <= 0

  // AI usage stats
  const limits = AI_PLAN_LIMITS[currentPlan] || AI_PLAN_LIMITS.trial
  const requestsUsed = aiUsage?.request_count ?? 0
  const requestPct = limits.monthly_requests > 0 ? Math.min(100, (requestsUsed / limits.monthly_requests) * 100) : 0
  const remainingPct = Math.max(0, Math.round(100 - requestPct))
  const resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)

  const isPro = currentPlan === 'pro' && subscriptionStatus === 'active'

  // Handle upgrade → Stripe Checkout
  const handleUpgrade = async () => {
    if (!orgId || !user?.email) return
    setUpgrading(true)
    try {
      // apiFetch attaches the Supabase JWT — the endpoint verifies the caller
      // is an Admin of this organisation before touching Stripe.
      const resp = await apiFetch('/api/stripe?action=create-checkout', {
        method: 'POST',
        body: JSON.stringify({
          org_id: orgId,
          billing_interval: billingInterval,
          promo_code: promoCode.trim() || undefined,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Checkout failed')
      if (data.url) {
        window.location.href = data.url
      }
    } catch (err) {
      console.error('Checkout error:', err)
      toast({
        title: t('common.error'),
        description: err instanceof Error ? err.message : 'Failed to start checkout. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setUpgrading(false)
    }
  }

  // Handle manage subscription → Stripe Customer Portal
  const handleManageSubscription = async () => {
    if (!orgId) return
    setManagingBilling(true)
    try {
      const resp = await apiFetch('/api/stripe?action=create-portal', {
        method: 'POST',
        body: JSON.stringify({ org_id: orgId }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Portal failed')
      if (data.url) {
        window.location.href = data.url
      }
    } catch (err) {
      toast({
        title: t('common.error'),
        description: err instanceof Error ? err.message : 'Failed to open billing portal.',
        variant: 'destructive',
      })
    } finally {
      setManagingBilling(false)
    }
  }

  if (loading) return <Skeleton className="h-96 w-full" />

  return (
    <div className="space-y-6">
      {/* ── Current Plan Summary ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <CreditCard className="h-4.5 w-4.5" />
                {t('subscription.currentPlan')}
              </CardTitle>
              <CardDescription className="mt-1">
                {t('subscription.currentPlanDesc')}
              </CardDescription>
            </div>
            {isPro && stripeSubscriptionId && (
              <Button variant="outline" size="sm" onClick={handleManageSubscription} disabled={managingBilling}>
                {managingBilling ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ExternalLink className="mr-1 h-3.5 w-3.5" />}
                {t('subscription.manageSubscription')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-6">
            {/* Plan badge */}
            <div className="flex items-center gap-4">
              <div className={cn(
                'flex h-14 w-14 items-center justify-center rounded-xl',
                isPro ? 'bg-primary/10' : 'bg-muted',
              )}>
                {isPro
                  ? <Crown className="h-7 w-7 text-primary" />
                  : <Sparkles className="h-7 w-7 text-muted-foreground" />
                }
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold">
                    {isPro ? 'GrantLume Pro' : currentPlan === 'free' ? 'Free Plan' : 'Free Trial'}
                  </h3>
                  <Badge variant={isPro ? 'default' : 'secondary'} className="text-xs">
                    {subscriptionStatus === 'active' ? t('subscription.active') :
                     subscriptionStatus === 'past_due' ? t('subscription.pastDue') :
                     subscriptionStatus === 'cancelled' ? 'Cancelled' :
                     t('subscription.trial')}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {isPro ? (
                    <span className="font-semibold">Active subscription</span>
                  ) : currentPlan === 'free' ? (
                    <span className="text-amber-600 dark:text-amber-400 font-medium">Trial expired — upgrade to unlock all features</span>
                  ) : currentPlan === 'trial' && trialDaysLeft !== null ? (
                    <span>{t('subscription.trialDaysLeft', { count: trialDaysLeft })}</span>
                  ) : null}
                </p>
              </div>
            </div>

            {/* Trial warning */}
            {(currentPlan === 'free' || (currentPlan === 'trial' && trialDaysLeft !== null && trialDaysLeft <= 7)) && (
              <div className={cn(
                'flex items-center gap-3 rounded-lg px-4 py-3 flex-1',
                trialExpired
                  ? 'bg-destructive/10 border border-destructive/20'
                  : 'bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-800',
              )}>
                <AlertTriangle className={cn(
                  'h-5 w-5 shrink-0',
                  trialExpired ? 'text-destructive' : 'text-amber-600',
                )} />
                <div className="text-sm">
                  <p className={cn('font-medium', trialExpired ? 'text-destructive' : 'text-amber-800 dark:text-amber-200')}>
                    {trialExpired ? t('subscription.trialExpiredTitle') : t('subscription.trialExpiringTitle')}
                  </p>
                  <p className={cn('mt-0.5', trialExpired ? 'text-destructive/80' : 'text-amber-700 dark:text-amber-300')}>
                    {trialExpired
                      ? t('subscription.trialExpiredDesc')
                      : t('subscription.trialExpiringDesc', { count: trialDaysLeft ?? 0 })}
                  </p>
                </div>
              </div>
            )}

            {/* Past-due warning */}
            {subscriptionStatus === 'past_due' && (
              <div className="flex items-center gap-3 rounded-lg px-4 py-3 flex-1 bg-destructive/10 border border-destructive/20">
                <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                <div className="text-sm">
                  <p className="font-medium text-destructive">Payment Failed</p>
                  <p className="mt-0.5 text-destructive/80">
                    Your last payment could not be processed. Please update your payment method to avoid service interruption.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* AI Usage summary */}
          <div className="mt-6 pt-6 border-t">
            <h4 className="text-sm font-medium mb-3 flex items-center gap-1.5">
              <Bot className="h-4 w-4 text-muted-foreground" />
              {t('subscription.aiUsageThisMonth')}
            </h4>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Usage</span>
                <span className={cn('font-medium', requestPct >= 100 ? 'text-red-600' : '')}>
                  {Math.round(requestPct)}% used
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    requestPct >= 100 ? 'bg-destructive' : requestPct >= 80 ? 'bg-amber-500' : 'bg-primary',
                  )}
                  style={{ width: `${requestPct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{remainingPct}% remaining</span>
                <span>Resets {resetDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Upgrade to Pro (shown only on trial) ── */}
      {/* Hidden unless Stripe billing is enabled. Without the env vars set,
          clicking "Subscribe Now" would return a 500 and show a broken
          toast — flip VITE_STRIPE_ENABLED=true once Stripe is configured. */}
      {!isPro && import.meta.env.VITE_STRIPE_ENABLED === 'true' && (
        <Card className="ring-1 ring-primary/30 shadow-lg">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="rounded-lg p-2 bg-primary/10">
                <Crown className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Upgrade to GrantLume Pro</CardTitle>
                <CardDescription>Unlock everything. No limits on projects, staff, or users.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Billing interval toggle */}
            <div className="flex items-center justify-center gap-2">
              <div className="flex bg-muted rounded-lg p-0.5">
                <button
                  onClick={() => setBillingInterval('monthly')}
                  className={cn(
                    'px-4 py-2 rounded-md text-sm font-medium transition-all',
                    billingInterval === 'monthly'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Monthly
                </button>
                <button
                  onClick={() => setBillingInterval('yearly')}
                  className={cn(
                    'px-4 py-2 rounded-md text-sm font-medium transition-all',
                    billingInterval === 'yearly'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Annual
                  <Badge variant="secondary" className="ml-1.5 text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                    Save 298€
                  </Badge>
                </button>
              </div>
            </div>

            {/* Price display */}
            <div className="text-center">
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-4xl font-bold tracking-tight">
                  {billingInterval === 'monthly' ? '149' : '1,490'}€
                </span>
                <span className="text-lg text-muted-foreground">
                  {billingInterval === 'monthly' ? '/month' : '/year'}
                </span>
              </div>
              {billingInterval === 'yearly' && (
                <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1 font-medium">
                  That's ~124€/month — 2 months free!
                </p>
              )}
            </div>

            {/* Features grid */}
            <div className="grid sm:grid-cols-2 gap-2">
              {PRO_FEATURES.map((f, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <Check className="h-4 w-4 mt-0.5 shrink-0 text-emerald-500" />
                  <span className="text-muted-foreground">{f}</span>
                </div>
              ))}
            </div>

            {/* Promo code input */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3 pt-2 border-t">
              <div className="flex-1">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-1.5">
                  <Tag className="h-3 w-3" />
                  Promo Code (optional)
                </label>
                <input
                  type="text"
                  value={promoCode}
                  onChange={e => setPromoCode(e.target.value.toUpperCase())}
                  placeholder="Enter code"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 uppercase tracking-wider"
                />
              </div>
              <Button
                size="lg"
                className="sm:w-auto w-full h-10"
                onClick={handleUpgrade}
                disabled={upgrading}
              >
                {upgrading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Redirecting to checkout...
                  </>
                ) : (
                  <>
                    Subscribe Now <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </div>

            <p className="text-[10px] text-muted-foreground text-center">
              Secure payment via Stripe. Cancel anytime from the billing portal.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Feature Comparison (Free vs Pro) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('subscription.featureComparison')}</CardTitle>
          <CardDescription>Free Trial gives full Pro access for 30 days. After that, the Free plan limits apply.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('subscription.feature')}</th>
                  <th className={cn('px-4 py-2.5 text-center font-medium', (currentPlan === 'free' || currentPlan === 'trial') && 'bg-primary/5')}>
                    Free
                  </th>
                  <th className={cn('px-4 py-2.5 text-center font-medium', currentPlan === 'pro' && 'bg-primary/5')}>
                    Pro
                  </th>
                </tr>
              </thead>
              <tbody>
                {([
                  { icon: FolderKanban, label: t('subscription.limitProjects'), free: '5', pro: 'Unlimited' },
                  { icon: Users, label: t('subscription.limitStaff'), free: '10', pro: 'Unlimited' },
                  { icon: Users, label: t('subscription.limitUsers'), free: '1', pro: 'Unlimited' },
                  { icon: Bot, label: t('subscription.limitAi'), free: '\u2014', pro: '100 requests' },
                  { icon: FileText, label: t('subscription.limitReports'), free: 'View only', pro: 'Full export' },
                  { icon: Globe, label: t('subscription.limitCollab'), free: '\u2014', pro: '\u2713' },
                  { icon: Lock, label: t('subscription.limitRoles'), free: 'Default', pro: 'Custom' },
                  { icon: Shield, label: t('subscription.limitSupport'), free: 'Email', pro: 'Priority Email' },
                ] as const).map((row, i) => {
                  const RowIcon = row.icon
                  return (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-4 py-2.5 flex items-center gap-2">
                        <RowIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{row.label}</span>
                      </td>
                      <td className={cn('px-4 py-2.5 text-center text-xs', (currentPlan === 'free' || currentPlan === 'trial') && 'bg-primary/5 font-medium')}>
                        {row.free}
                      </td>
                      <td className={cn('px-4 py-2.5 text-center text-xs', currentPlan === 'pro' && 'bg-primary/5 font-medium')}>
                        {row.pro === '\u2713' ? <Check className="h-4 w-4 text-emerald-500 mx-auto" />
                          : row.pro === 'Unlimited' ? <span className="inline-flex items-center gap-0.5"><Infinity className="h-3.5 w-3.5" /> Unlimited</span>
                          : row.pro}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── FAQ / Info ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('subscription.billingFaq')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <div>
            <p className="font-medium text-foreground">How does the annual plan work?</p>
            <p>You pay 1,490€ upfront for the full year — that's 2 months free compared to monthly billing (149€ × 12 = 1,788€).</p>
          </div>
          <div>
            <p className="font-medium text-foreground">Can I use a promo code?</p>
            <p>Yes! Enter your promo code before checkout. Founding customer discounts and special promotions are applied automatically via Stripe.</p>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('subscription.faqCancel')}</p>
            <p>{t('subscription.faqCancelAnswer')}</p>
          </div>
          <div>
            <p className="font-medium text-foreground">{t('subscription.faqData')}</p>
            <p>{t('subscription.faqDataAnswer')}</p>
          </div>
          <div>
            <p className="font-medium text-foreground">How do I update my payment method?</p>
            <p>Click "Manage Subscription" above to open the Stripe billing portal where you can update your card, download invoices, and manage your subscription.</p>
          </div>
          <div className="pt-2 border-t">
            <p className="text-xs">
              {t('subscription.paymentNote')}{' '}
              <a href="mailto:hello@grantlume.com" className="text-primary hover:underline font-medium">
                hello@grantlume.com
              </a>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
