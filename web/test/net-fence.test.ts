import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// Regression for the reviewer-confirmed redirect bypass: an allowed loopback
// origin redirecting to a DENIED host must be blocked at the target check.
// Uses 127.0.0.2 (loopback range but not fence-allowed) so the probe never
// leaves the machine. Also pins redirect semantics the fence must preserve.
// Only meaningful under npm test (the fence loads via --import); skips otherwise.
const FENCED = (globalThis as Record<string, unknown>).__DAZL_NET_FENCE__ === true
const SKIP = { skip: !FENCED && 'net fence not loaded (run via npm test)' }

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
async function serve(host: string, handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, host, r))
  const { port } = server.address() as AddressInfo
  return { url: `http://${host}:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

test('fence blocks a redirect from an allowed origin to a denied host', SKIP, async () => {
  let reached = 0
  const denied = await serve('127.0.0.2', (_req, res) => { reached++; res.end('reached') })
  const origin = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(302, { location: `${denied.url}/stolen` })
    res.end()
  })
  await assert.rejects(fetch(`${origin.url}/start`), /net fence/)
  assert.equal(reached, 0, 'denied host was never contacted')
  await origin.close(); await denied.close()
})

test('303 redirect rewrites POST to GET and drops the body', SKIP, async () => {
  let seenMethod = ''
  let seenBody = ''
  const origin = await serve('127.0.0.1', (req, res) => {
    if (req.url === '/final') {
      seenMethod = req.method ?? ''
      req.on('data', (c) => { seenBody += c })
      req.on('end', () => res.end('ok'))
      return
    }
    res.writeHead(303, { location: '/final' })
    res.end()
  })
  const out = await fetch(`${origin.url}/start`, { method: 'POST', body: 'payload' })
  assert.equal(out.status, 200)
  assert.equal(seenMethod, 'GET')
  assert.equal(seenBody, '')
  await origin.close()
})

test('307 redirect preserves method and body', SKIP, async () => {
  let seenMethod = ''
  let seenBody = ''
  const origin = await serve('127.0.0.1', (req, res) => {
    if (req.url === '/final') {
      seenMethod = req.method ?? ''
      req.on('data', (c) => { seenBody += c })
      req.on('end', () => res.end('ok'))
      return
    }
    res.writeHead(307, { location: '/final' })
    res.end()
  })
  const out = await fetch(`${origin.url}/start`, { method: 'POST', body: 'payload' })
  assert.equal(out.status, 200)
  assert.equal(seenMethod, 'POST')
  assert.equal(seenBody, 'payload')
  await origin.close()
})

test("redirect: 'manual' returns the 3xx untouched (no following, no checking beyond origin)", SKIP, async () => {
  const origin = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.2:1/nope' })
    res.end()
  })
  const out = await fetch(`${origin.url}/`, { redirect: 'manual' })
  assert.equal(out.status, 302)
  assert.equal(out.headers.get('location'), 'http://127.0.0.2:1/nope')
  await origin.close()
})

test('redirect loop hits the hop cap instead of following forever', SKIP, async () => {
  const origin = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(302, { location: '/again' })
    res.end()
  })
  await assert.rejects(fetch(`${origin.url}/again`), /hop cap/)
  await origin.close()
})

test('plain loopback fetch still works', SKIP, async () => {
  const origin = await serve('127.0.0.1', (_req, res) => res.end('fine'))
  const out = await fetch(`${origin.url}/`)
  assert.equal(out.status, 200)
  assert.equal(await out.text(), 'fine')
  await origin.close()
})
