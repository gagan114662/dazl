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
import { rawGet, crawlSite, extractPeople, contactPaths, officeLinks, otherOffice, type Get } from '../lib/connectors/sitecrawl.ts'

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
  try { const out = await rawGet(`https://127.0.0.1:${s2.port}/`, 0, 5000, loopbackLookup as never); assert.ok(out && out.body === ' '.repeat(800_000), String(out?.body.length)) /* decoded (spaces), cut at the decoded cap */ } finally { await s2.close() }
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

// Review fixes (council at e99b7747): R1 bio links, R2 other offices, R3 one city + the office page's own place, R4 whole segments,
// R5 this company only, R6 a mislabelled plain body.
test('R1: a bio link counts only under a people directory, never under testimonials, case studies, blog authors or a portfolio', () => {
  const page = (href: string) => `<html><body>${prose('Our people.')}<h5><a href="${href}">Dana L. Okoye</a></h5><div>Managing Partner</div></body></html>`
  const kept = (href: string) => extractPeople(page(href), 'https://acme-law.example/our-team/', 'Managing Partner').map(f => f.value)
  for (const href of ['/people/dana-l-okoye', '/our-team/dana-l-okoye', '/attorneys/dana-l-okoye/', '/en-us/professionals/dana-l-okoye.html'])
    assert.deepEqual(kept(href), ['Dana L. Okoye, Managing Partner'], href)
  for (const href of ['/testimonials/dana-l-okoye', '/case-studies/dana-l-okoye', '/blog/author/dana-l-okoye', '/portfolio/dana-l-okoye', '/dana-l-okoye', '/news/people/dana-l-okoye', '/client-reviews/team/dana-l-okoye'])
    assert.deepEqual(kept(href), [], href)
})

test('R2: another city\'s office page is never read nor its people kept; with no city requested no office page is read', async () => {
  const office = (city: string, who: string) => `<html><body><h1>${city}</h1>${prose(`Our ${city} office.`)}<div>${who}</div><div>Office Managing Partner</div></body></html>`
  const pages = {
    '/robots.txt': '',
    '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/locations/denver">Denver</a><a href="/locations/boston">Boston</a><a href="/offices/denver/team">Denver team</a></body></html>`,
    '/locations/denver': office('Denver', 'Rae Mendel'), '/locations/boston': office('Boston', 'Ola Brandt'), '/offices/denver/team': office('Denver', 'Ivo Grant'),
  }
  for (const where of [['Chicago, Illinois'], []]) {
    const s = site(pages)
    const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, where)
    assert.ok(!s.fetched.some(p => /denver|boston/.test(p)), `${where}: ${s.fetched.join(' ')}`)
    assert.deepEqual(r.found.filter(f => f.kind === 'person'), [], String(where))
  }
  // a redirect onto another city's office page keeps nobody from it
  const s = site(pages, { '/contact': '/locations/denver' })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Chicago, Illinois'])
  assert.deepEqual(r.found.filter(f => f.kind === 'person'), [])
  assert.deepEqual(contactPaths(pages['/'], new URL('https://acme-law.example/'), ['Chicago, Illinois']).filter(p => /denver|boston/.test(p)), [])
})

test('R3: several requested cities seek no office page; an office page in a same-name place elsewhere keeps nobody', async () => {
  const home = `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/locations/chicago">Chicago</a><a href="/locations/paris">Paris</a></body></html>`
  assert.deepEqual(officeLinks(home, new URL('https://acme-law.example/'), ['Chicago, Illinois', 'Denver, Colorado']), [])
  const s = site({ '/robots.txt': '', '/': home, '/locations/paris': `<html><body><h1>Paris</h1>${prose('Our office at 8 Rue de Rivoli, 75001 Paris, France.')}<div>Rae Mendel</div><div>Office Managing Partner</div></body></html>` })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Paris, Texas'])
  assert.ok(s.fetched.includes('/locations/paris'), s.fetched.join(' '))
  assert.deepEqual(r.found.filter(f => f.kind === 'person'), [], 'Paris, France is not Paris, Texas')
})

test('R4: a people or contact page is a WHOLE segment (joined forms and a container allowed); a post that starts with the word is not', () => {
  const page = `<html><body>${prose('Who we are.')}<div>Dana Okoye</div><div>Partner</div></body></html>`
  for (const p of ['/aboutus', '/AboutUs.aspx', '/about_us/', '/contactus', '/firm/our-people', '/company/leadership', '/about/team', '/meet-the-team'])
    assert.deepEqual(extractPeople(page, `https://acme-law.example${p}`, 'Partner').map(f => f.value), ['Dana Okoye, Partner'], p)
  for (const p of ['/contact-tracing-guide', '/about-the-case-of-x', '/company-news/new-ceo-joins', '/teamwork-tips', '/firm/news/partner-joins'])
    assert.deepEqual(extractPeople(page, `https://acme-law.example${p}`, 'Partner').map(f => f.value), [], p)
  const cp = contactPaths(['/contact-tracing-guide', '/about-the-case-of-x', '/company-news/new-ceo-joins', '/aboutus', '/firm/our-people'].map(h => `<a href="${h}">x</a>`).join(''), new URL('https://acme-law.example/'))
  assert.ok(cp.includes('/aboutus') && cp.includes('/firm/our-people'), cp.join(' '))
  assert.ok(!cp.some(p => /tracing|case-of|company-news/.test(p)), cp.join(' '))
})

test('R5: the company after a title must be THIS company: a legal suffix may differ, a group / other name may not', () => {
  const page = (title: string) => `<html><body>${prose('About us.')}<div>Dana Okoye</div><div>${title}</div></body></html>`
  const run = (title: string, company: string) => extractPeople(page(title), 'https://acme.example/about/', 'CEO', company).map(f => f.value)
  assert.deepEqual(run('CEO, Acme LLC', 'Acme'), ['Dana Okoye, CEO'])
  assert.deepEqual(run('CEO, Acme', 'Acme Inc.'), ['Dana Okoye, CEO'])
  assert.deepEqual(run('CEO, Acme Group', 'Acme'), [], 'Acme Group is another business')
  assert.deepEqual(run('CEO, Acme Holdings', 'Acme'), [])
})

test('R6: a body labelled gzip but sent as plain HTML is read as the page; a corrupt real gzip body is still no page', async () => {
  const s = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(PAGE) })
  try { assert.equal((await rawGet(`https://127.0.0.1:${s.port}/`, 0, 3000, loopbackLookup as never))?.body, PAGE) } finally { await s.close() }
  const bad = Buffer.concat([zlib.gzipSync(Buffer.from(PAGE)).subarray(0, 10), Buffer.from('garbage-not-deflate')])
  const s2 = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(bad) })
  try { assert.equal(await rawGet(`https://127.0.0.1:${s2.port}/`, 0, 3000, loopbackLookup as never), null) } finally { await s2.close() }
})

// Council round 2 (at ff5c0ef5): recall on team / firm page names, office slugs with a state and sub-pages, no contacts from another
// city's office, and the decoder's edge cases (a truncated stream, a large mislabelled body).
test('round 2: "-team" and "the-firm" pages are people pages; "chicago-il" and "/locations/chicago/team" are the Chicago office', () => {
  const page = `<html><body>${prose('Who we are.')}<div>Dana Okoye</div><div>Partner</div></body></html>`
  const links = ['/leadership-team', '/management-team', '/the-team', '/team-members', '/about-the-firm', '/the-firm', '/our-leadership-team', '/executive-team']
  for (const p of links) assert.deepEqual(extractPeople(page, `https://acme-law.example${p}`, 'Partner').map(f => f.value), ['Dana Okoye, Partner'], p)
  const cp = contactPaths(links.map(h => `<a href="${h}">x</a>`).join(''), new URL('https://acme-law.example/'))
  assert.ok(['/leadership-team', '/management-team', '/the-team'].every(p => cp.includes(p)), cp.join(' '))
  assert.deepEqual(officeLinks('<a href="/locations/chicago-il">a</a><a href="/locations/chicago-heights">b</a>', new URL('https://acme-law.example/'), ['Chicago, Illinois']), ['/locations/chicago-il'])
  assert.equal(otherOffice('/locations/chicago/team', ['Chicago, Illinois']), false)
  assert.equal(otherOffice('/locations/offices/chicago.html', ['Chicago, Illinois']), false)
  assert.equal(otherOffice('/locations/denver/team', ['Chicago, Illinois']), true)
  assert.equal(otherOffice('/locations/chicago-heights', ['Chicago, Illinois']), true)
})

test('round 2: a redirect onto another city\'s office keeps neither its people nor its email', async () => {
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}</body></html>`, '/locations/denver': `<html><body><h1>Denver</h1>${prose('Our Denver office.')}<a href="mailto:denver@acme-law.example">denver@acme-law.example</a><div>Rae Mendel</div><div>Office Managing Partner</div></body></html>` }, { '/contact': '/locations/denver' })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Chicago, Illinois'])
  assert.ok(s.fetched.includes('/contact'))
  assert.deepEqual(r.found.filter(f => /denver|Mendel/i.test(f.value)), [])
})

test('round 2: a truncated gzip stream keeps what decoded; a large mislabelled plain body is capped and keeps its text', async () => {
  const gz = zlib.gzipSync(Buffer.from(PAGE + ' '.repeat(5000) + '<p>tail</p>'))
  const s = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(gz.subarray(0, gz.length - 8)) })
  try { assert.ok((await rawGet(`https://127.0.0.1:${s.port}/`, 0, 3000, loopbackLookup as never))?.body.startsWith(PAGE)) } finally { await s.close() }
  const big = '<html><body>' + '<p>Acme Law advises employers.</p>'.repeat(60_000) + '</body></html>'   // about 2 MB
  const s2 = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(big) })
  try {
    const out = await rawGet(`https://127.0.0.1:${s2.port}/`, 0, 5000, loopbackLookup as never)
    assert.ok(out && out.body.length === 800_000, String(out?.body.length)); assert.ok(out.text && out.text.length > 0)
  } finally { await s2.close() }
})

test('round 2 (opus): posts under a people-word first segment are posts; a generic "our-office" page is a people page; more title tails', async () => {
  const page = `<html><body>${prose('Who we are.')}<div>Dana Okoye</div><div>Partner</div></body></html>`
  for (const p of ['/company/blog/guest-post-by-a-partner', '/about/news/2026/new-partner', '/contact/blog/x', '/team/blog/x', '/about/press-releases/new-partner'])
    assert.deepEqual(extractPeople(page, `https://acme-law.example${p}`, 'Partner').map(f => f.value), [], p)
  for (const p of ['/staff-directory', '/meet-the-founder', '/our-team/dr-andrew-newsome', '/about-the-practice'])
    assert.deepEqual(extractPeople(page, `https://acme-law.example${p}`, 'Partner').map(f => f.value), ['Dana Okoye, Partner'], p)
  assert.ok(!contactPaths('<a href="/company/blog/new-ceo">x</a>', new URL('https://acme-law.example/')).includes('/company/blog/new-ceo'))
  // a dental practice's "/about-us/our-office" keeps its owner, with or without a requested city
  const dental = { '/robots.txt': '', '/': `<html><body><h1>Smile Dental</h1>${prose('Smile Dental.')}<a href="/about-us/our-office">Our office</a></body></html>`, '/about-us/our-office': `<html><body>${prose('Our office.')}<div>Dana Okoye</div><div>Owner</div></body></html>` }
  for (const where of [[], ['Austin, Texas']]) {
    const s = site(dental)
    const r = await crawlSite('smile-dental.example', s.get, 0, 'Smile Dental', false, undefined, undefined, 'Owner', 30_000, where)
    assert.deepEqual(r.found.filter(f => f.kind === 'person').map(f => f.value), ['Dana Okoye, Owner'], String(where))
  }
  // the requested office's sub-page and an .aspx office page are that office
  assert.equal(otherOffice('/locations/chicago/attorneys', ['Chicago, Illinois']), false)
  assert.equal(otherOffice('/locations/chicago.aspx', ['Chicago, Illinois']), false)
  const tail = (title: string) => extractPeople(`<html><body>${prose('About us.')}<div>Dana Okoye</div><div>${title}</div></body></html>`, 'https://acme.example/about/', 'Head of Sales; Director', 'Acme').map(f => f.value)
  assert.deepEqual(tail('Head of Sales at Acme'), ['Dana Okoye, Head of Sales'])
  assert.deepEqual(tail('Director of Operations at Acme'), ['Dana Okoye, Director of Operations'])
  assert.deepEqual(tail('Head of Sales at Acme Group'), [])
})

test('round 2 (opus): an unknown content-encoding label on plain HTML is read; on non-HTML bytes it is an empty page', async () => {
  for (const [enc, body, want] of [['utf-8', PAGE, PAGE], ['none', PAGE, PAGE], ['zstd', '\x28\xb5\x2f\xfd????', '']] as const) {
    const s = await serve((_p, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': enc }); res.end(body) })
    try { assert.equal((await rawGet(`https://127.0.0.1:${s.port}/`, 0, 3000, loopbackLookup as never))?.body, want, enc) } finally { await s.close() }
  }
})

test('a menu heading over a service link is not a person (run G: "Serving Australia-wide, Digital Marketing Consultant Melbourne")', () => {
  const menu = `<html><body>${prose('Contact us.')}<h3 class="ss-mm-head">Serving Australia-wide</h3><ul><li><a href="/digital-marketing-consultant-melbourne/"><span>Digital Marketing Consultant Melbourne</span></a></li></ul></body></html>`
  assert.deepEqual(extractPeople(menu, 'https://agency.example/contact-us/', 'Founder; Digital Marketing Consultant', 'Agency').map(f => f.value), [])
  const real = `<html><body>${prose('About us.')}<div>Dana Okoye-Reyes</div><div>Digital Marketing Consultant</div><div>Award-winning Team</div><div>Founder</div></body></html>`
  assert.deepEqual(extractPeople(real, 'https://agency.example/about-us/', 'Founder; Digital Marketing Consultant', 'Agency').map(f => f.value), ['Dana Okoye-Reyes, Digital Marketing Consultant'])
})

test('round 2 (haiku): another city\'s office reached by redirect is not even handed to onPage; a prefixed office segment is a people page; Paris twice is two places', async () => {
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}</body></html>`, '/locations/denver': `<html><body><h1>Denver</h1>${prose('Our Denver office.')}<div>Rae Mendel</div><div>Office Managing Partner</div></body></html>` }, { '/contact': '/locations/denver' })
  const seen: string[] = []
  await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, (_h, url) => { seen.push(url) }, 'Managing Partner', 30_000, ['Chicago, Illinois'])
  assert.ok(s.fetched.includes('/contact'), s.fetched.join(' ')); assert.ok(!seen.some(u => /denver/.test(u)), seen.join(' '))
  const page = `<html><body>${prose('Our Chicago office.')}<div>Dana Okoye</div><div>Office Managing Partner</div></body></html>`
  assert.deepEqual(extractPeople(page, 'https://acme-law.example/firm-offices/chicago.html', 'Office Managing Partner').map(f => f.value), ['Dana Okoye, Office Managing Partner'])
  assert.deepEqual(officeLinks('<a href="/locations/paris">p</a>', new URL('https://acme-law.example/'), ['Paris, Texas', 'Paris, France']), [])
  assert.deepEqual(officeLinks('<a href="/locations/paris">p</a>', new URL('https://acme-law.example/'), ['Paris, Texas']), ['/locations/paris'])
})

test('round 3: a corrupt compressed body that never ends is dropped AND its connection closed (no read past the call)', async () => {
  let closed = false
  const head = zlib.gzipSync(Buffer.from(PAGE)).subarray(0, 10)
  const s = await serve((_p, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.write(Buffer.concat([head, Buffer.from('garbage-not-deflate')]))
    const t = setInterval(() => res.write(Buffer.alloc(1000, 0x41)), 50); res.on('close', () => { closed = true; clearInterval(t) })
  })
  try {
    assert.equal(await rawGet(`https://127.0.0.1:${s.port}/`, 0, 5000, loopbackLookup as never), null)
    const until = Date.now() + 3000; while (!closed && Date.now() < until) await new Promise(r => setTimeout(r, 25))
    assert.equal(closed, true, 'the server saw the connection close')
  } finally { await s.close() }
})

test('round 3 (opus/haiku): a requested-city office page placed elsewhere gives nothing; a state suffix must be the requested state; /partners/ is not a bio directory', async () => {
  const home = `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/locations/paris">Paris</a></body></html>`
  const paris = `<html><body><h1>Paris</h1>${prose('Our office at 8 Rue de Rivoli, 75001 Paris, France.')}<a href="mailto:info@acme-law.example">info@acme-law.example</a><a href="tel:+33142000000">+33 1 42 00 00 00</a><div>Rae Mendel</div><div>Office Managing Partner</div></body></html>`
  const s = site({ '/robots.txt': '', '/': home, '/locations/paris': paris })
  const seen: string[] = []
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, (_h, url) => { seen.push(url) }, 'Managing Partner', 30_000, ['Paris, Texas'])
  assert.ok(s.fetched.includes('/locations/paris'))
  assert.deepEqual(r.found.filter(f => /acme-law\.example|33142|Mendel/.test(f.value)), [], JSON.stringify(r.found))
  assert.ok(!seen.some(u => u.endsWith('/locations/paris')), seen.join(' '))
  const base = new URL('https://acme-law.example/')
  assert.deepEqual(officeLinks('<a href="/offices/portland-or">a</a>', base, ['Portland, Maine']), [])
  assert.deepEqual(officeLinks('<a href="/offices/portland-me">a</a><a href="/offices/portland">b</a>', base, ['Portland, Maine']), ['/offices/portland-me', '/offices/portland'])
  assert.deepEqual(officeLinks('<a href="/locations/paris-fr">a</a>', base, ['Paris, Texas']), [])
  assert.equal(otherOffice('/offices/leadership', []), false)
  const biz = `<html><body>${prose('About us.')}<div><a href="/partners/bright-labs">Bright Labs</a></div><div>Director</div></body></html>`
  assert.deepEqual(extractPeople(biz, 'https://acme.example/about/', 'Director').map(f => f.value), [])
})

test('round 4 (opus): another city under a people segment is still another office; the requested state may come with a country or ZIP', async () => {
  assert.equal(otherOffice('/offices/team/dallas', ['Chicago, IL']), true)
  assert.equal(otherOffice('/locations/people/dallas-tx', ['Chicago, IL']), true)
  assert.equal(otherOffice('/offices/team/chicago', ['Chicago, IL']), false)
  assert.equal(otherOffice('/offices/leadership', ['Chicago, IL']), false)
  const dallas = `<html><body><h1>Dallas</h1>${prose('Our office at 2200 Ross Ave, Dallas, TX 75201.')}<div>Rae Mendel</div><div>Managing Partner</div></body></html>`
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}</body></html>`, '/offices/team/dallas': dallas }, { '/team': '/offices/team/dallas' })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Chicago, IL'])
  assert.deepEqual(r.found.filter(f => /Mendel/.test(f.value)), [])
  const base = new URL('https://acme-law.example/')
  for (const where of [['Chicago, IL, USA'], ['Chicago, IL 60601'], ['Chicago, Illinois']]) assert.deepEqual(officeLinks('<a href="/offices/chicago-il">a</a>', base, where), ['/offices/chicago-il'], String(where))
})

test('round 4 (haiku): an office page that does not say where it is keeps its phone (not its people); region from any part; a bare city takes any state suffix', async () => {
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/locations/chicago">Chicago</a></body></html>`, '/locations/chicago': `<html><body>${prose('Our office. Visit us today.')}<a href="tel:+13125550100">312 555 0100</a><div>Rae Mendel</div><div>Office Managing Partner</div></body></html>` })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Chicago, IL'])
  assert.ok(r.found.some(f => f.kind === 'phone' && /3125550100|312 555 0100/.test(f.value)), JSON.stringify(r.found))
  assert.deepEqual(r.found.filter(f => f.kind === 'person'), [])
  const base = new URL('https://acme-law.example/')
  assert.deepEqual(officeLinks('<a href="/offices/portland-or">a</a>', base, ['Portland, OR, USA']), ['/offices/portland-or'])
  assert.deepEqual(officeLinks('<a href="/offices/chicago-il">a</a>', base, ['Chicago, IL, US']), ['/offices/chicago-il'])
  assert.deepEqual(officeLinks('<a href="/locations/chicago-il">a</a>', base, ['Chicago']), ['/locations/chicago-il'])
  assert.deepEqual(officeLinks('<a href="/offices/portland-or">a</a>', base, ['Portland, Maine, USA']), [])
})

test('round 5 (sonnet): a region this reader does not know is not "no region"; the office is the first non-people segment', () => {
  assert.equal(otherOffice('/offices/paris-tx', ['Paris, France']), true)
  assert.equal(otherOffice('/offices/paris', ['Paris, France']), false)
  assert.equal(otherOffice('/offices/chicago-il', ['Chicago']), false)
  assert.equal(otherOffice('/offices/team/dallas-tx', ['Dallas, TX']), false)
})

test('round 5 (opus/haiku): a city nested under a region is judged by its page; unknown regions and ZIP-before-country forms fail closed', async () => {
  const texas = `<html><body><h1>Paris, Texas</h1>${prose('Our office at 100 Main St, Paris, Texas 75460.')}<a href="tel:+19035550100">903 555 0100</a><div>Rae Mendel</div><div>Managing Partner</div></body></html>`
  for (const path of ['/locations/texas/paris', '/offices/team/paris']) {
    const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}</body></html>`, [path]: texas }, { '/team': path })
    const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Paris, France'])
    assert.deepEqual(r.found.filter(f => f.kind === 'person'), [], path)
  }
  const chicago = `<html><body><h1>Chicago</h1>${prose('Our office at 155 N Wacker Dr, Chicago, IL 60606.')}<div>Dana Okoye</div><div>Office Managing Partner</div></body></html>`
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}</body></html>`, '/locations/us/chicago': chicago }, { '/team': '/locations/us/chicago' })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Chicago, IL'])
  assert.deepEqual(r.found.filter(f => f.kind === 'person').map(f => f.value), ['Dana Okoye, Office Managing Partner'])
  const base = new URL('https://acme-law.example/')
  assert.deepEqual(officeLinks('<a href="/offices/portland-or">a</a>', base, ['Portland, Maine 04101 USA']), [])
  assert.deepEqual(officeLinks('<a href="/offices/portland-me">a</a>', base, ['Portland, Maine 04101 USA']), ['/offices/portland-me'])
  assert.deepEqual(officeLinks('<a href="/offices/paris-tx">a</a>', base, ['Paris, France']), [])
  assert.equal(otherOffice('/offices/london-ky', ['London, Ontario']), true)
  const tx = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/locations/paris-tx">Paris</a></body></html>`, '/locations/paris-tx': `<html><body>${prose('Our office.')}<a href="tel:+19035550100">903 555 0100</a></body></html>` })
  const r2 = await crawlSite('acme-law.example', tx.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Paris, France'])
  assert.ok(!r2.found.some(f => /9035550100|903 555 0100/.test(f.value)), JSON.stringify(r2.found))
})

test('round 6 (haiku): a US state in the path that is not the requested region is another office; dotted and country-only regions keep the city office', async () => {
  const texas = `<html><body>${prose('Our Paris office.')}<a href="tel:+19035550100">903 555 0100</a><div>Rae Mendel</div><div>Managing Partner</div></body></html>`
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}</body></html>`, '/locations/texas/paris': texas }, { '/team': '/locations/texas/paris' })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Paris, France'])
  assert.ok(!r.found.some(f => /9035550100|903 555 0100|Mendel/.test(f.value)), JSON.stringify(r.found))
  assert.equal(otherOffice('/locations/texas/paris', ['Paris, France']), true)
  assert.equal(otherOffice('/locations/texas/paris', ['Paris, TX']), false)
  assert.equal(otherOffice('/locations/illinois/chicago', ['Chicago']), false)
  for (const where of ['Chicago, IL.', 'Chicago, U.S.', 'Chicago, USA', 'Chicago, United States', 'Chicago, Ill.']) assert.equal(otherOffice('/offices/chicago-il', [where]), false, where)
  assert.equal(otherOffice('/offices/washington-dc', ['Washington, D.C.']), false)
  assert.deepEqual(officeLinks('<a href="/locations/chicago-il">a</a>', new URL('https://acme-law.example/'), ['Chicago, Ill.']), ['/locations/chicago-il'])
  assert.equal(otherOffice('/offices/portland-or', ['Portland, Miss.']), true)
})

test('round 7 (haiku): a ZIP-only region is not a bare city; "Kent" is not Kentucky; a path "tex" is Texas', async () => {
  assert.equal(otherOffice('/offices/paris-tx', ['Paris, 75001']), true)
  assert.equal(otherOffice('/offices/chicago-tx', ['Chicago, 60601']), true)
  assert.equal(otherOffice('/offices/chicago-il', ['Chicago, USA']), false)
  const texas = `<html><body>${prose('Our Paris office.')}<a href="tel:+19035550100">903 555 0100</a><div>Rae Mendel</div><div>Managing Partner</div></body></html>`
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/offices/paris-tx">Paris</a></body></html>`, '/offices/paris-tx': texas })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Paris, 75001'])
  assert.ok(!r.found.some(f => /9035550100|903 555 0100|Mendel/.test(f.value)), JSON.stringify(r.found))
  assert.equal(otherOffice('/offices/ashford-ky', ['Ashford, Kent']), true)
  assert.equal(otherOffice('/offices/chicago-il', ['Chicago, Ill.']), false)
  assert.equal(otherOffice('/locations/tex/paris', ['Paris, France']), true)
  // known limit, fails closed: a two-letter path segment that is also a state code reads as that state
  assert.equal(otherOffice('/locations/de/chicago', ['Chicago, IL']), true)
})

test('round 8 (haiku): state abbreviations are a fixed list: "Ill. 60601" and "Ore. 97201" keep their office; "Kent." and a path "west" or "main" are no state', () => {
  assert.equal(otherOffice('/offices/chicago-il', ['Chicago, Ill. 60601']), false)
  assert.equal(otherOffice('/offices/chicago-il', ['Chicago, Ill., USA']), false)
  assert.equal(otherOffice('/offices/portland-or', ['Portland, Ore. 97201']), false)
  assert.equal(otherOffice('/offices/ashford-ky', ['Ashford, Kent.']), true)
  assert.equal(otherOffice('/locations/west/chicago', ['Chicago, IL']), false)
  assert.equal(otherOffice('/locations/main/chicago', ['Chicago, IL']), false)
  assert.equal(otherOffice('/locations/tex/paris', ['Paris, France']), true)
})

test('round 8 (opus): a state before the office segment, a state-named city followed by another city, and "us-texas" are other offices', async () => {
  for (const path of ['/locations/texas/offices/paris', '/texas/locations/paris', '/locations/us-texas/paris']) assert.equal(otherOffice(path, ['Paris, France']), true, path)
  assert.equal(otherOffice('/offices/new-york/buffalo', ['New York, NY']), true)
  assert.equal(otherOffice('/offices/washington/seattle', ['Washington, DC']), true)
  assert.equal(otherOffice('/offices/new-york', ['New York, NY']), false)
  assert.equal(otherOffice('/offices/new-york/team', ['New York, NY']), false)
  assert.equal(otherOffice('/locations/illinois/chicago', ['Chicago, IL']), false)
  assert.equal(otherOffice('/illinois/locations/chicago', ['Chicago, IL']), false)
  const texas = `<html><body>${prose('Our Paris office.')}<a href="tel:+19035550100">903 555 0100</a><div>Rae Mendel</div><div>Managing Partner</div></body></html>`
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}</body></html>`, '/locations/texas/offices/paris': texas }, { '/team': '/locations/texas/offices/paris' })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Paris, France'])
  assert.ok(!r.found.some(f => /9035550100|903 555 0100|Mendel/.test(f.value)), JSON.stringify(r.found))
})

test('round 9 (opus): a state AFTER the city is checked too; a state-named city with its own region or "-city" is that city', () => {
  assert.equal(otherOffice('/locations/springfield/mo', ['Springfield, IL']), true)
  assert.equal(otherOffice('/locations/portland/oregon', ['Portland, Maine']), true)
  assert.equal(otherOffice('/locations/paris/texas', ['Paris, France']), true)
  assert.equal(otherOffice('/locations/springfield/il', ['Springfield, IL']), false)
  assert.equal(otherOffice('/offices/washington/dc', ['Washington, DC']), false)
  assert.equal(otherOffice('/offices/new-york/new-york-city', ['New York, NY']), false)
  assert.equal(otherOffice('/offices/new-york/ny', ['New York, NY']), false)
  assert.equal(otherOffice('/offices/new-york/buffalo', ['New York, NY']), true)
})

test('round 9 (haiku): a leading state code is not a locale; "new-york-ny/buffalo" is another office', async () => {
  assert.equal(otherOffice('/tx/locations/paris', ['Paris, France']), true)
  assert.equal(otherOffice('/us-tx/locations/paris', ['Paris, France']), true)
  assert.equal(otherOffice('/offices/new-york-ny/buffalo', ['New York, NY']), true)
  assert.equal(otherOffice('/offices/new-york-ny', ['New York, NY']), false)
  assert.equal(otherOffice('/fr/locations/paris', ['Paris, France']), false)
  assert.equal(otherOffice('/il/locations/chicago', ['Chicago, IL']), false)
  const texas = `<html><body>${prose('Our Paris office.')}<a href="tel:+19035550100">903 555 0100</a><div>Rae Mendel</div><div>Managing Partner</div></body></html>`
  const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="/tx/locations/paris">Paris</a></body></html>`, '/tx/locations/paris': texas })
  const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Paris, France'])
  assert.ok(!r.found.some(f => /9035550100|903 555 0100|Mendel/.test(f.value)), JSON.stringify(r.found))
})

test('round 10 (haiku): "us-" prefixed codes are states even when language-like; a state code after a locale is read', async () => {
  for (const path of ['/us-ca/locations/paris', '/us-de/locations/paris', '/us/tx/locations/paris', '/en/tx/locations/paris']) assert.equal(otherOffice(path, ['Paris, France']), true, path)
  assert.equal(otherOffice('/en/tx/locations/chicago', ['Chicago, IL']), true)
  assert.equal(otherOffice('/us-ca/locations/chicago', ['Chicago, IL']), true)
  assert.equal(otherOffice('/us-il/locations/chicago', ['Chicago, IL']), false)
  assert.equal(otherOffice('/de/locations/paris', ['Paris, France']), false)
  assert.equal(otherOffice('/en/il/locations/chicago', ['Chicago, IL']), false)
  const texas = `<html><body>${prose('Our Paris office.')}<a href="tel:+19035550100">903 555 0100</a><div>Rae Mendel</div><div>Managing Partner</div></body></html>`
  for (const path of ['/us-ca/locations/paris', '/us/tx/locations/paris']) {
    const s = site({ '/robots.txt': '', '/': `<html><body><h1>Acme Law</h1>${prose('Acme Law.')}<a href="${path}">Paris</a></body></html>`, [path]: texas })
    const r = await crawlSite('acme-law.example', s.get, 0, 'Acme Law', false, undefined, undefined, 'Managing Partner', 30_000, ['Paris, France'])
    assert.ok(!r.found.some(f => /9035550100|903 555 0100|Mendel/.test(f.value)), path + JSON.stringify(r.found))
  }
})

test('round 10 (opus): a state-named city after another place is that place\'s state; a state in the office segment is read', () => {
  assert.equal(otherOffice('/locations/spokane/washington', ['Washington, DC']), true)
  assert.equal(otherOffice('/locations/albany/new-york', ['New York, NY']), true)
  assert.equal(otherOffice('/locations/us/new-york', ['New York, NY']), false)
  assert.equal(otherOffice('/locations/team/new-york', ['New York, NY']), false)
  for (const path of ['/en-us/tx/locations/paris', '/states/tx/locations/paris', '/texas-offices/paris', '/texas-locations/paris']) assert.equal(otherOffice(path, ['Paris, France']), true, path)
  assert.equal(otherOffice('/firm-offices/chicago', ['Chicago, IL']), false)
  assert.equal(otherOffice('/illinois-offices/chicago', ['Chicago, IL']), false)
})

test('round 11 (opus): country and region words before a state-named city are not another place; "/ca-offices/" is not California', () => {
  for (const [path, where] of [['/offices/usa/new-york', 'New York, NY'], ['/offices/united-states/new-york', 'New York, NY'], ['/locations/usa/new-york-ny', 'New York, NY'], ['/locations/usa/washington-dc', 'Washington, DC'], ['/locations/united-states/washington', 'Washington, DC'], ['/locations/north-america/new-york', 'New York, NY'], ['/offices/global/new-york', 'New York, NY'], ['/offices/usa/new-york', 'New York'], ['/ca-offices/toronto', 'Toronto, ON']] as const)
    assert.equal(otherOffice(path, [where]), false, path + ' ' + where)
  assert.equal(otherOffice('/locations/spokane/washington', ['Washington, DC']), true)
  assert.equal(otherOffice('/locations/albany/new-york', ['New York, NY']), true)
})

test('round 11 (haiku): descriptor words before a state-named city keep the requested office', () => {
  for (const path of ['/locations/usa/new-york', '/locations/midtown/new-york', '/offices/nyc/new-york', '/offices/east-coast/new-york', '/offices/north-america/new-york']) assert.equal(otherOffice(path, ['New York, NY']), false, path)
  for (const path of ['/offices/united-states/washington', '/offices/downtown/washington']) assert.equal(otherOffice(path, ['Washington, DC']), false, path)
})

test('round 12: another place before a suffixed state-named city is still another office; "/tx-offices/" is Texas; "/partners" under the city is its page', () => {
  assert.equal(otherOffice('/offices/seattle/washington-dc', ['Washington, DC']), true)
  assert.equal(otherOffice('/locations/spokane/washington-dc', ['Washington, DC']), true)
  assert.equal(otherOffice('/locations/albany/new-york-ny', ['New York, NY']), true)
  assert.equal(otherOffice('/locations/usa/new-york-ny', ['New York, NY']), false)
  assert.equal(otherOffice('/tx-offices/paris', ['Paris, France']), true)
  assert.equal(otherOffice('/ca-offices/toronto', ['Toronto, ON']), false)
  assert.equal(otherOffice('/offices/washington-dc/partners', ['Washington, DC']), false)
  assert.equal(otherOffice('/offices/new-york-ny/partners', ['New York, NY']), false)
})

test('round 12 (opus): descriptor words after a state-named city keep it; "west-coast" before Washington is not neutral', () => {
  assert.equal(otherOffice('/offices/new-york/midtown', ['New York, NY']), false)
  assert.equal(otherOffice('/offices/washington/downtown', ['Washington, DC']), false)
  assert.equal(otherOffice('/offices/west-coast/washington', ['Washington, DC']), true)
  assert.equal(otherOffice('/offices/east-coast/new-york', ['New York, NY']), false)
})
