import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { rawGet, crawlJob } from '../lib/connectors/sitecrawl.ts'

// Self-signed throwaway pair shared with sitecrawl-timeout.test.ts (CN=127.0.0.1).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const CERT = '-----BEGIN CERTIFICATE-----\nMIIDCTCCAfGgAwIBAgIUIrE+q4IikyBeihVpuHz4dcfZiOcwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAyMjIyMDA1MVoXDTM2MTAx\nOTIyMDA1MVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEApDwb4fs8w2SDp0wHNStCYedXWe2bc73e7j08zVnXqYAJ\nXlbKKMVT7/r3T5nCABqfR972wLxUfRxSHm5itiOmR5nAfennmWC4lnwUsrLMZkKA\nqxTyzjA5KjQH+IOOKozfhcvf/1nt0+1ALZmgaaopXPUS358gBMazpifIZ42sXwQ7\nWRiSI38zxJs+VvtRyuCW+d6CXrp+ahpYfs4VaBAlATk9UNpQFXcLFiyr81RW1PR/\npq/l6TAfD3ZSDoZ8hAwC/5S3pQxGLb9+QdY6e94tnvz/9mSFyUdQTkdTAVC5Gfcr\nRk2pTBH1EedZ+K+mJBCBg8YIx5SFQe0v34/oSAGVCQIDAQABo1MwUTAdBgNVHQ4E\nFgQUAnHVAzhIygTjGfE2aPGBr5y1SiUwHwYDVR0jBBgwFoAUAnHVAzhIygTjGfE2\naPGBr5y1SiUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAP7ea\npj34Wj7CF00IiypBJPPchWkBPY0J6ecsLfhWjNq7vNR2LlcTyaY33rXHyrzdVfIY\ne+zMq7W7kbC43RXkwdO0wbcPsvocV0tQkfSCpvkvGkeEPfVk9SjhWDsRXsfWvBQp\noWDUixUrFkyqez8YIOb6GKV3pz/U2YyKn/2Nv6eyFqK7qdF377i6gzq9lxJoo/vR\nhxCHDs6s/dXFMO6nKQbeJ/yJSLAP44ZG5NFkR2LYof5b9fRN0hHlcRihFlJFLE5H\ncg7S1apaHiDdRIhTlG4T6nJ8MPi7s7tfpAANvzxChW3bvFfm6PNXXLK0zhy/M2rS\niQ4tLzy7CyUgMaaKVA==\n-----END CERTIFICATE-----\n'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCkPBvh+zzDZIOn\nTAc1K0Jh51dZ7Ztzvd7uPTzNWdepgAleVsooxVPv+vdPmcIAGp9H3vbAvFR9HFIe\nbmK2I6ZHmcB96eeZYLiWfBSyssxmQoCrFPLOMDkqNAf4g44qjN+Fy9//We3T7UAt\nmaBpqilc9RLfnyAExrOmJ8hnjaxfBDtZGJIjfzPEmz5W+1HK4Jb53oJeun5qGlh+\nzhVoECUBOT1Q2lAVdwsWLKvzVFbU9H+mr+XpMB8PdlIOhnyEDAL/lLelDEYtv35B\n1jp73i2e/P/2ZIXJR1BOR1MBULkZ9ytGTalMEfUR51n4r6YkEIGDxgjHlIVB7S/f\nj+hIAZUJAgMBAAECggEAPfSbBCX15zP84lixA2K9WRefgUI8eW4wMimRzVnOHJg7\ncIZHHxhJsOc48qNrZwSj/8XhyhWBvey4Idi8jj9mk+4xio55mwe8urA2Uq9WomEG\nDwQJELVqazxToXFnaS/ZhqzBZJ/1MxR2OH2S4SmbDwE4zHlH5+VZkh3B4Sa11uWz\nxfE97BDaQWyllkzSCEg1QTk4ZY5iY3z6no7lKFvoKA/1y9Zc7EKnJj1TWgr79hvJ\nuFpAIwfqvuXj24feUDpVVAqGVf4MyQoPrnSsHh63vzxg8mYGjVu39WNj04rSGJQV\novyp2hVqJksjDUgMinm+BvgrmBF1TU8Rfbql7hey/QKBgQDAd1Wrqz4HgoYX4LO+\nJwr8+pKdXfrbNvHi8X/QR8ZVRMcukTYYBzr8gfIb+5HgviyPJWxWh1b71DPjFzvA\n6q9VSwDERLDDn8qVIvRgcauBuBGaEc8rqqwZCCjwm7nuwqBHv2S8EmUOUeIZMyLS\noajfgZFMwMAndyMEqrxBJxHLhwKBgQDacwm9BuSxA2VmN3atTEW055w7AFOI4SJp\nMXbdDvbVa9KIurtP/+h1fuyVyzB68cP0ZZirwFL+kTpuiX5Ccp5HxQCGx+6MqOlg\n231vmw/0FdiKSB+ryIj1DeY1La1YxC+8PYsim0a9OwrHY6J9ehOhTBByF2gtIz8Q\nveQRkU9e7wKBgQCCkXKBH47ZMWce08WcfogpzyOftp30EXZPa142Qjr+pcYqhUCZ\nVG5j1xQUf7obKWi5Q74XhYExHmiE6sISwiNoTZWbkK4KSGD6g9gdhX/AZMssJmDR\nUtulr692a27b1xU9F06TeDcuW8ZzKgm5swoJdrDHzQuOunf7Noi3+nVMCQKBgBzJ\nI/NgwSoCRI5fqKfVcSoRiyjLNjbHU/2AoyUmH6in+KpD0QMNudghzZM/nzfUO/os\nmR2ozkb1ZDnErHqdF/ZlI1ifZ/PpHjfBNJpMWKHVbx9puaKtXj7MghVn23vi/ldT\n1M3OoFe3PAhiPLtEJuoOV+xw4S1xg5H1M+SMvWTJAoGAEUNY20QQQZX1PNphPhoQ\nVhfn5pxio2teDvi5OJEgyW90vYKBJGtD/Pyke55Qk5AgcdK2miOTgJJKWBJ2/rgq\nkwx2xlEkUPvAmm5czHztOwEvSkbx9ma0i92lKYHDvdhik4hptOZjZ+BIjG9oCpb3\njIIGvXbtxXmkqRrZbDthc+A=\n-----END PRIVATE KEY-----\n'
const loopbackLookup = (_h: string, _o: { all?: boolean }, cb: (...a: unknown[]) => void) => cb(null, '127.0.0.1', 4)

test('abort destroys the in-flight crawl request and settles the promise NOW', async () => {
  // The safety property the post-finish budget relies on: after abort, no
  // uncancelled request keeps running behind the released slot.
  let closed = 0
  const server = https.createServer({ cert: CERT, key: KEY }, (req) => { req.socket.on('close', () => closed++) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const ctrl = new AbortController()
  const t0 = Date.now()
  const pending = rawGet(`https://127.0.0.1:${port}/`, 0, 10_000, loopbackLookup as never, ctrl.signal)
  setTimeout(() => ctrl.abort(), 150)
  const out = await Promise.race([pending, new Promise<string>((r) => setTimeout(() => r('NEVER-SETTLED'), 1500))])
  await new Promise((r) => setTimeout(r, 200)) // let the server observe the socket close
  server.close()
  assert.notEqual(out, 'NEVER-SETTLED', 'aborted request must settle, not hang')
  assert.equal(out, null)
  assert.ok(Date.now() - t0 < 1500, 'settled near the abort, not the 10s timeout')
  assert.ok(closed >= 1, 'server saw the client socket close - the request really was cancelled')
})

test('crawlJob stops starting new work once the post-processing deadline fires', async () => {
  const db = new Database(':memory:')
  migrateScan(db)
  const ctrl = new AbortController()
  let fetches = 0
  // Stub honors the abort the same way rawGet does (resolves null): the
  // property under test is crawlJob orchestration - the deadline stops the loop.
  const get = async () => {
    fetches++
    return await new Promise<null>((resolve) => {
      if (ctrl.signal.aborted) return resolve(null)
      ctrl.signal.addEventListener('abort', () => resolve(null), { once: true })
    })
  }
  setTimeout(() => ctrl.abort(), 150)
  const t0 = Date.now()
  await crawlJob(db, 'tenant1', 'job1', {
    get: get as never,
    signal: ctrl.signal,
    env: { SITECRAWL_ENABLED: '1' },
    leads: [
      { id: 'L1', company: 'Acme', source_url: 'https://a.example/x' },
      { id: 'L2', company: 'Beta', source_url: 'https://b.example/y' },
      { id: 'L3', company: 'Gamma', source_url: 'https://c.example/z' },
    ],
  })
  assert.ok(Date.now() - t0 < 2000, 'crawlJob settled near the deadline')
  assert.ok(fetches <= 2, `no new sites started after abort (fetches=${fetches})`)
})

test('abort survives a redirect: signal reaches the followed request (regression: recursion dropped it)', async () => {
  // /redirect 302s to /hang, which never responds. Pre-fix, the recursive
  // rawGet call dropped the signal, so the abort never reached the followed
  // request and the promise settled only at the request timeout (reviewer
  // measured 3021ms on a 3s timeout vs a 150ms abort).
  const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/hang' }); res.end(); return }
    // /hang: never respond
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const ctrl = new AbortController()
  const t0 = Date.now()
  const pending = rawGet(`https://127.0.0.1:${port}/redirect`, 0, 3_000, loopbackLookup as never, ctrl.signal)
  setTimeout(() => ctrl.abort(), 150)
  const out = await Promise.race([pending, new Promise<string>((r) => setTimeout(() => r('NEVER-SETTLED'), 2000))])
  server.close()
  assert.notEqual(out, 'NEVER-SETTLED', 'followed request must settle on abort')
  assert.equal(out, null)
  assert.ok(Date.now() - t0 < 2000, 'settled near the 150ms abort, not the 3s timeout')
})
