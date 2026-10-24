// Partial-result honesty for the job-board adapter: an oversize or unparseable board is "partial", never a healthy "empty";
// a slow board after a finished one keeps the finished evidence and reports "partial"; a malformed HN entity never kills the adapter.
// Local fixtures only (loopback server for the byte-cap flag, stubbed HTTP otherwise). No live endpoint, no cap change.
import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { makeSafeGet } from '../lib/sources/http.ts'
import { collectEvidenceReport } from '../lib/sources/index.ts'
import { jobBoardsLimits, bodyQuote, hnBoards } from '../lib/sources/jobboards.ts'
import type { SafeGet } from '../lib/sources/types.ts'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const CERT = '-----BEGIN CERTIFICATE-----\nMIIDCTCCAfGgAwIBAgIUIrE+q4IikyBeihVpuHz4dcfZiOcwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAyMjIyMDA1MVoXDTM2MTAx\nOTIyMDA1MVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEApDwb4fs8w2SDp0wHNStCYedXWe2bc73e7j08zVnXqYAJ\nXlbKKMVT7/r3T5nCABqfR972wLxUfRxSHm5itiOmR5nAfennmWC4lnwUsrLMZkKA\nqxTyzjA5KjQH+IOOKozfhcvf/1nt0+1ALZmgaaopXPUS358gBMazpifIZ42sXwQ7\nWRiSI38zxJs+VvtRyuCW+d6CXrp+ahpYfs4VaBAlATk9UNpQFXcLFiyr81RW1PR/\npq/l6TAfD3ZSDoZ8hAwC/5S3pQxGLb9+QdY6e94tnvz/9mSFyUdQTkdTAVC5Gfcr\nRk2pTBH1EedZ+K+mJBCBg8YIx5SFQe0v34/oSAGVCQIDAQABo1MwUTAdBgNVHQ4E\nFgQUAnHVAzhIygTjGfE2aPGBr5y1SiUwHwYDVR0jBBgwFoAUAnHVAzhIygTjGfE2\naPGBr5y1SiUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAP7ea\npj34Wj7CF00IiypBJPPchWkBPY0J6ecsLfhWjNq7vNR2LlcTyaY33rXHyrzdVfIY\ne+zMq7W7kbC43RXkwdO0wbcPsvocV0tQkfSCpvkvGkeEPfVk9SjhWDsRXsfWvBQp\noWDUixUrFkyqez8YIOb6GKV3pz/U2YyKn/2Nv6eyFqK7qdF377i6gzq9lxJoo/vR\nhxCHDs6s/dXFMO6nKQbeJ/yJSLAP44ZG5NFkR2LYof5b9fRN0hHlcRihFlJFLE5H\ncg7S1apaHiDdRIhTlG4T6nJ8MPi7s7tfpAANvzxChW3bvFfm6PNXXLK0zhy/M2rS\niQ4tLzy7CyUgMaaKVA==\n-----END CERTIFICATE-----\n'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCkPBvh+zzDZIOn\nTAc1K0Jh51dZ7Ztzvd7uPTzNWdepgAleVsooxVPv+vdPmcIAGp9H3vbAvFR9HFIe\nbmK2I6ZHmcB96eeZYLiWfBSyssxmQoCrFPLOMDkqNAf4g44qjN+Fy9//We3T7UAt\nmaBpqilc9RLfnyAExrOmJ8hnjaxfBDtZGJIjfzPEmz5W+1HK4Jb53oJeun5qGlh+\nzhVoECUBOT1Q2lAVdwsWLKvzVFbU9H+mr+XpMB8PdlIOhnyEDAL/lLelDEYtv35B\n1jp73i2e/P/2ZIXJR1BOR1MBULkZ9ytGTalMEfUR51n4r6YkEIGDxgjHlIVB7S/f\nj+hIAZUJAgMBAAECggEAPfSbBCX15zP84lixA2K9WRefgUI8eW4wMimRzVnOHJg7\ncIZHHxhJsOc48qNrZwSj/8XhyhWBvey4Idi8jj9mk+4xio55mwe8urA2Uq9WomEG\nDwQJELVqazxToXFnaS/ZhqzBZJ/1MxR2OH2S4SmbDwE4zHlH5+VZkh3B4Sa11uWz\nxfE97BDaQWyllkzSCEg1QTk4ZY5iY3z6no7lKFvoKA/1y9Zc7EKnJj1TWgr79hvJ\nuFpAIwfqvuXj24feUDpVVAqGVf4MyQoPrnSsHh63vzxg8mYGjVu39WNj04rSGJQV\novyp2hVqJksjDUgMinm+BvgrmBF1TU8Rfbql7hey/QKBgQDAd1Wrqz4HgoYX4LO+\nJwr8+pKdXfrbNvHi8X/QR8ZVRMcukTYYBzr8gfIb+5HgviyPJWxWh1b71DPjFzvA\n6q9VSwDERLDDn8qVIvRgcauBuBGaEc8rqqwZCCjwm7nuwqBHv2S8EmUOUeIZMyLS\noajfgZFMwMAndyMEqrxBJxHLhwKBgQDacwm9BuSxA2VmN3atTEW055w7AFOI4SJp\nMXbdDvbVa9KIurtP/+h1fuyVyzB68cP0ZZirwFL+kTpuiX5Ccp5HxQCGx+6MqOlg\n231vmw/0FdiKSB+ryIj1DeY1La1YxC+8PYsim0a9OwrHY6J9ehOhTBByF2gtIz8Q\nveQRkU9e7wKBgQCCkXKBH47ZMWce08WcfogpzyOftp30EXZPa142Qjr+pcYqhUCZ\nVG5j1xQUf7obKWi5Q74XhYExHmiE6sISwiNoTZWbkK4KSGD6g9gdhX/AZMssJmDR\nUtulr692a27b1xU9F06TeDcuW8ZzKgm5swoJdrDHzQuOunf7Noi3+nVMCQKBgBzJ\nI/NgwSoCRI5fqKfVcSoRiyjLNjbHU/2AoyUmH6in+KpD0QMNudghzZM/nzfUO/os\nmR2ozkb1ZDnErHqdF/ZlI1ifZ/PpHjfBNJpMWKHVbx9puaKtXj7MghVn23vi/ldT\n1M3OoFe3PAhiPLtEJuoOV+xw4S1xg5H1M+SMvWTJAoGAEUNY20QQQZX1PNphPhoQ\nVhfn5pxio2teDvi5OJEgyW90vYKBJGtD/Pyke55Qk5AgcdK2miOTgJJKWBJ2/rgq\nkwx2xlEkUPvAmm5czHztOwEvSkbx9ma0i92lKYHDvdhik4hptOZjZ+BIjG9oCpb3\njIIGvXbtxXmkqRrZbDthc+A=\n-----END PRIVATE KEY-----\n'
const loopback = (_h: string, _o: { all?: boolean }, cb: (...a: unknown[]) => void) => cb(null, '127.0.0.1', 4)
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const sel = (feeds: string[]) => ({ adapters: ['jobboards'], feeds, pages: [] })
const Q = 'ohio hiring generalist'
const BODY = 'Zed Corp is hiring an HR generalist to run onboarding for its Cleveland office.'
const okJob = (n: number) => ({ title: 'HR Generalist', location: 'Cleveland, OH', isListed: true, descriptionPlain: BODY, publishedAt: day(4), jobUrl: `https://jobs.ashbyhq.com/zed/${n}` })
// Hacker News answers an empty thread list so only the board behavior under test is measured.
const withHn = (h: SafeGet): SafeGet => async (url, o) => url.startsWith('https://hn.algolia.com/') ? { status: 200, body: JSON.stringify({ hits: [] }) } : h(url, o)
const ashby = (token: string) => `https://api.ashbyhq.com/posting-api/job-board/${token}`

test('the byte-capped HTTP read says it was cut (flag only, cap unchanged)', async () => {
  const server = https.createServer({ cert: CERT, key: KEY }, (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('y'.repeat(3_000_000)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const r = await makeSafeGet(5000, loopback as never, true)(`https://127.0.0.1:${(server.address() as AddressInfo).port}/`)
  server.close()
  assert.equal(r?.status, 200); assert.ok(r!.body.length < 3_000_000)
  assert.equal(r!.truncated, true)
})

test('an oversize (cut) board is reported partial with an oversize note, a genuinely empty board stays empty with no notes', async () => {
  const big = JSON.stringify({ jobs: Array.from({ length: 3000 }, (_, i) => okJob(i)) })
  const cut: SafeGet = async () => ({ status: 200, body: big.slice(0, 990_000), truncated: true })
  const r1 = await collectEvidenceReport(sel(['https://jobs.ashbyhq.com/zed']), Q, withHn(cut), 5000)
  assert.equal(r1.runs[0].status, 'partial'); assert.equal(r1.runs[0].evidence, 0); assert.deepEqual(r1.runs[0].notes, { oversize: 1 })
  const empty: SafeGet = async () => ({ status: 200, body: JSON.stringify({ jobs: [] }) })
  const r2 = await collectEvidenceReport(sel(['https://jobs.ashbyhq.com/zed']), Q, withHn(empty), 5000)
  assert.equal(r2.runs[0].status, 'empty'); assert.equal(r2.runs[0].notes, undefined)
})

test('a 200 that is not JSON, or a network failure, is partial (unparseable / unreachable), a plain 404 board is not', async () => {
  const bad: SafeGet = async () => ({ status: 200, body: '<html>nope</html>' })
  assert.deepEqual((await collectEvidenceReport(sel(['https://jobs.ashbyhq.com/zed']), Q, withHn(bad), 5000)).runs[0].notes, { unparseable: 1 })
  const down: SafeGet = async () => null
  assert.deepEqual((await collectEvidenceReport(sel(['https://jobs.ashbyhq.com/zed']), Q, withHn(down), 5000)).runs[0].notes, { unreachable: 1 })
  const gone: SafeGet = async () => ({ status: 404, body: '' })
  const r = await collectEvidenceReport(sel(['https://jobs.ashbyhq.com/zed']), Q, withHn(gone), 5000)
  assert.equal(r.runs[0].status, 'empty')
})

test('a slow board after a finished board: the finished evidence is kept, later boards are not started, status is partial with a budget note', async () => {
  const saved = jobBoardsLimits.budgetMs; jobBoardsLimits.budgetMs = 50
  try {
    const seen: string[] = []
    const http: SafeGet = async url => {
      seen.push(url)
      if (url === ashby('fast')) return { status: 200, body: JSON.stringify({ jobs: [okJob(1)] }) }
      await new Promise(r => setTimeout(r, 80)) // the slow board answers after the budget
      return { status: 200, body: JSON.stringify({ jobs: [] }) }
    }
    const r = await collectEvidenceReport(sel(['https://jobs.ashbyhq.com/fast', 'https://jobs.ashbyhq.com/slow', 'https://jobs.ashbyhq.com/later']), Q, withHn(http), 5000)
    assert.deepEqual(r.items.map(i => i.url), ['https://jobs.ashbyhq.com/zed/1'])
    assert.equal(r.runs[0].status, 'partial'); assert.equal(r.runs[0].evidence, 1); assert.deepEqual(r.runs[0].notes, { budget: 1 })
    assert.ok(!seen.includes(ashby('later')))
  } finally { jobBoardsLimits.budgetMs = saved }
})

test('the budget leaves room under the 25 s adapter deadline: budget plus one 10 s request is below it', () => {
  assert.ok(jobBoardsLimits.budgetMs + 10_000 < 25_000)
})

test('a malformed numeric entity in an HN comment is skipped, boards from the other comments are still found', async () => {
  const now = new Date()
  const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][now.getUTCMonth()]
  const http: SafeGet = async url => {
    const u = new URL(url); const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (u.pathname === '/api/v1/search_by_date') return j({ hits: [{ objectID: '500', title: `Ask HN: Who is hiring? (${M} ${now.getUTCFullYear()})`, created_at_i: Math.floor(now.getTime() / 1000) }] })
    if (u.pathname === '/api/v1/search') return u.searchParams.get('page') === '0' ? j({ hits: [
      { objectID: 'a', parent_id: 500, comment_text: 'Bad | Ohio | &#xFFFFFFFF; &#99999999999; https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;badone' },
      { objectID: 'b', parent_id: 500, comment_text: 'Good | Columbus, Ohio | https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;goodone' },
    ] }) : j({ hits: [] })
    return null
  }
  const boards = await hnBoards(http, 'Ohio')
  assert.ok(boards.includes('https://boards.greenhouse.io/goodone'), JSON.stringify(boards))
})

test('quote: the first real paragraph of the posting body, not headings joined to it (real Greenhouse shape, escaped HTML)', () => {
  const content = '&lt;h2&gt;&lt;strong&gt;Who we are &lt;/strong&gt;&lt;/h2&gt;\n&lt;h3&gt;&lt;strong&gt;About Stripe&lt;/strong&gt;&lt;/h3&gt;\n&lt;p&gt;&lt;span style=&quot;font-weight: 400;&quot;&gt;Stripe is a financial infrastructure platform for businesses. Millions of companies use Stripe.&lt;/span&gt;&lt;/p&gt;'
  assert.equal(bodyQuote(content), 'Stripe is a financial infrastructure platform for businesses.')
  assert.equal(bodyQuote('&lt;p&gt;Stripe&amp;#39;s mission &amp;amp; vision matter to every team we hire.&lt;/p&gt;'), "Stripe's mission & vision matter to every team we hire.")
})

test('quote: Ashby plain text takes the first paragraph with real length, skipping a short heading line', () => {
  assert.equal(bodyQuote('ABOUT RAMP\n\nRamp is building the smart infrastructure for finance teams. We automate spend.'), 'Ramp is building the smart infrastructure for finance teams.')
})

test('a page fetch that never answers cannot stall the adapter: it is cut at the per-page limit, the API paragraph is kept and the run is partial', async () => {
  const saved = jobBoardsLimits.pageMs; jobBoardsLimits.pageMs = 40
  try {
    const http: SafeGet = async url => url.startsWith('https://hn.algolia.com/') ? { status: 200, body: '{"hits":[]}' } : { status: 200, body: JSON.stringify({ jobs: [okJob(1), okJob(2)] }) }
    const hang = () => new Promise<string | null>(() => {}) // never settles
    const t0 = Date.now()
    const r = await collectEvidenceReport(sel(['https://jobs.ashbyhq.com/zed']), Q, http, 5000, [], hang)
    assert.ok(Date.now() - t0 < 1000, 'returned long before the 5 s deadline')
    assert.equal(r.runs[0].status, 'partial')
    assert.equal(r.runs[0].notes?.page_unreachable, 2)
    assert.equal(r.items.length, 2)
  } finally { jobBoardsLimits.pageMs = saved }
})

test('worst case adapter time is under the 25 s deadline: start budget + per-page limit', () => {
  assert.ok(jobBoardsLimits.budgetMs + jobBoardsLimits.pageMs < 25_000)
})
