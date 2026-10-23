import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { rawGet } from '../lib/connectors/sitecrawl.ts'
import { once } from '../lib/scan/fetch-page.ts'
import { makeSafeGet } from '../lib/sources/http.ts'

// Self-signed throwaway pair (CN=127.0.0.1), local only; not a credential. No external network.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const CERT = '-----BEGIN CERTIFICATE-----\nMIIDCTCCAfGgAwIBAgIUIrE+q4IikyBeihVpuHz4dcfZiOcwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAyMjIyMDA1MVoXDTM2MTAx\nOTIyMDA1MVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEApDwb4fs8w2SDp0wHNStCYedXWe2bc73e7j08zVnXqYAJ\nXlbKKMVT7/r3T5nCABqfR972wLxUfRxSHm5itiOmR5nAfennmWC4lnwUsrLMZkKA\nqxTyzjA5KjQH+IOOKozfhcvf/1nt0+1ALZmgaaopXPUS358gBMazpifIZ42sXwQ7\nWRiSI38zxJs+VvtRyuCW+d6CXrp+ahpYfs4VaBAlATk9UNpQFXcLFiyr81RW1PR/\npq/l6TAfD3ZSDoZ8hAwC/5S3pQxGLb9+QdY6e94tnvz/9mSFyUdQTkdTAVC5Gfcr\nRk2pTBH1EedZ+K+mJBCBg8YIx5SFQe0v34/oSAGVCQIDAQABo1MwUTAdBgNVHQ4E\nFgQUAnHVAzhIygTjGfE2aPGBr5y1SiUwHwYDVR0jBBgwFoAUAnHVAzhIygTjGfE2\naPGBr5y1SiUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAP7ea\npj34Wj7CF00IiypBJPPchWkBPY0J6ecsLfhWjNq7vNR2LlcTyaY33rXHyrzdVfIY\ne+zMq7W7kbC43RXkwdO0wbcPsvocV0tQkfSCpvkvGkeEPfVk9SjhWDsRXsfWvBQp\noWDUixUrFkyqez8YIOb6GKV3pz/U2YyKn/2Nv6eyFqK7qdF377i6gzq9lxJoo/vR\nhxCHDs6s/dXFMO6nKQbeJ/yJSLAP44ZG5NFkR2LYof5b9fRN0hHlcRihFlJFLE5H\ncg7S1apaHiDdRIhTlG4T6nJ8MPi7s7tfpAANvzxChW3bvFfm6PNXXLK0zhy/M2rS\niQ4tLzy7CyUgMaaKVA==\n-----END CERTIFICATE-----\n'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCkPBvh+zzDZIOn\nTAc1K0Jh51dZ7Ztzvd7uPTzNWdepgAleVsooxVPv+vdPmcIAGp9H3vbAvFR9HFIe\nbmK2I6ZHmcB96eeZYLiWfBSyssxmQoCrFPLOMDkqNAf4g44qjN+Fy9//We3T7UAt\nmaBpqilc9RLfnyAExrOmJ8hnjaxfBDtZGJIjfzPEmz5W+1HK4Jb53oJeun5qGlh+\nzhVoECUBOT1Q2lAVdwsWLKvzVFbU9H+mr+XpMB8PdlIOhnyEDAL/lLelDEYtv35B\n1jp73i2e/P/2ZIXJR1BOR1MBULkZ9ytGTalMEfUR51n4r6YkEIGDxgjHlIVB7S/f\nj+hIAZUJAgMBAAECggEAPfSbBCX15zP84lixA2K9WRefgUI8eW4wMimRzVnOHJg7\ncIZHHxhJsOc48qNrZwSj/8XhyhWBvey4Idi8jj9mk+4xio55mwe8urA2Uq9WomEG\nDwQJELVqazxToXFnaS/ZhqzBZJ/1MxR2OH2S4SmbDwE4zHlH5+VZkh3B4Sa11uWz\nxfE97BDaQWyllkzSCEg1QTk4ZY5iY3z6no7lKFvoKA/1y9Zc7EKnJj1TWgr79hvJ\nuFpAIwfqvuXj24feUDpVVAqGVf4MyQoPrnSsHh63vzxg8mYGjVu39WNj04rSGJQV\novyp2hVqJksjDUgMinm+BvgrmBF1TU8Rfbql7hey/QKBgQDAd1Wrqz4HgoYX4LO+\nJwr8+pKdXfrbNvHi8X/QR8ZVRMcukTYYBzr8gfIb+5HgviyPJWxWh1b71DPjFzvA\n6q9VSwDERLDDn8qVIvRgcauBuBGaEc8rqqwZCCjwm7nuwqBHv2S8EmUOUeIZMyLS\noajfgZFMwMAndyMEqrxBJxHLhwKBgQDacwm9BuSxA2VmN3atTEW055w7AFOI4SJp\nMXbdDvbVa9KIurtP/+h1fuyVyzB68cP0ZZirwFL+kTpuiX5Ccp5HxQCGx+6MqOlg\n231vmw/0FdiKSB+ryIj1DeY1La1YxC+8PYsim0a9OwrHY6J9ehOhTBByF2gtIz8Q\nveQRkU9e7wKBgQCCkXKBH47ZMWce08WcfogpzyOftp30EXZPa142Qjr+pcYqhUCZ\nVG5j1xQUf7obKWi5Q74XhYExHmiE6sISwiNoTZWbkK4KSGD6g9gdhX/AZMssJmDR\nUtulr692a27b1xU9F06TeDcuW8ZzKgm5swoJdrDHzQuOunf7Noi3+nVMCQKBgBzJ\nI/NgwSoCRI5fqKfVcSoRiyjLNjbHU/2AoyUmH6in+KpD0QMNudghzZM/nzfUO/os\nmR2ozkb1ZDnErHqdF/ZlI1ifZ/PpHjfBNJpMWKHVbx9puaKtXj7MghVn23vi/ldT\n1M3OoFe3PAhiPLtEJuoOV+xw4S1xg5H1M+SMvWTJAoGAEUNY20QQQZX1PNphPhoQ\nVhfn5pxio2teDvi5OJEgyW90vYKBJGtD/Pyke55Qk5AgcdK2miOTgJJKWBJ2/rgq\nkwx2xlEkUPvAmm5czHztOwEvSkbx9ma0i92lKYHDvdhik4hptOZjZ+BIjG9oCpb3\njIIGvXbtxXmkqRrZbDthc+A=\n-----END PRIVATE KEY-----\n'

const loopback = (_h: string, _o: { all?: boolean }, cb: (...a: unknown[]) => void) => cb(null, '127.0.0.1', 4)
const HARD = 400 // absolute bound injected for the test; the drip interval is far below it

// Sends valid headers, then one byte every 40 ms forever: socket inactivity never reaches the 'timeout'
// event, so only an absolute timer can end the request. Records whether the server side was torn down.
async function dripServer(opts: { dripHeaders?: boolean } = {}) {
  let closed = 0
  const timers: NodeJS.Timeout[] = []
  const server = https.createServer({ cert: CERT, key: KEY }, (_req, res) => {
    res.on('close', () => { closed++ })
    res.writeHead(200, { 'content-type': 'text/html' })
    const t = setInterval(() => { if (!res.destroyed) res.write('x') }, 40)
    timers.push(t)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  void opts
  return { port, closed: () => closed, stop: () => { timers.forEach(clearInterval); server.closeAllConnections(); server.close() } }
}

const never = new Promise<string>(r => setTimeout(() => r('NEVER-SETTLED'), 3000))

test('sitecrawl rawGet: slow-drip body settles at the absolute bound and the socket is torn down', async () => {
  const s = await dripServer(); const t0 = Date.now()
  const out = await Promise.race([rawGet(`https://127.0.0.1:${s.port}/`, 0, HARD, loopback as never), never])
  const dt = Date.now() - t0
  await new Promise(r => setTimeout(r, 150))
  const closed = s.closed(); s.stop()
  assert.notEqual(out, 'NEVER-SETTLED'); assert.equal(out, null)
  assert.ok(dt >= HARD - 50 && dt < 1500, 'settled near the absolute bound, not at the inactivity bound: ' + dt)
  assert.equal(closed, 1, 'server saw the connection torn down')
})

test('fetch-page once: slow-drip body rejects at the absolute bound and the socket is torn down', async () => {
  const s = await dripServer(); const t0 = Date.now()
  const out = await Promise.race([once(new URL(`https://127.0.0.1:${s.port}/`), HARD, loopback as never).then(() => 'resolved', (e: Error) => 'rejected:' + e.message), never])
  const dt = Date.now() - t0
  await new Promise(r => setTimeout(r, 150))
  const closed = s.closed(); s.stop()
  assert.notEqual(out, 'NEVER-SETTLED'); assert.match(String(out), /^rejected:/)
  assert.ok(dt >= HARD - 50 && dt < 1500, 'dt ' + dt)
  assert.equal(closed, 1)
})

test('sources safeGet: slow-drip body settles null at the absolute bound and the socket is torn down', async () => {
  const s = await dripServer(); const t0 = Date.now()
  const out = await Promise.race([makeSafeGet(HARD, loopback as never, true)(`https://127.0.0.1:${s.port}/`), never])
  const dt = Date.now() - t0
  await new Promise(r => setTimeout(r, 150))
  const closed = s.closed(); s.stop()
  assert.notEqual(out, 'NEVER-SETTLED'); assert.equal(out, null)
  assert.ok(dt >= HARD - 50 && dt < 1500, 'dt ' + dt)
  assert.equal(closed, 1)
})

test('all three: a fast normal response still returns status and body (success path preserved)', async () => {
  const server = https.createServer({ cert: CERT, key: KEY }, (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Acme Dental</html>') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const u = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const a = await rawGet(u, 0, 2000, loopback as never)
  const b = await once(new URL(u), 2000, loopback as never)
  const c = await makeSafeGet(2000, loopback as never, true)(u)
  server.close()
  for (const r of [a, b, c]) { assert.equal(r?.status, 200); assert.ok(r?.body.includes('Acme Dental')) }
})

test('all three: a body over the byte cap still resolves with the capped prefix, not null (no regression on the size path)', async () => {
  const server = https.createServer({ cert: CERT, key: KEY }, (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('y'.repeat(3_000_000)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const u = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const a = await rawGet(u, 0, 5000, loopback as never)
  const b = await once(new URL(u), 5000, loopback as never)
  const c = await makeSafeGet(5000, loopback as never, true)(u)
  server.close()
  for (const r of [a, b, c]) { assert.equal(r?.status, 200); assert.ok(r!.body.length > 0 && r!.body.length < 3_000_000) }
})
