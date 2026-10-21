// dazl advanced-connectors worker.
// The dazl app POSTs {platform, query, session} here with a bearer token; this process
// uses that one tenant's own session cookie to search the platform and returns
// {items:[{url,title,quote,date,login_walled}]}. It holds no database, no tenant id and
// no keys of its own. See README.md for deployment and risk notes.
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { fetchReddit } from './lib/reddit.js'
import { fetchX } from './lib/x.js'

const PORT = Number(process.env.PORT || 8787)
const TOKEN = process.env.ADVANCED_WORKER_TOKEN || ''
const HANDLERS = { reddit: fetchReddit, x: fetchX }
const SUPPORTED = Object.keys(HANDLERS)

if (!TOKEN) {
  console.error('ADVANCED_WORKER_TOKEN is required (generate: openssl rand -hex 32)')
  process.exit(1)
}

const tokenOk = (got) => {
  const a = Buffer.from(got || ''), b = Buffer.from(`Bearer ${TOKEN}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

const send = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, platforms: SUPPORTED, version: '0.1.0' })
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
    if (typeof session !== 'string' || session.length < 10) return send(res, 400, { error: 'bad_session' })

    const handler = HANDLERS[platform]
    // Unknown or not-yet-built platforms return an empty result, not an error: the app
    // audits that as 'empty' for this scan instead of 'worker_error'.
    if (!handler) return send(res, 200, { items: [] })

    const items = await handler({ query: query.slice(0, 300), session })
    return send(res, 200, { items: items.slice(0, 20) })
  } catch (e) {
    // A platform failing must not take down the request: empty beats a 500, the app
    // treats null/!ok as worker_error only when the HTTP call itself failed.
    console.error('fetch failed', e instanceof Error ? e.message : 'error')
    return send(res, 200, { items: [] })
  }
})

server.listen(PORT, () => console.log(`dazl-worker listening on :${PORT} (platforms: ${SUPPORTED.join(', ')})`))
