// #1102 own-site people: what the company's own site says about who runs it, read as it really is served.
//  - a server that sends a compressed body although identity was asked (seen on law-firm sites) is decoded, with the cap on DECODED bytes;
//  - a page that lands where an earlier one did is read once;
//  - for a city request, the firm's office page for that city is read (directly linked, or through its locations index), and its office
//    leader ("Office Managing Shareholder") is a person; a name linked to that person's own bio page counts;
//  - "Founder & CEO, <this company>" is the title "Founder & CEO"; another business's name after a title still refuses it.
// TEST-ONLY: invented firms and people; the HTTPS server is local (self-signed pair from sitecrawl-timeout.test.ts, not a credential).
import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { rawGet, crawlSite, extractPeople, contactPaths, officeLinks, type Get } from '../lib/connectors/sitecrawl.ts'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const CERT = '-----BEGIN CERTIFICATE-----\nMIIDCTCCAfGgAwIBAgIUIrE+q4IikyBeihVpuHz4dcfZiOcwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAyMjIyMDA1MVoXDTM2MTAx\nOTIyMDA1MVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEApDwb4fs8w2SDp0wHNStCYedXWe2bc73e7j08zVnXqYAJ\nXlbKKMVT7/r3T5nCABqfR972wLxUfRxSHm5itiOmR5nAfennmWC4lnwUsrLMZkKA\nqxTyzjA5KjQH+IOOKozfhcvf/1nt0+1ALZmgaaopXPUS358gBMazpifIZ42sXwQ7\nWRiSI38zxJs+VvtRyuCW+d6CXrp+ahpYfs4VaBAlATk9UNpQFXcLFiyr81RW1PR/\npq/l6TAfD3ZSDoZ8hAwC/5S3pQxGLb9+QdY6e94tnvz/9mSFyUdQTkdTAVC5Gfcr\nRk2pTBH1EedZ+K+mJBCBg8YIx5SFQe0v34/oSAGVCQIDAQABo1MwUTAdBgNVHQ4E\nFgQUAnHVAzhIygTjGfE2aPGBr5y1SiUwHwYDVR0jBBgwFoAUAnHVAzhIygTjGfE2\naPGBr5y1SiUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAP7ea\npj34Wj7CF00IiypBJPPchWkBPY0J6ecsLfhWjNq7vNR2LlcTyaY33rXHyrzdVfIY\ne+zMq7W7kbC43RXkwdO0wbcPsvocV0tQkfSCpvkvGkeEPfVk9SjhWDsRXsfWvBQp\noWDUixUrFkyqez8YIOb6GKV3pz/U2YyKn/2Nv6eyFqK7qdF377i6gzq9lxJoo/vR\nhxCHDs6s/dXFMO6nKQbeJ/yJSLAP44ZG5NFkR2LYof5b9fRN0hHlcRihFlJFLE5H\ncg7S1apaHiDdRIhTlG4T6nJ8MPi7s7tfpAANvzxChW3bvFfm6PNXXLK0zhy/M2rS\niQ4tLzy7CyUgMaaKVA==\n-----END CERTIFICATE-----\n'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCkPBvh+zzDZIOn\nTAc1K0Jh51dZ7Ztzvd7uPTzNWdepgAleVsooxVPv+vdPmcIAGp9H3vbAvFR9HFIe\nbmK2I6ZHmcB96eeZYLiWfBSyssxmQoCrFPLOMDkqNAf4g44qjN+Fy9//We3T7UAt\nmaBpqilc9RLfnyAExrOmJ8hnjaxfBDtZGJIjfzPEmz5W+1HK4Jb53oJeun5qGlh+\nzhVoECUBOT1Q2lAVdwsWLKvzVFbU9H+mr+XpMB8PdlIOhnyEDAL/lLelDEYtv35B\n1jp73i2e/P/2ZIXJR1BOR1MBULkZ9ytGTalMEfUR51n4r6YkEIGDxgjHlIVB7S/f\nj+hIAZUJAgMBAAECggEAPfSbBCX15zP84lixA2K9WRefgUI8eW4wMimRzVnOHJg7\ncIZHHxhJsOc48qNrZwSj/8XhyhWBvey4Idi8jj9mk+4xio55mwe8urA2Uq9WomEG\nDwQJELVqazxToXFnaS/ZhqzBZJ/1MxR2OH2S4SmbDwE4zHlH5+VZkh3B4Sa11uWz\nxfE97BDaQWyllkzSCEg1QTk4ZY5iY3z6no7lKFvoKA/1y9Zc7EKnJj1TWgr79hvJ\nuFpAIwfqvuXj24feUDpVVAqGVf4MyQoPrnSsHh63vzxg8mYGjVu39WNj04rSGJQV\novyp2hVqJksjDUgMinm+BvgrmBF1TU8Rfbql7hey/QKBgQDAd1Wrqz4HgoYX4LO+\nJwr8+pKdXfrbNvHi8X/QR8ZVRMcukTYYBzr8gfIb+5HgviyPJWxWh1b71DPjFzvA\n6q9VSwDERLDDn8qVIvRgcauBuBGaEc8rqqwZCCjwm7nuwqBHv2S8EmUOUeIZMyLS\noajfgZFMwMAndyMEqrxBJxHLhwKBgQDacwm9BuSxA2VmN3atTEW055w7AFOI4SJp\nMXbdDvbVa9KIurtP/+h1fuyVyzB68cP0ZZirwFL+kTpuiX5Ccp5HxQCGx+6MqOlg\n231vmw/0FdiKSB+ryIj1DeY1La1YxC+8PYsim0a9OwrHY6J9ehOhTBByF2gtIz8Q\nveQRkU9e7wKBgQCCkXKBH47ZMWce08WcfogpzyOftp30EXZPa142Qjr+pcYqhUCZ\nVG5j1xQUf7obKWi5Q74XhYExHmiE6sISwiNoTZWbkK4KSGD6g9gdhX/AZMssJmDR\nUtulr692a27b1xU9F06TeDcuW8ZzKgm5swoJdrDHzQuOunf7Noi3+nVMCQKBgBzJ\nI/NgwSoCRI5fqKfVcSoRiyjLNjbHU/2AoyUmH6in+KpD0QMNudghzZM/nzfUO/os\nmR2ozkb1ZDnErHqdF/ZlI1ifZ/PpHjfBNJpMWKHVbx9puaKtXj7MghVn23vi/ldT\n1M3OoFe3PAhiPLtEJuoOV+xw4S1xg5H1M+SMvWTJAoGAEUNY20QQQZX1PNphPhoQ\nVhfn5pxio2teDvi5OJEgyW90vYKBJGtD/Pyke55Qk5AgcdK2miOTgJJKWBJ2/rgq\nkwx2xlEkUPvAmm5czHztOwEvSkbx9ma0i92lKYHDvdhik4hptOZjZ+BIjG9oCpb3\njIIGvXbtxXmkqRrZbDthc+A=\n-----END PRIVATE KEY-----\n'
const loopbackLookup = (_h: string, _o: { all?: boolean }, cb: (...a: unknown[]) => void) => cb(null, '127.0.0.1', 4)
const PAGE = '<html><body><h1>Acme Law</h1><p>Acme Law advises employers on every matter of employment law across the country.</p></body></html>'

async function serve(handler: (path: string, res: import('node:http').ServerResponse) => void) {
  const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => handler(req.url ?? '/', res))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>(r => server.close(() => r())) }
}

test('a compressed body sent although identity was asked is decoded (gzip, deflate, br); a bomb stops at the decoded cap; an unknown encoding is an empty page', async () => {
  for (const [enc, pack] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]] as const) {
    const s = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': enc }); res.end(pack(Buffer.from(PAGE))) })
    try {
      const out = await rawGet(`https://127.0.0.1:${s.port}/`, 0, 3000, loopbackLookup as never)
      assert.equal(out?.body, PAGE, enc)
    } finally { await s.close() }
  }
  // 20 MB of spaces compresses to a few KB: the reader stops at its cap on the DECODED bytes
  const bomb = zlib.gzipSync(Buffer.alloc(20_000_000, 0x20))
  const s2 = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(bomb) })
  try { const out = await rawGet(`https://127.0.0.1:${s2.port}/`, 0, 5000, loopbackLookup as never); assert.ok(out && out.body.length <= 800_000, String(out?.body.length)) } finally { await s2.close() }
  const s3 = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'zstd' }); res.end('????') })
  try { assert.equal((await rawGet(`https://127.0.0.1:${s3.port}/`, 0, 3000, loopbackLookup as never))?.body, '') } finally { await s3.close() }
})

// A fake site for crawlSite: path -> html (a missing path is a 404); every fetched path is recorded.
function site(pages: Record<string, string>, redirects: Record<string, string> = {}) {
  const fetched: string[] = []
  const get: Get = async url => {
    const u = new URL(url); fetched.push(u.pathname)
    const to = redirects[u.pathname]
    const path = to ?? u.pathname
    const body = pages[path]
    return body === undefined ? { status: 404, body: '', finalUrl: url } : { status: 200, body, finalUrl: `${u.origin}${path}` }
  }
  return { get, fetched }
}
const prose = (s: string) => `<p>${s} We advise employers and businesses on employment law, litigation and workplace matters across many offices, with care and plain advice for every client.</p>`

test('a city request: the firm\'s office page is reached through its locations index and its office leader is kept; the bio link confirms the name', async () => {
  const s = site({
    '/robots.txt': '',
    '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/locations/">Locations</a><a href="/insights/blog-posts/contact-tracing-rules/">Contact tracing rules</a></body></html>`,
    '/locations/': `<html><body>${prose('Our offices.')}<a href="/locations/chicago">Chicago</a><a href="/locations/denver">Denver</a></body></html>`,
    '/locations/chicago': `<html><body><h1>Chicago</h1>${prose('Our Chicago office.')}<div><h5><a href="https://acme-law.example/people/dana-l-okoye">Dana L. Okoye</a></h5><div><span class="title">Office Managing Shareholder</span></div></div><div><h5><a href="/people/sam-lee-reyes">Sam Lee Reyes</a></h5><div><span>Associate</span></div></div></body></html>`,
    '/contact': `<html><body>${prose('Contact Acme Law.')}</body></html>`,
  })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner; Partner', 30_000, ['Chicago, Illinois'])
  const people = r.found.filter(f => f.kind === 'person').map(f => f.value)
  assert.deepEqual(people, ['Dana L. Okoye, Office Managing Shareholder'])
  assert.ok(s.fetched.indexOf('/locations/') < s.fetched.indexOf('/locations/chicago'), s.fetched.join(' '))
  assert.ok(!s.fetched.some(p => p.startsWith('/insights/')), 'a blog post whose URL contains "contact" is not read as the contact page')
  assert.ok(!s.fetched.includes('/locations/denver'), 'only the requested city')
  // no city requested: the office page is not sought
  const s2 = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/locations/">Locations</a></body></html>`, '/locations/': '<html><body><a href="/locations/chicago">Chicago</a></body></html>' })
  await crawlSite('acme-law.example', s2.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, [])
  assert.ok(!s2.fetched.includes('/locations/chicago'))
})

test('a linked name counts only when the link is that person\'s own bio page on this site', () => {
  const page = (href: string) => `<html><body>${prose('Our people.')}<h5><a href="${href}">Dana L. Okoye</a></h5><div>Managing Partner</div></body></html>`
  const kept = (href: string) => extractPeople(page(href), 'https://acme-law.example/people/', 'Managing Partner').map(f => f.value)
  assert.deepEqual(kept('/people/dana-l-okoye'), ['Dana L. Okoye, Managing Partner'])
  assert.deepEqual(kept('https://www.acme-law.example/people/dana-l-okoye.html'), ['Dana L. Okoye, Managing Partner'])
  for (const href of ['/people/', '/people/someone-else', 'https://other.example/people/dana-l-okoye', '/search?q=dana'])
    assert.deepEqual(kept(href), [], href)
})

test('"Founder & CEO, <this company>" is the title; another business after the title still refuses it', () => {
  const page = (title: string) => `<html><body>${prose('About us.')}<div>Dana Okoye</div><div>${title}</div></body></html>`
  const run = (title: string, company?: string) => extractPeople(page(title), 'https://pagewake.example/about/', 'Founder; CEO', company).map(f => f.value)
  assert.deepEqual(run('Founder &amp; CEO, Pagewake', 'Pagewake'), ['Dana Okoye, Founder & CEO'])
  assert.deepEqual(run('Founder & CEO at Pagewake Inc', 'Pagewake'), ['Dana Okoye, Founder & CEO'])
  assert.deepEqual(run('Founder & CEO, Northgate Capital', 'Pagewake'), [], 'another business')
  assert.deepEqual(run('Founder & CEO, Pagewake', undefined), [], 'no company known: unchanged rule')
})

test('a page that lands where an earlier one did is read once', async () => {
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Pagewake</h1>${prose('Pagewake.')}<a href="/contact/">Contact</a><a href="/about-us/">About</a></body></html>`, '/contact/': `<html><body>${prose('Contact.')}</body></html>`, '/about-us/': `<html><body>${prose('About.')}</body></html>` }, { '/contact': '/contact/' })
  const r = await crawlSite('pagewake.example', s.get, 0, 'Pagewake', false, undefined, undefined, '', 30_000)
  // '/contact' (a fixed path) lands on '/contact/'; the homepage's own '/contact/' link is then not fetched again
  assert.deepEqual(s.fetched.filter(p => p === '/contact' || p === '/contact/'), ['/contact'], s.fetched.join(' '))
  assert.ok(r.pages <= 3)
})

test('office links: only this site, only the requested city under a locations / offices path', () => {
  const base = new URL('https://acme-law.example/')
  const html = '<a href="/locations/chicago">a</a><a href="/firm-offices/chicago.html">b</a><a href="https://other.example/locations/chicago">c</a><a href="/news/chicago-expansion">d</a><a href="/locations/denver">e</a>'
  assert.deepEqual(officeLinks(html, base, ['Chicago, Illinois']), ['/locations/chicago', '/firm-offices/chicago.html'])
  assert.deepEqual(officeLinks(html, base, []), [])
  const cp = contactPaths('<a href="/blog/about-our-stats">x</a><a href="/about-us">y</a><a href="/en-us/our-people">z</a>', base)
  assert.equal(cp.includes('/blog/about-our-stats'), false); assert.ok(cp.includes('/about-us') && cp.includes('/en-us/our-people'), cp.join(' '))
})

test('a request whose caller is already aborted settles to null and never throws an uncaught error', async () => {
  const s = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
  try {
    const ac = new AbortController(); ac.abort()
    let uncaught: unknown = null
    const onUncaught = (e: unknown) => { uncaught = e }
    process.on('uncaughtException', onUncaught)
    try { assert.equal(await rawGet(`https://127.0.0.1:${s.port}/`, 0, 3000, loopbackLookup as never, ac.signal), null); await new Promise(r => setTimeout(r, 200)) }
    finally { process.off('uncaughtException', onUncaught) }
    assert.equal(uncaught, null)
  } finally { await s.close() }
})

test('a person on a blog post is not the company\'s person, even when "/contact" redirected there or the URL contains a people word', () => {
  const page = `<html><body>${prose('A post about rules.')}<div>Dana Okoye</div><div>Partner</div></body></html>`
  for (const url of ['https://acme-law.example/insights/blog-posts/contact-tracing-in-the-uk/', 'https://acme-law.example/blog/about-our-team-of-partners', 'https://acme-law.example/news/2026/10/meet-our-new-partner', 'https://acme-law.example/steam-cleaning-tips/', 'https://acme-law.example/our-meetup-recap'])
    assert.deepEqual(extractPeople(page, url, 'Partner').map(f => f.value), [], url)
  for (const url of ['https://acme-law.example/about-us/', 'https://acme-law.example/en-us/our-team', 'https://acme-law.example/locations/chicago', 'https://acme-law.example/people/'])
    assert.deepEqual(extractPeople(page, url, 'Partner').map(f => f.value), ['Dana Okoye, Partner'], url)
})
