// A company domain must not be accepted from a NAME-ONLY guess. Live shape: a lead in Sunnyside, NY ("Smile Avenue Dental"); the guessed domain smileavenuedental.com belongs to a same-name practice in
// Pico Rivera, CA; its homepage names the company, and its contacts sit on that same domain, so the domain and the contacts agree with each other. Only the site's OWN location can tell them apart.
// Isolated fixtures through the real runJob (invented businesses, stubbed article / site / grader); no network, no key, no credits. No contact detail here is real.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'

const REQUEST = 'Find dental practices in Sunnyside, NY that opened a new location within the past 90 days. Include owner contacts.'
const ICP = { summary: 'Queens dental practices expanding', who: ['Owner'], industries: ['Dental'], sizes: [], where: ['Sunnyside, NY'], signals: ['opened a new location'], exclude: [], country: 'US', language: 'en', window_days: 90 }
const ART = 'https://localnews.example/smile-avenue-dental-opens'
const pad = (s: string) => `${s} ${'More about the practice and its patients. '.repeat(15)}`
const resp = (body: string, url: string) => ({ status: 200, body, finalUrl: url }), nf = (url: string) => ({ status: 404, body: '', finalUrl: url })
// The evidence article is full of "on <Capitalized>" / "in <Capitalized>" / "at <Capitalized Name>" phrases that are NOT places (a weekday, a month, the practice's own name) - exactly what the old guess check accepted as places.
const QUOTE = 'Smile Avenue Dental opened a new location in Sunnyside, NY this month'
const ARTICLE = `Published ${daysAgo(10)}. ${QUOTE}. The practice is open on Monday through Friday, was founded in March by Dr. Rivera, and patients can book at Smile Avenue Dental online.`
const OWNER = '<div class="card"><h3>Maria Lopez</h3><p>Owner</p></div>'
const SITE = 'smileavenuedental.com'
interface Site { home: string; contact: string; team?: string; link?: boolean }
function fx(site: Site): Fixture {
  const page = { title: 'Smile Avenue Dental opens in Sunnyside', text: pad(ARTICLE) }
  const cand = { company: 'Smile Avenue Dental', signal: 'opened a new location', source_url: ART, excerpt: QUOTE, event_date: daysAgo(10) }
  const reply = (p: string, mt?: number) => p.includes('LEAD <n> | fit') ? 'LEAD 1 | fit 5 | intent 4 | action 4 | match yyyy | signals expansion | why a Queens practice opening.' : mt === 300 ? JSON.stringify(['queens dental practice opens new location']) : JSON.stringify([cand])
  const prov = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => reply(p, mt), completeDetailed: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => ({ text: reply(p, mt), model: 'stub', usage: { input_tokens: 1, output_tokens: 1 } }), configuredModel: () => 'stub' }
  const crawl = async (url: string) => {
    const u = new URL(url)
    if (u.hostname === 'localnews.example') return resp(`<html><body>${site.link ? `<a href="https://${SITE}/">Smile Avenue Dental</a> ` : ''}${page.text}</body></html>`, url)   // by default the article links NO company site: the domain can only come from a name guess
    if (u.hostname.replace(/^www\./, '') !== SITE) return null
    if (u.pathname === '/robots.txt') return resp('User-agent: *\nAllow: /', url)
    const map: Record<string, string | undefined> = { '/': site.home, '/contact': site.contact, '/team': site.team ?? pad(`<html><body><p>Smile Avenue Dental is a family dental practice.</p>${OWNER}`) }
    return map[u.pathname] !== undefined ? resp(map[u.pathname]!, url) : nf(url)
  }
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['queens dental practice opens new location'], hits: [{ url: ART, title: page.title, snippet: QUOTE, date: daysAgo(10) }], tfPages: { [ART]: page }, own: { [ART]: page }, extraction: [cand],
    deps: { score: true, providers: { anthropic: prov, openai: { research: async () => ({ text: '', citedUrls: [] }) } } as never, crawlGet: crawl as never, fetchImpl: (async () => new Response('{}', { status: 200 })) as never } }
}
async function run(site: Site) {
  const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'
  try {
    const r = await runFixture(fx(site))
    const lead = r.db.prepare('SELECT id, company_domain, review_reason FROM leads').get() as { id: string; company_domain: string | null; review_reason: string | null } | undefined
    const enr = lead ? r.db.prepare('SELECT kind, value, label, connector FROM lead_enrichments WHERE lead_id = ?').all(lead.id) as { kind: string; value: string; label: string | null; connector: string }[] : []
    return { r, lead, enr, attached: enr.filter(e => ['email', 'phone', 'person'].includes(e.kind)), rejected: enr.filter(e => e.kind === 'contact_rejected') }
  } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved }
}
// Another city's practice: no street address on the homepage (so the address check has nothing to compare), but the page mentions weekdays and the practice's own name.
const PICO_HOME = pad('<html><body><h1>Smile Avenue Dental Group</h1><p>Family dentistry. Open Monday through Friday. Book at Smile Avenue Dental Group today.</p> <a href="/team">Team</a> <a href="/contact">Contact</a>')
const PICO_CONTACT = '<html><body><p>Smile Avenue Dental Group, Pico Rivera, CA 90660. Call (562) 555-0100.</p><a href="mailto:hello@smileavenuedental.com">hello@smileavenuedental.com</a></body></html>'
const QUEENS_HOME = pad('<html><body><h1>Smile Avenue Dental</h1><p>Family dentistry at 45-12 Queens Boulevard, Sunnyside, NY 11104. Open Monday through Friday.</p> <a href="/team">Team</a> <a href="/contact">Contact</a>')
const QUEENS_CONTACT = '<html><body><p>Smile Avenue Dental, 45-12 Queens Boulevard, Sunnyside, NY 11104. Call (718) 555-0100.</p><a href="mailto:hello@smileavenuedental.com">hello@smileavenuedental.com</a></body></html>'

test('LIVE SHAPE: same-name practice in another city, domain from a name-only guess, contacts on that same domain -> NO domain saved and NO contact attached; the refusal is recorded', async () => {
  const x = await run({ home: PICO_HOME, contact: PICO_CONTACT })
  assert.equal(x.lead?.company_domain, null, JSON.stringify(x.lead)); assert.deepEqual(x.attached, [], JSON.stringify(x.enr))
  assert.ok(x.rejected.some(e => /^contact_location_(unconfirmed|mismatch)$/.test(e.label ?? '')), JSON.stringify(x.enr))
})
test('CONTROL: the practice\'s own site states the Sunnyside, NY address -> the guessed domain IS accepted and its contacts are attached', async () => {
  const x = await run({ home: QUEENS_HOME, contact: QUEENS_CONTACT })
  assert.equal(x.lead?.company_domain, SITE); assert.ok(x.attached.some(a => a.kind === 'email'), JSON.stringify(x.enr)); assert.deepEqual(x.rejected, [])
})
test('a guessed domain whose homepage names no location at all is held too: the name matching is not an identity', async () => {
  const none = await run({ home: pad('<html><body><h1>Smile Avenue Dental</h1><p>Gentle family dentistry. Open Monday through Friday.</p> <a href="/contact">Contact</a>'), contact: '<html><body><p>Call (555) 555-0100.</p><a href="mailto:hello@smileavenuedental.com">hello@smileavenuedental.com</a></body></html>' })
  assert.equal(none.lead?.company_domain, null); assert.deepEqual(none.attached, [])
})

test('LINKED but not placed: the article links a same-name site whose homepage names no place of the lead - "Monday" / "March" / the practice\'s own name in the evidence no longer count as places', async () => {
  const x = await run({ home: PICO_HOME, contact: PICO_CONTACT, link: true })
  assert.equal(x.lead?.company_domain, null, JSON.stringify(x.lead)); assert.deepEqual(x.attached, [], JSON.stringify(x.enr))
  const ok = await run({ home: QUEENS_HOME, contact: QUEENS_CONTACT, link: true }); assert.equal(ok.lead?.company_domain, SITE); assert.ok(ok.attached.some(a => a.kind === 'email'))
})
test('placeTerms: weekdays, months, social names and the company\'s own name are not places; real places from the scan and the evidence still are', async () => {
  const { placeTerms } = await import('../lib/connectors/sitecrawl.ts')
  const t = placeTerms(['Sunnyside, NY'], 'open on Monday, founded in March, book at Smile Avenue Dental, follow us on Instagram, opened in Sunnyside, Queens and at Hunters Point', 'Smile Avenue Dental')
  for (const bad of ['monday', 'march', 'smileavenuedental', 'instagram']) assert.ok(!t.includes(bad), bad)
  for (const good of ['sunnysideny', 'sunnyside', 'hunterspoint']) assert.ok(t.includes(good), `${good} in ${t}`)
})

// ---- the namesake mentions the lead's place only as somewhere it SERVES; its own address is elsewhere ----
const SERVES = pad('<html><body><h1>Smile Avenue Dental Group</h1><p>Smile Avenue Dental Group, Pico Rivera, CA 90660. We proudly serve patients from Sunnyside and Queens. Open Monday through Friday.</p> <a href="/team">Team</a> <a href="/contact">Contact</a>')
test('SERVICE-AREA NAMESAKE: the homepage names Sunnyside only as an area it serves, and gives its own Pico Rivera, CA address -> no domain, no contact', async () => {
  const x = await run({ home: SERVES, contact: PICO_CONTACT })
  assert.equal(x.lead?.company_domain, null, JSON.stringify(x.lead)); assert.deepEqual(x.attached, [], JSON.stringify(x.enr))
  const linked = await run({ home: SERVES, contact: PICO_CONTACT, link: true }); assert.equal(linked.lead?.company_domain, null); assert.deepEqual(linked.attached, [])
})

test('ownAddressElsewhere: a "City, ST 12345" address in another state is the site owner\'s; the asked state\'s address (alone or beside another office) is not elsewhere', async () => {
  const { ownAddressElsewhere } = await import('../lib/connectors/sitecrawl.ts')
  assert.equal(ownAddressElsewhere('Smile Avenue Dental Group, Pico Rivera, CA 90660. We serve Sunnyside.', ['Sunnyside, NY']), true)
  assert.equal(ownAddressElsewhere('45-12 Queens Boulevard, Sunnyside, NY 11104. Second office: Pico Rivera, CA 90660.', ['Sunnyside, NY']), false)
  assert.equal(ownAddressElsewhere('Family dentistry at 45-12 Queens Boulevard, Sunnyside, NY 11104.', ['Sunnyside, NY']), false)
  assert.equal(ownAddressElsewhere('Open Monday through Friday. We serve Sunnyside.', ['Sunnyside, NY']), false, 'no address printed: nothing to conflict (the positive-agreement rule still decides)')
})
