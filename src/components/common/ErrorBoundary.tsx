import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Sentry } from '@/lib/sentry'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'
// ErrorBoundary is a class component, so it can't use the useTranslation
// hook. Reach the same i18next singleton directly via .t() — picks up
// the active language and falls back to en for any missing key.
import i18n from '@/lib/i18n'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[GrantLume] Uncaught error:', error, errorInfo)
    Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex flex-col items-center justify-center min-h-[300px] gap-4 p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold">{i18n.t('errorBoundary.title')}</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            {/* Only surface the raw error text in development. In production
                show a friendly message so internal details aren't leaked. */}
            {import.meta.env.DEV && this.state.error?.message
              ? this.state.error.message
              : i18n.t('errorBoundary.unexpected')}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={this.handleReset}>
              {i18n.t('errorBoundary.tryAgain')}
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              {i18n.t('errorBoundary.reload')}
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
