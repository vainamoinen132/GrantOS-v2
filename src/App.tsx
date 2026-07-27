import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { AppShell } from '@/components/layout/AppShell'
import { Toaster } from '@/components/ui/toaster'
import { ProtectedRoute } from '@/features/auth/ProtectedRoute'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { Skeleton } from '@/components/ui/skeleton'

// Route pages are code-split with React.lazy so the initial bundle (e.g. the
// login screen) no longer ships dashboard, reports, financials, charts and
// spreadsheet code. Each page is a named export, hence the `.then` mapping.
const LoginPage = lazy(() => import('@/features/auth/LoginPage').then(m => ({ default: m.LoginPage })))
const SignUpPage = lazy(() => import('@/features/auth/SignUpPage').then(m => ({ default: m.SignUpPage })))
const ForgotPasswordPage = lazy(() => import('@/features/auth/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })))
const ResetPasswordPage = lazy(() => import('@/features/auth/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })))
const AuthCallbackPage = lazy(() => import('@/features/auth/AuthCallbackPage').then(m => ({ default: m.AuthCallbackPage })))
const OnboardingWizard = lazy(() => import('@/features/auth/OnboardingWizard').then(m => ({ default: m.OnboardingWizard })))
const DashboardPage = lazy(() => import('@/features/dashboard/DashboardPage').then(m => ({ default: m.DashboardPage })))
const ProjectsPage = lazy(() => import('@/features/projects/ProjectsPage').then(m => ({ default: m.ProjectsPage })))
const StaffPage = lazy(() => import('@/features/staff/StaffPage').then(m => ({ default: m.StaffPage })))
const AllocationsPage = lazy(() => import('@/features/allocations/AllocationsPage').then(m => ({ default: m.AllocationsPage })))
const TimesheetsPage = lazy(() => import('@/features/timesheets/TimesheetsPage').then(m => ({ default: m.TimesheetsPage })))
const AbsencesPage = lazy(() => import('@/features/absences/AbsencesPage').then(m => ({ default: m.AbsencesPage })))
const FinancialsPage = lazy(() => import('@/features/financials/FinancialsPage').then(m => ({ default: m.FinancialsPage })))
const ReportsPage = lazy(() => import('@/features/reports/ReportsPage').then(m => ({ default: m.ReportsPage })))
const AuditPage = lazy(() => import('@/features/audit/AuditPage').then(m => ({ default: m.AuditPage })))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage').then(m => ({ default: m.SettingsPage })))
const ProposalsPage = lazy(() => import('@/features/proposals/ProposalsPage').then(m => ({ default: m.ProposalsPage })))
const ProposalPartnerPage = lazy(() => import('@/features/proposals/ProposalPartnerPage').then(m => ({ default: m.ProposalPartnerPage })))
const CallsPage = lazy(() => import('@/features/calls/CallsPage').then(m => ({ default: m.CallsPage })))
const ProfileSettingsPage = lazy(() => import('@/features/profile/ProfileSettingsPage').then(m => ({ default: m.ProfileSettingsPage })))
const TermsPage = lazy(() => import('@/features/legal/TermsPage').then(m => ({ default: m.TermsPage })))
const PrivacyPage = lazy(() => import('@/features/legal/PrivacyPage').then(m => ({ default: m.PrivacyPage })))
const LandingPage = lazy(() => import('@/features/landing/LandingPage').then(m => ({ default: m.LandingPage })))
const HelpPage = lazy(() => import('@/features/help/HelpPage').then(m => ({ default: m.HelpPage })))
const CollabAcceptInvite = lazy(() => import('@/features/projects/collaboration/CollabAcceptInvite').then(m => ({ default: m.CollabAcceptInvite })))
const EmailPreferencesPage = lazy(() => import('@/features/email/EmailPreferencesPage').then(m => ({ default: m.EmailPreferencesPage })))
const CollabPages = lazy(() => import('@/features/projects/collaboration/CollabPages').then(m => ({ default: m.CollabPages })))
const InviteSignupPage = lazy(() => import('@/features/auth/InviteSignupPage').then(m => ({ default: m.InviteSignupPage })))

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="space-y-4 w-64 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-xl">
          G
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4 mx-auto" />
      </div>
    </div>
  )
}

export default function App() {
  const { initialize, isLoading, user, orgId, accessType, signOut } = useAuthStore()

  useEffect(() => {
    initialize()
  }, [initialize])

  // Ephemeral session: sign out when browser/tab closes if "Stay logged in" was unchecked
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (sessionStorage.getItem('gl_session_ephemeral') === '1') {
        // Use synchronous localStorage flag so next load knows to sign out
        localStorage.setItem('gl_signout_pending', '1')
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // On mount, check if a signout was pending (from a previous ephemeral session)
  useEffect(() => {
    if (localStorage.getItem('gl_signout_pending') === '1') {
      localStorage.removeItem('gl_signout_pending')
      signOut()
    }
  }, [signOut])

  if (isLoading) {
    return <LoadingScreen />
  }

  // User is authenticated but has no organisation — show onboarding
  // Collab-only users (accessType === 'collab_partner') skip onboarding
  const isCollabOnly = accessType === 'collab_partner'
  const needsOnboarding = user && !orgId && !isCollabOnly
  const userHome = isCollabOnly ? '/projects/collaboration' : '/dashboard'

  // Detect whether we're on the app subdomain (app.grantlume.com) or the marketing domain
  const hostname = window.location.hostname
  const isAppDomain = hostname.startsWith('app.') || hostname === 'localhost' || hostname === '127.0.0.1'

  return (
    <>
      <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/" element={
          user
            ? <Navigate to={userHome} replace />
            : isAppDomain
              ? <Navigate to="/login" replace />
              : <LandingPage />
        } />
        <Route path="/home" element={user ? <Navigate to={userHome} replace /> : <LandingPage />} />
        <Route path="/login" element={user ? <Navigate to={userHome} replace /> : <LoginPage />} />
        <Route path="/signup" element={user ? <Navigate to={userHome} replace /> : <SignUpPage />} />
        <Route path="/forgot-password" element={user ? <Navigate to={userHome} replace /> : <ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/collab/accept" element={<CollabAcceptInvite />} />
        <Route path="/email-preferences" element={<EmailPreferencesPage />} />
        <Route path="/invite/accept" element={user ? <Navigate to={userHome} replace /> : <InviteSignupPage />} />

        <Route
          path="/*"
          element={
            !user && !isAppDomain ? (
              <LandingPage />
            ) : <ProtectedRoute>
              {needsOnboarding ? (
                <OnboardingWizard />
              ) : (
                <AppShell>
                  <ErrorBoundary>
                    <Suspense fallback={<LoadingScreen />}>
                    <Routes>
                      <Route
                        path="/dashboard"
                        element={
                          <ProtectedRoute permission="canSeeDashboard">
                            <DashboardPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/projects/collaboration/*"
                        element={
                          <ProtectedRoute permission="canSeeCollaboration">
                            <CollabPages />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/projects/*"
                        element={
                          <ProtectedRoute permission="canSeeProjects">
                            <ProjectsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/staff/*"
                        element={
                          <ProtectedRoute permission="canSeeStaff">
                            <StaffPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/allocations"
                        element={
                          <ProtectedRoute permission="canSeeAllocations">
                            <AllocationsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/timesheets"
                        element={
                          <ProtectedRoute permission="canSeeTimesheets">
                            <TimesheetsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/absences"
                        element={
                          <ProtectedRoute permission="canSeeAbsences">
                            <AbsencesPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/financials"
                        element={
                          <ProtectedRoute permission="canSeeFinancials">
                            <FinancialsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/timeline"
                        element={<Navigate to="/projects?view=timeline" replace />}
                      />
                      <Route
                        path="/reports"
                        element={
                          <ProtectedRoute permission="canSeeReports">
                            <ReportsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/audit"
                        element={
                          <ProtectedRoute permission="canSeeAudit">
                            <AuditPage />
                          </ProtectedRoute>
                        }
                      />
                      {/* External-partner view of an invited proposal.
                          Declared BEFORE the coordinator route below so the
                          more specific path wins matching. No permission
                          gate — authenticated users land here; RLS gates
                          the data they can actually see. */}
                      <Route
                        path="/proposals/partner/:id"
                        element={
                          <ProtectedRoute>
                            <ProposalPartnerPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/proposals/*"
                        element={
                          <ProtectedRoute permission="canSeeProposals">
                            <ProposalsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/calls"
                        element={
                          <ProtectedRoute permission="canSeeProposals">
                            <CallsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/settings"
                        element={
                          <ProtectedRoute permission="canManageOrg">
                            <SettingsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route path="/profile" element={<ProfileSettingsPage />} />
                      <Route path="/help" element={<HelpPage />} />
                      <Route path="/" element={<Navigate to={userHome} replace />} />
                      <Route path="*" element={<Navigate to={userHome} replace />} />
                    </Routes>
                    </Suspense>
                  </ErrorBoundary>
                </AppShell>
              )}
            </ProtectedRoute>
          }
        />
      </Routes>
      </Suspense>
      <Toaster />
    </>
  )
}
