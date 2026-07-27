/**
 * HTML escaping for email templates.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every value in api/emails/templates.ts is interpolated straight into an HTML
 * string. Those values come from user-controlled data — person names,
 * organisation names, project titles, absence reasons, support messages — and
 * the emails go out from a verified GrantLume domain.
 *
 * Without escaping:
 *   1. A name like `Ann & Co <ops>` renders broken.
 *   2. A crafted value can inject arbitrary markup and links into an email
 *      that looks like it came from GrantLume — a phishing template with your
 *      branding and your SPF/DKIM alignment.
 *
 * Rules:
 *   - `esc()`  for anything that lands in text or an attribute value.
 *   - `escUrl()` for anything that lands in an href/src. It rejects
 *     javascript:, data: and other non-http(s) schemes.
 */

/** Escape a value for safe interpolation into HTML text or an attribute. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Alias used by handlers outside the template module. */
export const escapeHtml = esc

/**
 * Escape a value destined for an href/src attribute.
 * Only http(s) and mailto are allowed through; anything else becomes '#'.
 */
export function escUrl(value: unknown): string {
  if (value === null || value === undefined) return '#'
  const raw = String(value).trim()
  if (!raw) return '#'
  if (!/^(https?:|mailto:)/i.test(raw)) {
    // Relative URLs are fine; absolute ones with an unexpected scheme are not.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return '#'
  }
  return esc(raw)
}

/**
 * Escape every string value of a params object one level deep.
 * Used as a blanket guard so a newly added template cannot forget to escape.
 */
export function escapeParams<T extends Record<string, any>>(params: T): T {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string') {
      // URL-ish fields keep their structure but are still sanitised.
      out[key] = /url$/i.test(key) || /^https?:\/\//i.test(value) ? escUrl(value) : esc(value)
    } else if (Array.isArray(value)) {
      out[key] = value.map(v => (typeof v === 'string' ? esc(v) : v))
    } else {
      out[key] = value
    }
  }
  return out as T
}
