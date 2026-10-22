import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateSeo, normalizeDomain, parseHomepage, parseRobots, runAudit, recentAudits } from '../lib/seo/audit.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'

const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]

const setup = () => { const db = new Database(':memory:'); migrateSeo(db); return db }
const NOW = 1_800_000_000
const page = (o: { title?: string; desc?: string; h1?: string[]; canonical?: string } = {}) => `<html><head>
${o.title !== undefined ? `<title>${o.title}</title>` : ''}
${o.desc !== undefined ? `<meta name="description" content="${o.desc}">` : ''}
${o.canonical !== undefined ? `<link rel="canonical" href="${o.canonical}">` : ''}
</head><body>${(o.h1 ?? []).map(h => `<h1>${h}</h1>`).join('')}</body></html>`

test('normalizeDomain: strips scheme and path, rejects junk', () => {
  assert.equal(normalizeDomain('https://Acme.COM/some/page?x=1'), 'acme.com')
  assert.equal(normalizeDomain('sub.acme.co.uk'), 'sub.acme.co.uk')
  assert.equal(normalizeDomain('not a domain'), null)
  assert.equal(normalizeDomain('http://user:pw@acme.com'), null)
  assert.equal(normalizeDomain(''), null)
})

test('parseHomepage: title, description, h1 count, canonical', () => {
  const p = parseHomepage(page({ title: 'Acme - Pipe & Fittings', desc: 'We sell pipes. '.repeat(10), h1: ['Acme pipes'], canonical: 'https://acme.com/' }))
  assert.equal(p.title, 'Acme - Pipe & Fittings')
  assert.ok(p.description.length >= 50)
  assert.deepEqual(p.h1s, ['Acme pipes'])
  assert.equal(p.canonical, 'https://acme.com/')
  const multi = parseHomepage(page({ h1: ['One', 'Two'] }))
  assert.equal(multi.h1s.length, 2)
  const none = parseHomepage('<html><head></head><body><p>hi</p></body></html>')
  assert.equal(none.title, ''); assert.equal(none.description, ''); assert.equal(none.h1s.length, 0); assert.equal(none.canonical, '')
})

test('parseRobots: disallow-all detection and sitemap lines', () => {
  assert.deepEqual(parseRobots('User-agent: *\nDisallow: /\n'), { blocksAll: true, sitemaps: [] })
  const r = parseRobots('User-agent: *\nDisallow: /admin\nSitemap: https://acme.com/map.xml\n')
  assert.equal(r.blocksAll, false); assert.deepEqual(r.sitemaps, ['https://acme.com/map.xml'])
  // a disallow-all under a specific bot is not a sitewide block
  assert.equal(parseRobots('User-agent: BadBot\nDisallow: /\nUser-agent: *\nDisallow: /tmp\n').blocksAll, false)
})

test('runAudit: healthy site passes all checks and history is stored', async () => {
  const db = setup()
  const bodies: Record<string, { status: number; body: string }> = {
    'https://acme.com/': { status: 200, body: page({ title: 'Acme - Industrial Pipe', desc: 'Acme makes industrial pipe for municipal water systems across North America. ', h1: ['Industrial pipe, made to last'], canonical: 'https://acme.com/' }) },
    'https://acme.com/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /admin\nSitemap: https://acme.com/sitemap.xml\n' },
  }
  const f = (async (u: string) => { const b = bodies[u]; return new Response(b ? b.body : 'nf', { status: b ? b.status : 404 }) }) as unknown as typeof fetch
  const r = await runAudit(db, 'A', 'https://acme.com/', { fetchImpl: f, lookup: pubLookup, now: NOW })
  assert.ok('checks' in r && r.checks.every(c => c.ok), JSON.stringify(r))
  const hist = recentAudits(db, 'A')
  assert.equal(hist.length, 1); assert.equal(hist[0].domain, 'acme.com')
  const other = recentAudits(db, 'B'); assert.equal(other.length, 0) // tenant isolation
})

test('runAudit: missing meta/canonical/h1, disallow-all robots, no sitemap -> honest failures', async () => {
  const db = setup()
  const f = (async (u: string) => {
    if (u === 'https://acme.com/') return new Response(page({ title: 'Hi', h1: ['A', 'B'] }), { status: 200 })
    if (u === 'https://acme.com/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { status: 200 })
    return new Response('nf', { status: 404 })
  }) as unknown as typeof fetch
  const r = await runAudit(db, 'A', 'acme.com', { fetchImpl: f, lookup: pubLookup, now: NOW })
  assert.ok('checks' in r)
  const by = Object.fromEntries(r.checks.map(c => [c.id, c]))
  assert.equal(by.title.ok, false) // too short
  assert.equal(by.meta_description.ok, false)
  assert.equal(by.h1.ok, false) // two H1s
  assert.equal(by.canonical.ok, false)
  assert.equal(by.robots.ok, false) // blocks everything
  assert.match(by.robots.value, /blocks ALL/i)
  assert.equal(by.sitemap.ok, false)
})

test('runAudit: unreachable domain and bad input return errors, nothing stored', async () => {
  const db = setup()
  const f = (async () => { throw new Error('dns') }) as unknown as typeof fetch
  const r = await runAudit(db, 'A', 'down.example', { fetchImpl: f, lookup: pubLookup, now: NOW })
  assert.ok('error' in r && !('checks' in r)); assert.match((r as { error: string }).error, /could not reach/i)
  const bad = await runAudit(db, 'A', 'not a domain', { fetchImpl: f, lookup: pubLookup, now: NOW })
  assert.ok('error' in bad)
  assert.equal(recentAudits(db, 'A').length, 0)
})
