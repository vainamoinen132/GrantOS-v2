/**
 * Canonical public URL of the application, for links inside emails and invites.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old inline expression had an operator-precedence bug:
 *
 *   const baseUrl = process.env.VITE_APP_URL || process.env.VERCEL_URL
 *     ? `https://${process.env.VERCEL_URL}`
 *     : 'http://localhost:5173'
 *
 * `||` binds tighter than `?:`, so the whole thing reads as
 * `(A || B) ? \`https://${B}\` : C`. Whenever VITE_APP_URL was set but
 * VERCEL_URL was not, every invite link became "https://undefined/...".
 *
 * Resolution order:
 *   1. APP_URL / NEXT_PUBLIC_APP_URL / VITE_APP_URL — explicit configuration
 *   2. VERCEL_PROJECT_PRODUCTION_URL — the stable production domain
 *   3. VERCEL_URL — the per-deployment preview domain
 *   4. localhost, for local development
 */
export function appUrl(): string {
  const explicit =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VITE_APP_URL

  if (explicit) return stripTrailingSlash(withScheme(explicit))

  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (productionHost) return `https://${stripTrailingSlash(productionHost)}`

  const deploymentHost = process.env.VERCEL_URL
  if (deploymentHost) return `https://${stripTrailingSlash(deploymentHost)}`

  return 'http://localhost:5173'
}

function withScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
