// dazl advanced-connectors worker.
// The dazl app POSTs {platform, query, session} here with a bearer token; this process
// uses that one tenant's own session cookie to search the platform and returns
// {items:[{url,title,quote,date,login_walled}]}. It holds no database, no tenant id and
// no keys of its own. See README.md for deployment and risk notes.
//
// Failure contract (#436): a supported platform whose fetch FAILED answers a non-200 with a
// known failure outcome ({outcome: 'auth_failed' | 'throttled' | 'schema_error' | 'upstream_error'}),
// and an unknown platform answers 200 {items: [], outcome: 'unsupported', reason}. The app audits
// each as its own status. The ONLY empty 200 is a genuine search that found nothing - a failure
// or an unbuilt platform must never look like one.
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { fetchReddit } from './lib/reddit.js'
import { fetchX } from './lib/x.js'

const PORT = Number(process.env.PORT || 8787)
const TOKEN = process.env.ADVANCED_WORKER_TOKEN || ''
const HANDLERS = { reddit: fetchReddit, x: fetchX }
// Operator-level throwaway sessions, used only when the requesting tenant did not
// supply its own session cookie. Never logged; /health exposes booleans only.
const OPERATOR_SESSIONS = {
  x: process.env.X_SESSION_COOKIE || '',
  reddit: process.env.REDDIT_SESSION_COOKIE || '',
  linkedin: process.env.LINKEDIN_SESSION_COOKIE || '',
}

const VERSION = '0.3.0'

// Maps a fetcher's thrown error to the app's typed-failure outcomes
// (web/lib/advanced/index.ts WORKER_FAILURES). Anything unrecognized is upstream_error.
export const classifyFetchError = (message) => {
  const m = String(message || '')
  if (/429|throttl|rate.?limit/i.test(m)) return { code: 429, outcome: 'throttled' }
  if (/\b(401|403)\b|auth_token|unauthorized|forbidden/i.test(m)) return { code: 502, outcome: 'auth_failed' }
  if (/schema/i.test(m)) return { code: 502, outcome: 'schema_error' }
  return { code: 502, outcome: 'upstream_error' }
}

export function createWorkerServer(handlers = HANDLERS, token = TOKEN) {
  const supported = Object.keys(handlers)
  const tokenOk = (got) => {
    const a = Buffer.from(got || ''), b = Buffer.from(`Bearer ${token}`)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const send = (res, code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const operator_sessions = Object.fromEntries(Object.entries(OPERATOR_SESSIONS).map(([k, v]) => [k, Boolean(v)]))
        return send(res, 200, { ok: true, platforms: supported, operator_sessions, version: VERSION })
      }
      if (req.method !== 'POST' || req.url !== '/fetch') return send(res, 404, { error: 'not_found' })
      if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' })

      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 64_000) return send(res, 413, { error: 'too_large' })
      }
      let body
      try { body = JSON.parse(raw) } catch { return send(res, 400, { error: 'bad_json' }) }
      const { platform, query, session } = body || {}
      if (typeof query !== 'string' || query.trim().length < 2) return send(res, 400, { error: 'bad_query' })
      // Tenant session wins; otherwise fall back to the operator throwaway session.
      // Only 400 when neither exists - otherwise every sessionless tenant would error.
      const useSession = (typeof session === 'string' && session.length >= 10) ? session : (OPERATOR_SESSIONS[platform] || '')
      if (!useSession) return send(res, 400, { error: 'no_session' })

      const handler = handlers[platform]
      // Unknown or not-yet-built platforms are an explicit 'unsupported' outcome: the app audits
      // it as 'unsupported', never as a zero-result search and never as a worker error (#436).
      if (!handler) return send(res, 200, { items: [], outcome: 'unsupported', reason: `platform '${String(platform).slice(0, 40)}' is not implemented by this worker build (supported: ${supported.join(', ')})` })

      let items
      try {
        items = await handler({ query: query.slice(0, 300), session: useSession })
      } catch (e) {
        // A platform failing must never look like a zero-result search: answer the typed failure.
        const { code, outcome } = classifyFetchError(e instanceof Error ? e.message : 'error')
        console.error('fetch failed', outcome, e instanceof Error ? e.message : 'error')
        return send(res, code, { outcome })
      }
      return send(res, 200, { items: items.slice(0, 20) })
    } catch (e) {
      console.error('request failed', e instanceof Error ? e.message : 'error')
      return send(res, 502, { outcome: 'upstream_error' })
    }
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  if (!TOKEN) {
    console.error('ADVANCED_WORKER_TOKEN is required (generate: openssl rand -hex 32)')
    process.exit(1)
  }
  createWorkerServer().listen(PORT, () => console.log(`dazl-worker listening on :${PORT} (platforms: ${Object.keys(HANDLERS).join(', ')})`))
}
