// dazl session worker: serves POST /fetch for the web app's advanced (session) connectors.
// The app sends {platform, query, session} with a bearer token; the worker replies {items:[...]}.
// The request carries one tenant's own session cookie and nothing else. Nothing is stored.
import http from 'node:http'
import { CAPABILITY, FETCHERS, isPlatform } from './fetchers.ts'
import { FetchFailure } from './util.ts'
import { fetchEngagers, isEngagerKind } from './linkedin-engagers.ts'

const TOKEN = process.env.ADVANCED_WORKER_TOKEN ?? ''
const PORT = Number(process.env.PORT || 3210)
const MAX_BODY = 20_000

const server = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent || res.writableEnded) return
    const b = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) })
    res.end(b)
  }
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true })
  if (req.method !== 'POST' || (req.url !== '/fetch' && req.url !== '/linkedin/engagers')) return reply(404, { error: 'not found' })
  const route = req.url
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'unauthorized' })
  let body = ''
  let tooBig = false
  req.on('data', (c: Buffer) => { body += c.toString('utf8'); if (body.length > MAX_BODY) { tooBig = true; req.destroy() } })
  // A client that aborts mid-body must not surface as an unhandled 'error' event.
  req.on('error', () => { if (!tooBig) reply(400, { error: 'bad request' }) })
  req.on('end', () => {
    // The whole async path is caught: one malformed authenticated request must never take
    // down the shared worker for every tenant (#933).
    handle().catch(() => reply(500, { error: 'internal' }))
  })
  const handle = async () => {
    if (tooBig) return reply(413, { error: 'too large' })
    let raw: unknown
    try { raw = JSON.parse(body) } catch { return reply(400, { error: 'bad json' }) }
    // JSON.parse accepts null, arrays and primitives; only a plain object is a request.
    if (!isPlainObject(raw)) return reply(400, { error: 'body must be a JSON object' })
    const parsed = raw as { platform?: unknown; query?: unknown; session?: unknown }
    // #192: one page of a post's commenters or reactors through the session the app sends. One request = one upstream GET.
    if (route === '/linkedin/engagers') {
      const e = raw as { kind?: unknown; post?: unknown; session?: unknown }
      if (!isEngagerKind(e.kind) || typeof e.post !== 'string' || typeof e.session !== 'string' || !e.post || !e.session) return reply(400, { error: 'kind, post and session are required' })
      try {
        const items = await Promise.race([fetchEngagers(e.kind, e.post.slice(0, 300), e.session.slice(0, 8000)), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 40_000))])
        return reply(200, { items, upstream_requests: 1 })
      } catch (err) { return reply(502, { error: 'fetch_failed', outcome: err instanceof FetchFailure ? err.kind : 'upstream_error' }) }
    }
    if (!isPlatform(parsed.platform)) return reply(400, { error: 'unknown platform' })
    // An adapter this build cannot run is refused before any platform request and reported as
    // 'unsupported' - distinct from a genuine empty result and from a failure.
    const capability = CAPABILITY[parsed.platform]
    if (!capability.supported) return reply(200, { items: [], outcome: 'unsupported', reason: capability.reason })
    if ((parsed.query !== undefined && typeof parsed.query !== 'string') || (parsed.session !== undefined && typeof parsed.session !== 'string')) {
      return reply(400, { error: 'query and session must be strings' })
    }
    const query = typeof parsed.query === 'string' ? parsed.query.slice(0, 300) : ''
    const session = typeof parsed.session === 'string' ? parsed.session.slice(0, 8000) : ''
    if (!query || !session) return reply(400, { error: 'missing query or session' })
    try {
      const items = await Promise.race([
        FETCHERS[parsed.platform](query, session, process.env),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 40_000)),
      ])
      return reply(200, { items: items.slice(0, 20) })
    } catch (e) {
      // A failed fetch is never an empty result. The outcome says why (auth_failed, throttled,
      // schema_error, upstream_error) so the app audits it distinctly; a crash or timeout is
      // upstream_error. The app treats any non-200 as a failure, never as zero results.
      const outcome = e instanceof FetchFailure ? e.kind : 'upstream_error'
      return reply(502, { error: 'fetch_failed', outcome })
    }
  }
})

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

server.listen(PORT, () => console.log(`dazl session worker on :${PORT}`))
