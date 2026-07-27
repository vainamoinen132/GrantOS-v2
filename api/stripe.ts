import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { cors, authenticateRequest, requireOrgAdmin, handleAuthError } from './lib/auth.js'
import { readRawBody, parseJsonBody, BodyError } from './lib/rawBody.js'

/**
 * Consolidated Stripe API — single serverless function.
 *
 * Routes by `action` query-param:
 *   POST /api/stripe?action=create-checkout  — create Checkout Session (Admin only)
 *   POST /api/stripe?action=create-portal    — create Customer Portal session (Admin only)
 *   POST /api/stripe                         — webhook handler (Stripe-signed)
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY,
 *   STRIPE_PRICE_YEARLY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * The body parser is disabled so the webhook can verify Stripe's signature
 * against the exact bytes Stripe sent. The two JSON actions use
 * parseJsonBody() instead of req.body.
 */

export const config = {
  api: { bodyParser: false },
}

/**
 * Map a Stripe price id to a plan. Unknown prices must NOT grant a paid plan —
 * otherwise any subscription on any product in the account unlocks Pro.
 */
function getPlan(priceId: string | undefined | null): 'pro' | 'free' {
  if (!priceId) return 'free'
  const monthlyId = process.env.STRIPE_PRICE_MONTHLY || ''
  const yearlyId = process.env.STRIPE_PRICE_YEARLY || ''
  if (priceId === monthlyId || priceId === yearlyId) return 'pro'
  console.warn(`[stripe] Unrecognised price id "${priceId}" — not granting a paid plan`)
  return 'free'
}

/** Stripe subscription statuses that should actually unlock paid features. */
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!stripeSecretKey || !supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing server credentials' })
  }

  const action = (req.query.action as string) || ''

  try {
    switch (action) {
      case 'create-checkout':
        return await handleCreateCheckout(req, res, stripeSecretKey, supabaseUrl, supabaseKey)
      case 'create-portal':
        return await handleCreatePortal(req, res, stripeSecretKey, supabaseUrl, supabaseKey)
      case '':
        return await handleWebhook(req, res, stripeSecretKey, supabaseUrl, supabaseKey)
      default:
        return res.status(400).json({ error: `Unknown action: "${action}"` })
    }
  } catch (err) {
    if (err instanceof BodyError) {
      return res.status(err.status).json({ error: err.message })
    }
    return handleAuthError(err, res)
  }
}

// ── Action: create-checkout ─────────────────────────────

async function handleCreateCheckout(
  req: VercelRequest, res: VercelResponse,
  stripeSecretKey: string, supabaseUrl: string, supabaseKey: string,
) {
  const monthlyPriceId = process.env.STRIPE_PRICE_MONTHLY
  const yearlyPriceId = process.env.STRIPE_PRICE_YEARLY
  if (!monthlyPriceId || !yearlyPriceId) {
    return res.status(500).json({ error: 'Stripe price IDs not configured' })
  }

  const body = await parseJsonBody(req)
  const { org_id, billing_interval, promo_code } = body || {}

  // AUTHORIZATION — the caller must be an Admin of THIS organisation.
  // Without this, anyone who knows an org id could start a subscription
  // against another company's Stripe customer.
  const auth = await authenticateRequest(req)
  requireOrgAdmin(auth, org_id)

  if (billing_interval !== 'monthly' && billing_interval !== 'yearly') {
    return res.status(400).json({ error: 'billing_interval must be "monthly" or "yearly"' })
  }
  // The billing email comes from the verified JWT, never from the request body.
  const userEmail = auth.email
  if (!userEmail) {
    return res.status(400).json({ error: 'Your account has no email address' })
  }

  const stripe = new Stripe(stripeSecretKey)
  const supabase: any = createClient(supabaseUrl, supabaseKey)

  try {
    const { data: org } = await supabase
      .from('organisations')
      .select('stripe_customer_id, name')
      .eq('id', org_id)
      .single()

    let customerId = org?.stripe_customer_id

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { org_id, org_name: org?.name || '' },
      })
      customerId = customer.id
      await supabase.from('organisations').update({ stripe_customer_id: customerId }).eq('id', org_id)
    }

    const priceId = billing_interval === 'yearly' ? yearlyPriceId : monthlyPriceId

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { org_id },
      subscription_data: { metadata: { org_id } },
      success_url: `${appOrigin(req)}/settings?tab=subscription&upgraded=true`,
      cancel_url: `${appOrigin(req)}/settings?tab=subscription`,
      allow_promotion_codes: true,
    }

    if (promo_code && typeof promo_code === 'string') {
      try {
        const promoCodes = await stripe.promotionCodes.list({ code: promo_code, active: true, limit: 1 })
        if (promoCodes.data.length > 0) {
          delete sessionParams.allow_promotion_codes
          sessionParams.discounts = [{ promotion_code: promoCodes.data[0].id }]
        }
      } catch {
        console.warn('[stripe] Promo code lookup failed')
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams)
    return res.status(200).json({ url: session.url })
  } catch (err: any) {
    console.error('[stripe] Error creating checkout session:', err)
    return res.status(500).json({ error: 'Failed to create checkout session' })
  }
}

// ── Action: create-portal ───────────────────────────────

async function handleCreatePortal(
  req: VercelRequest, res: VercelResponse,
  stripeSecretKey: string, supabaseUrl: string, supabaseKey: string,
) {
  const body = await parseJsonBody(req)
  const { org_id } = body || {}

  // AUTHORIZATION — the portal exposes invoices, the payment method and the
  // cancel button. Admin of this exact organisation only.
  const auth = await authenticateRequest(req)
  requireOrgAdmin(auth, org_id)

  const stripe = new Stripe(stripeSecretKey)
  const supabase: any = createClient(supabaseUrl, supabaseKey)

  try {
    const { data: org } = await supabase
      .from('organisations')
      .select('stripe_customer_id')
      .eq('id', org_id)
      .single()

    if (!org?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found. Please subscribe first.' })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `${appOrigin(req)}/settings?tab=subscription`,
    })

    return res.status(200).json({ url: session.url })
  } catch (err: any) {
    console.error('[stripe] Error creating portal session:', err)
    return res.status(500).json({ error: 'Failed to create portal session' })
  }
}

/** Only ever redirect back to an origin we control. */
function appOrigin(req: VercelRequest): string {
  const allowed = [
    'https://app.grantlume.com',
    'https://www.grantlume.com',
    'http://localhost:5173',
    'http://localhost:3000',
  ]
  const origin = (req.headers.origin as string) || ''
  return allowed.includes(origin) ? origin : 'https://app.grantlume.com'
}

// ── Default: Webhook handler ────────────────────────────

async function handleWebhook(
  req: VercelRequest, res: VercelResponse,
  stripeSecretKey: string, supabaseUrl: string, supabaseKey: string,
) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  const stripe = new Stripe(stripeSecretKey)

  // Signature verification is mandatory. Without a secret, unsigned events
  // could be forged by anyone — treat missing env var as a hard 500.
  if (!webhookSecret) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET not set — refusing unsigned events')
    return res.status(500).json({ error: 'Webhook secret not configured' })
  }

  let event: Stripe.Event
  try {
    const sig = req.headers['stripe-signature'] as string
    if (!sig) {
      return res.status(400).json({ error: 'Missing stripe-signature header' })
    }
    // The EXACT bytes Stripe signed — see api/lib/rawBody.ts for why this
    // cannot be JSON.stringify(req.body).
    const rawBody = await readRawBody(req)
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
  } catch (err: any) {
    console.error('[stripe] Webhook signature verification failed:', err.message)
    return res.status(400).json({ error: 'Invalid signature' })
  }

  const supabase: any = createClient(supabaseUrl, supabaseKey)
  console.log(`[stripe] Received event: ${event.type} (${event.id})`)

  // Idempotency — Stripe retries, and retries must not re-run side effects
  // such as sending a second "welcome to Pro" notification.
  const alreadyHandled = await markEventHandled(supabase, event.id, event.type)
  if (alreadyHandled) {
    return res.status(200).json({ received: true, duplicate: true })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        return await handleCheckoutCompleted(stripe, supabase, event.data.object as Stripe.Checkout.Session, res)
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return await handleSubscriptionUpdated(supabase, event.data.object as Stripe.Subscription, res)
      case 'customer.subscription.deleted':
        return await handleSubscriptionDeleted(supabase, event.data.object as Stripe.Subscription, res)
      case 'invoice.payment_failed':
        return await handlePaymentFailed(supabase, event.data.object as Stripe.Invoice, res)
      default:
        return res.status(200).json({ received: true, event: event.type })
    }
  } catch (err: any) {
    console.error(`[stripe] Error handling ${event.type}:`, err)
    return res.status(500).json({ error: 'Internal error processing webhook' })
  }
}

/**
 * Record the event id. Returns true if this event was already processed.
 * Degrades to "not a duplicate" if the table is missing, so a missing
 * migration never blocks billing.
 */
async function markEventHandled(supabase: any, eventId: string, eventType: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('stripe_webhook_events')
      .insert({ event_id: eventId, event_type: eventType })
    if (!error) return false
    // 23505 = unique_violation → we have seen this event before.
    if (error.code === '23505') return true
    return false
  } catch {
    return false
  }
}

// ── Event handlers ──────────────────────────────────────

async function handleCheckoutCompleted(
  stripe: Stripe,
  supabase: any,
  session: Stripe.Checkout.Session,
  res: VercelResponse,
) {
  const orgId = session.metadata?.org_id
  if (!orgId) {
    console.warn('[stripe] checkout.session.completed — no org_id in metadata')
    return res.status(200).json({ received: true, warning: 'no org_id' })
  }

  const customerId = session.customer as string
  const subscriptionId = session.subscription as string

  let plan: 'pro' | 'free' = 'free'
  let status = 'active'
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId)
      plan = getPlan(sub.items.data[0]?.price?.id)
      status = mapStatus(sub.status)
    } catch {
      /* fall through with defaults */
    }
  }

  await updateOrg(supabase, orgId, plan, subscriptionId, customerId, status)

  if (plan === 'pro') {
    await notifyAdmins(supabase, orgId, 'subscription_upgraded',
      'Welcome to GrantLume Pro!',
      'Your subscription is now active. Enjoy unlimited projects, staff, and enhanced AI limits.',
      '/settings?tab=subscription',
    )
  }

  return res.status(200).json({ ok: true, org_id: orgId, plan })
}

const STATUS_MAP: Record<string, string> = {
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',
  incomplete: 'incomplete',
  incomplete_expired: 'expired',
  trialing: 'trialing',
  paused: 'paused',
}

function mapStatus(stripeStatus: string): string {
  return STATUS_MAP[stripeStatus] || stripeStatus
}

async function handleSubscriptionUpdated(
  supabase: any,
  subscription: Stripe.Subscription,
  res: VercelResponse,
) {
  const orgId = subscription.metadata?.org_id
  const customerId = subscription.customer as string

  const resolvedOrgId = orgId || (await findOrgByStripeCustomer(supabase, customerId))?.id
  if (!resolvedOrgId) {
    return res.status(200).json({ received: true, warning: 'no org found' })
  }

  const status = mapStatus(subscription.status)

  // Entitlement follows the STATUS, not just the price. A cancelled or expired
  // subscription must not leave the organisation on the paid plan.
  const plan: 'pro' | 'free' = ENTITLED_STATUSES.has(subscription.status)
    ? getPlan(subscription.items.data[0]?.price?.id)
    : 'free'

  await updateOrg(supabase, resolvedOrgId, plan, subscription.id, customerId, status)

  return res.status(200).json({ ok: true, org_id: resolvedOrgId, status, plan })
}

async function handleSubscriptionDeleted(
  supabase: any,
  subscription: Stripe.Subscription,
  res: VercelResponse,
) {
  const customerId = subscription.customer as string
  const orgId = subscription.metadata?.org_id || (await findOrgByStripeCustomer(supabase, customerId))?.id
  if (!orgId) return res.status(200).json({ received: true })

  await supabase.from('organisations').update({
    plan: 'free',
    subscription_status: 'cancelled',
    updated_at: new Date().toISOString(),
  }).eq('id', orgId)

  await notifyAdmins(supabase, orgId, 'subscription_cancelled',
    'Subscription Cancelled',
    'Your GrantLume Pro subscription has ended. You are now on the Free plan with limited features. Upgrade anytime to restore full access.',
    '/settings?tab=subscription',
  )

  return res.status(200).json({ ok: true })
}

async function handlePaymentFailed(
  supabase: any,
  invoice: Stripe.Invoice,
  res: VercelResponse,
) {
  const customerId = invoice.customer as string
  const org = await findOrgByStripeCustomer(supabase, customerId)
  if (!org) return res.status(200).json({ received: true })

  await supabase.from('organisations').update({
    subscription_status: 'past_due',
    updated_at: new Date().toISOString(),
  }).eq('id', org.id)

  await notifyAdmins(supabase, org.id, 'payment_failed',
    'Payment Failed',
    'Your last payment could not be processed. Please update your payment method to avoid service interruption.',
    '/settings?tab=subscription',
  )

  return res.status(200).json({ ok: true })
}

// ── Helpers ─────────────────────────────────────────────

async function findOrgByStripeCustomer(supabase: any, customerId: string) {
  const { data } = await supabase
    .from('organisations')
    .select('id, plan')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  return data
}

async function updateOrg(
  supabase: any,
  orgId: string,
  plan: string,
  subscriptionId?: string,
  customerId?: string,
  status?: string,
) {
  const update: any = {
    plan,
    subscription_status: status || 'active',
    updated_at: new Date().toISOString(),
  }
  if (subscriptionId) update.stripe_subscription_id = subscriptionId
  if (customerId) update.stripe_customer_id = customerId

  // Clear trial_ends_at when moving to a paid plan
  if (plan === 'pro') {
    update.trial_ends_at = null
  }

  await supabase.from('organisations').update(update).eq('id', orgId)
}

async function notifyAdmins(
  supabase: any,
  orgId: string,
  type: string,
  title: string,
  message: string,
  link: string,
) {
  try {
    const { data: admins } = await supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('role', 'Admin')

    if (!admins?.length) return

    // NOTE: the column is `message`, not `body`. Writing `body` silently
    // failed for every billing notification before this fix.
    const notifications = admins.map((a: any) => ({
      user_id: a.user_id,
      org_id: orgId,
      type,
      title,
      message,
      link,
    }))

    const { error } = await supabase.from('notifications').insert(notifications)
    if (error) console.error('[stripe] Failed to create notifications:', error)
  } catch (err) {
    console.error('[stripe] Failed to create notifications:', err)
  }
}
