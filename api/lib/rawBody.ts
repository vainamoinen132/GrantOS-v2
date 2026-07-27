import type { VercelRequest } from '@vercel/node'

/**
 * Raw request-body helpers for webhook signature verification.
 *
 * WHY THIS EXISTS
 * ---------------
 * Stripe and DocuSign both sign the EXACT BYTES they sent. Vercel's default
 * body parser turns those bytes into a JavaScript object, and the object can
 * never be turned back into the identical byte string:
 *
 *   - `JSON.stringify` re-orders integer-like keys ("0", "1", …)
 *   - whitespace and unicode escaping are not preserved
 *   - number formatting is not guaranteed to round-trip
 *
 * Verifying a signature against `JSON.stringify(req.body)` therefore fails
 * unpredictably. When it fails on the Stripe webhook, paid subscriptions are
 * never activated. When it fails on the DocuSign webhook, timesheets never
 * reach "Signed".
 *
 * Any route using these helpers MUST disable the body parser:
 *
 *   export const config = { api: { bodyParser: false } }
 *
 * and then use `parseJsonBody()` instead of `req.body` for its non-webhook
 * actions.
 */

export class BodyError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'BodyError'
  }
}

/** 1 MB — comfortably above any Stripe/DocuSign event, small enough to bound memory. */
const MAX_BODY_BYTES = 1_048_576

/**
 * Read the untouched request body as a Buffer.
 *
 * Throws if the route forgot to disable the body parser, rather than silently
 * falling back to a re-serialised body — a signature check that "passes" on
 * reconstructed bytes is worse than one that fails loudly.
 */
export async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const anyReq = req as any

  // Some runtimes expose the original bytes directly.
  if (Buffer.isBuffer(anyReq.rawBody)) return anyReq.rawBody
  if (typeof anyReq.rawBody === 'string') return Buffer.from(anyReq.rawBody, 'utf8')

  // With bodyParser disabled, req.body is undefined and the stream is intact.
  if (anyReq.body !== undefined && anyReq.body !== null && typeof anyReq.body !== 'string') {
    throw new BodyError(
      500,
      'Request body was already parsed — this route must set `export const config = { api: { bodyParser: false } }`',
    )
  }
  if (typeof anyReq.body === 'string') return Buffer.from(anyReq.body, 'utf8')

  const chunks: Buffer[] = []
  let total = 0

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > MAX_BODY_BYTES) {
        reject(new BodyError(413, 'Request body too large'))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve())
    req.on('error', (err: Error) => reject(err))
  })

  return Buffer.concat(chunks)
}

/**
 * Read and JSON-parse the body. For routes that disabled the body parser and
 * still need normal JSON handling on their non-webhook actions.
 *
 * Returns `{}` for an empty body so callers can destructure safely.
 */
export async function parseJsonBody<T = any>(req: VercelRequest): Promise<T> {
  const raw = await readRawBody(req)
  if (raw.length === 0) return {} as T
  try {
    return JSON.parse(raw.toString('utf8')) as T
  } catch {
    throw new BodyError(400, 'Invalid JSON body')
  }
}
