// dazl session worker: serves POST /fetch for the web app's advanced (session) connectors.
// The app sends {platform, query, session} with a bearer token; the worker replies {items:[...]}, or a non-2xx
// {error} naming why there is no answer (src/handle.ts): never an empty list for a failure or an unsupported platform.
// The request carries one tenant's own session cookie and nothing else. Nothing is stored.
import http from 'node:http'
import { handleFetch } from './handle.ts'

const TOKEN = process.env.ADVANCED_WORKER_TOKEN ?? ''
const PORT = Number(process.env.PORT || 3210)
const MAX_BODY = 20_000

const server = http.createServer((req, res) => {
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
    const r = await handleFetch(body, process.env)
    return reply(r.status, r.body)
  })
})

server.listen(PORT, () => console.log(`dazl session worker on :${PORT}`))
