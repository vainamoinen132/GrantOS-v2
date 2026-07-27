import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface ErrorStateProps {
  title?: string
  description?: string
  /** When provided, renders a retry button that re-runs the failed query. */
  onRetry?: () => void
  className?: string
}

/**
 * Shown when a data query fails. Without this, a failed fetch falls back to an
 * empty array and the page renders its empty state ("No data"), which during an
 * outage misleads users into thinking their records are gone. This makes the
 * failure explicit and offers a retry. Strings fall back to English when a
 * locale key is missing, so it is safe to ship before keys are translated.
 */
export function ErrorState({ title, description, onRetry, className }: ErrorStateProps) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      <div className="mb-4 rounded-full bg-destructive/10 p-3">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <h3 className="text-lg font-semibold">
        {title ?? t('common.loadErrorTitle', 'Could not load data')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground max-w-sm">
        {description ?? t('common.loadErrorDesc', 'Something went wrong while loading. Please check your connection and try again.')}
      </p>
      {onRetry && (
        <div className="mt-4">
          <Button variant="outline" onClick={onRetry}>
            {t('common.retry', 'Try again')}
          </Button>
        </div>
      )}
    </div>
  )
}
