// dazl session worker: serves POST /fetch for the web app's advanced (session) connectors.
// The app sends {platform, query, session} with a bearer token; the worker replies {items:[...]} when it searched, or
// {items: [], outcome} when it did not (#436): 501 unsupported for a platform it cannot read at all, and 200 with
// outcome auth / throttled / schema / upstream / timeout / error otherwise. An empty items list without an outcome is a
// genuine search that found nothing.
// The request carries one tenant's own session cookie and nothing else. Nothing is stored.
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { FETCHERS, isPlatform, UNSUPPORTED } from './fetchers.ts'
import { WorkerFailure } from './util.ts'

const PORT = Number(process.env.PORT || 3210)
const MAX_BODY = 20_000

// The server, without listening (tests start it on a free port).
export const createWorkerServer = (TOKEN = process.env.ADVANCED_WORKER_TOKEN ?? '') => http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => {
    const b = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) })
    res.end(b)
  }
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true })
  if (req.method !== 'POST' || req.url !== '/fetch') return reply(404, { error: 'not found' })
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'unauthorized' })
  let body = ''
  let tooBig = false
  req.on('data', (c: Buffer) => { body += c.toString('utf8'); if (body.length > MAX_BODY) { tooBig = true; req.destroy() } })
  req.on('end', async () => {
    if (tooBig) return reply(413, { error: 'too large' })
    let parsed: { platform?: unknown; query?: unknown; session?: unknown }
    try { parsed = JSON.parse(body) } catch { return reply(400, { error: 'bad json' }) }
    if (!isPlatform(parsed.platform)) return reply(400, { error: 'unknown platform' })
    if (UNSUPPORTED.has(parsed.platform)) return reply(501, { items: [], outcome: 'unsupported' })
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
      // never a crash, and never an empty success: the app audits the outcome
      return reply(200, { items: [], outcome: e instanceof WorkerFailure ? e.code : e instanceof Error && e.message === 'timeout' ? 'timeout' : 'error' })
    }
  })
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createWorkerServer().listen(PORT, () => console.log(`dazl session worker on :${PORT}`))
}
