import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase'
import { apiFetch } from '@/lib/apiClient'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { CheckCircle2, XCircle, Loader2, ArrowRight, Sparkles, Building2, Globe } from 'lucide-react'
import { GrantLumeWordmark } from '@/components/common/GrantLumeLogo'

/**
 * Handles Supabase auth redirects:
 * - Email confirmation (PKCE: ?code=..., or token_hash: ?token_hash=...&type=signup)
 * - Implicit flow (#access_token=...)
 * - Magic link login
 * - Password reset redirect (?type=recovery)
 */
interface InviteContext {
  type: 'org' | 'collab'
  orgId?: string
  token?: string
  role?: string
}

export function AuthCallbackPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<'loading' | 'confirmed' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [inviteAccepted, setInviteAccepted] = useState(false)
  const [inviteContext, setInviteContext] = useState<InviteContext | null>(null)
  const handled = useRef(false)
  const { t } = useTranslation()

  useEffect(() => {
    if (handled.current) return
    handled.current = true

    const handleCallback = async () => {
      try {
        const params = new URLSearchParams(window.location.search)
        const hashParams = new URLSearchParams(window.location.hash.replace('#', ''))

        const code = params.get('code')
        const tokenHash = params.get('token_hash')
        const type = params.get('type')
        const accessToken = hashParams.get('access_token')

        // 1. PKCE flow — ?code=...
        if (code) {
          console.log('[AuthCallback] Exchanging PKCE code...')
          const { data, error } = await supabase.auth.exchangeCodeForSession(code)
          if (error) {
            console.error('[AuthCallback] Code exchange error:', error.message)
            setStatus('error')
            setMessage(error.message)
            return
          }
          if (data.session) {
            await onSuccess(type)
            return
          }
        }

        // 2. Token hash flow — ?token_hash=...&type=signup|email|recovery|magiclink
        if (tokenHash && type) {
          console.log('[AuthCallback] Verifying OTP with token_hash, type:', type)

          // Recovery → verify then redirect to reset-password page
          if (type === 'recovery') {
            const { error } = await supabase.auth.verifyOtp({
              token_hash: tokenHash,
              type: 'recovery',
            })
            if (error) {
              console.error('[AuthCallback] Recovery verifyOtp error:', error.message)
              setStatus('error')
              setMessage(error.message)
              return
            }
            navigate('/reset-password', { replace: true })
            return
          }

          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: type as 'signup' | 'email' | 'magiclink',
          })
          if (error) {
            console.error('[AuthCallback] verifyOtp error:', error.message)
            setStatus('error')
            setMessage(error.message)
            return
          }
          console.log('[AuthCallback] verifyOtp success')
          await onSuccess(type)
          return
        }

        // 3. Implicit flow — #access_token=... (Supabase JS client auto-processes this)
        if (accessToken) {
          console.log('[AuthCallback] Hash fragment detected, waiting for Supabase to process...')
        }

        // 4. Check if session already exists (hash may have been auto-processed)
        const { data: { session }, error } = await supabase.auth.getSession()
        if (error) {
          console.error('[AuthCallback] getSession error:', error.message)
          setStatus('error')
          setMessage(error.message)
          return
        }
        if (session) {
          await onSuccess(type)
          return
        }

        // 5. Wait for auth state change (hash fragment may still be processing)
        console.log('[AuthCallback] No session yet, listening for auth state change...')
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
          console.log('[AuthCallback] Auth state changed:', event, !!newSession)
          if (newSession) {
            onSuccess(type) // fire-and-forget in listener context
            subscription.unsubscribe()
          }
        })

        // Timeout after 10 seconds
        setTimeout(() => {
          setStatus((prev) => {
            if (prev === 'loading') {
              console.error('[AuthCallback] Timed out waiting for session')
              setMessage(t('auth.verifyExpired'))
              subscription.unsubscribe()
              return 'error'
            }
            return prev
          })
        }, 10_000)
      } catch (err) {
        console.error('[AuthCallback] Unexpected error:', err)
        setStatus('error')
        setMessage(t('auth.somethingWentWrong'))
      }
    }

    const processInviteContext = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        const ctx = user?.user_metadata?.invite_context as InviteContext | undefined
        if (!ctx) {
          console.log('[AuthCallback] No invite_context in user metadata')
          return
        }

        setInviteContext(ctx)

        if (ctx.type === 'collab' && ctx.token) {
          // Accept collab invitation. The endpoint now requires a JWT —
          // apiFetch attaches the session bearer token automatically.
          // The server binds the partner to `auth.userId` from the JWT;
          // the old `userId` body field is ignored.
          const res = await apiFetch('/api/members?action=collab-accept', {
            method: 'POST',
            body: JSON.stringify({ token: ctx.token }),
          })
          const body = await res.json().catch(() => ({}))
          if (res.ok) {
            setInviteAccepted(true)
          } else {
            console.error('[AuthCallback] collab-accept failed:', res.status, body)
          }
        } else if (ctx.type === 'org' && ctx.orgId) {
          // The org member row was already created by invite-member API when the admin invited.
          // Just mark invite as accepted.
          setInviteAccepted(true)
          console.log('[AuthCallback] Org invite — member row already exists')
        }

        // Clear invite_context from user metadata to prevent re-processing
        await supabase.auth.updateUser({
          data: { invite_context: null },
        })

        // Reload auth context so the store picks up the correct role/permissions
        // now that collab-accept has linked user_id and set invite_status='accepted'
        console.log('[AuthCallback] Reloading user context after invite acceptance')
        await useAuthStore.getState().reloadContext()
      } catch (err) {
        console.error('[AuthCallback] Failed to process invite:', err)
      }
    }

    const onSuccess = async (type: string | null) => {
      // For signup confirmations, process invite then show interstitial
      if (type === 'signup') {
        await processInviteContext()
        setStatus('confirmed')
        setMessage(t('auth.emailConfirmedSuccess'))
      } else {
        // For other flows (magic link, email change, etc.) redirect immediately
        setStatus('success')
        setMessage(t('auth.verifiedRedirecting'))
        const { accessType } = useAuthStore.getState()
        const dest = accessType === 'collab_partner' ? '/projects/collaboration' : '/dashboard'
        setTimeout(() => navigate(dest, { replace: true }), 1500)
      }
    }

    handleCallback()
  }, [navigate])

  const handleContinue = () => {
    // If collab invite was accepted, go to the collaboration page
    if (inviteContext?.type === 'collab') {
      navigate('/projects/collaboration', { replace: true })
    } else {
      navigate('/dashboard', { replace: true })
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 p-6">
      <div className="absolute inset-0 opacity-10 pointer-events-none">
        <div className="absolute top-20 left-10 w-72 h-72 bg-white rounded-full blur-3xl" />
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-blue-300 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md bg-background rounded-2xl shadow-2xl p-8 text-center space-y-6 animate-fade-in">
        <div className="flex items-center justify-center mb-2">
          <GrantLumeWordmark size={32} variant="color" />
        </div>

        {/* Loading state */}
        {status === 'loading' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Loader2 className="h-8 w-8 text-primary animate-spin" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight">{t('callback.verifying')}</h2>
            <p className="text-sm text-muted-foreground">{t('callback.pleaseWait')}</p>
          </>
        )}

        {/* Signup confirmation — interstitial "Email Confirmed" page */}
        {status === 'confirmed' && (
          <>
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100 ring-4 ring-green-50">
              <CheckCircle2 className="h-10 w-10 text-green-600" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-bold tracking-tight text-green-700">{t('callback.emailConfirmed')}</h2>
              <p className="text-muted-foreground">
                {t('callback.accountVerified')}
              </p>
            </div>

            {/* Show invite acceptance confirmation */}
            {inviteAccepted && inviteContext && (
              <div className="rounded-xl bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 p-5 text-left space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-green-900">
                  {inviteContext.type === 'collab' ? <Globe className="h-4 w-4 text-green-600" /> : <Building2 className="h-4 w-4 text-green-600" />}
                  {inviteContext.type === 'collab' ? t('invite.collabInviteAccepted') : t('invite.orgInviteAccepted')}
                </div>
                <p className="text-sm text-green-800">
                  {inviteContext.type === 'collab'
                    ? t('invite.collabInviteAcceptedDesc')
                    : t('invite.orgInviteAcceptedDesc')}
                </p>
              </div>
            )}

            {/* Show onboarding steps only for non-invite signups */}
            {!inviteAccepted && (
              <div className="rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 p-5 text-left space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-blue-900">
                  <Sparkles className="h-4 w-4 text-blue-600" />
                  {t('callback.whatsNext')}
                </div>
                <ol className="text-sm text-blue-800 space-y-2 pl-1">
                  <li className="flex items-start gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white mt-0.5">1</span>
                    <span>{t('callback.step1')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white mt-0.5">2</span>
                    <span>{t('callback.step2')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white mt-0.5">3</span>
                    <span>{t('callback.step3')}</span>
                  </li>
                </ol>
              </div>
            )}

            <Button
              className="w-full h-12 font-semibold text-base gap-2"
              onClick={handleContinue}
            >
              {inviteAccepted
                ? (inviteContext?.type === 'collab' ? t('invite.goToCollaboration') : t('invite.goToDashboard'))
                : t('callback.continueToSetup')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </>
        )}

        {/* Generic success — redirect in progress */}
        {status === 'success' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight">{t('callback.youreAllSet')}</h2>
            <p className="text-sm text-muted-foreground">{message}</p>
          </>
        )}

        {/* Error state */}
        {status === 'error' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <XCircle className="h-8 w-8 text-destructive" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight">{t('callback.verificationFailed')}</h2>
            <p className="text-sm text-muted-foreground">{message}</p>
            <Button className="w-full h-11 font-semibold" onClick={() => navigate('/login')}>
              {t('auth.goToLogin')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
