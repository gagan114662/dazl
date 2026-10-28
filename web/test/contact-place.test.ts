// A contact must AGREE with the lead on place / address / domain before it is attached: a same-name practice in Pico Rivera, CA is never attached to a New York lead.
// Isolated fixtures through the real runJob: invented practice, stubbed article / site / grader, no network, no key, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'

const REQUEST = 'Find New York City dental practices that opened a new location within the past 90 days. Include owner contacts and dated evidence.'
const ICP = { summary: 'NYC dental practices expanding', who: ['Owner'], industries: ['Dental'], sizes: [], where: ['New York City'], signals: ['opened a new location'], exclude: [], country: 'US', language: 'en', window_days: 90 }
const ART = 'https://localnews.example/brightsmile-opens-brooklyn'
const pad = (s: string) => `${s} ${'More about the practice and its patients. '.repeat(15)}`
const resp = (body: string, url: string) => ({ status: 200, body, finalUrl: url }), nf = (url: string) => ({ status: 404, body: '', finalUrl: url })
const QUOTE = 'Bright Smile Dental opened a new location in Brooklyn, New York this month'
const OWNER = '<div class="card"><h3>Maria Lopez</h3><p>Owner</p></div>'

interface Site { home: string; contact: string; team?: string; link?: boolean }
function fx(site: Site): Fixture {
  const page = { title: 'Bright Smile Dental opens in Brooklyn', text: pad(`Published ${daysAgo(10)}. ${QUOTE}.`) }
  const cand = { company: 'Bright Smile Dental', signal: 'opened a new location', source_url: ART, excerpt: QUOTE, event_date: daysAgo(10) }
  const reply = (p: string, mt?: number) => p.includes('LEAD <n> | fit') ? 'LEAD 1 | fit 5 | intent 4 | action 4 | match yyyy | signals expansion | why NYC practice opening.' : mt === 300 ? JSON.stringify(['nyc dental practice opens new location']) : JSON.stringify([cand])
  const prov = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => reply(p, mt), completeDetailed: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => ({ text: reply(p, mt), model: 'stub', usage: { input_tokens: 1, output_tokens: 1 } }), configuredModel: () => 'stub' }
  const crawl = async (url: string) => {
    const u = new URL(url)
    if (u.hostname === 'localnews.example') return resp(`<html><body>${site.link ? '<a href="https://brightsmiledental.com/">Bright Smile Dental</a> ' : ''}${page.text}</body></html>`, url)
    if (u.hostname.replace(/^www\./, '') !== 'brightsmiledental.com') return null
    if (u.pathname === '/robots.txt') return resp('User-agent: *\nAllow: /', url)
    const map: Record<string, string | undefined> = { '/': site.home, '/contact': site.contact, '/team': site.team ?? pad(`<html><body><p>Bright Smile Dental is a family dental practice.</p>${OWNER}`) }
    return map[u.pathname] !== undefined ? resp(map[u.pathname]!, url) : nf(url)
  }
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['nyc dental practice opens new location'], hits: [{ url: ART, title: page.title, snippet: QUOTE, date: daysAgo(10) }], tfPages: { [ART]: page }, own: { [ART]: page }, extraction: [cand],
    deps: { score: true, providers: { anthropic: prov, openai: { research: async () => ({ text: '', citedUrls: [] }) } } as never, crawlGet: crawl as never, fetchImpl: (async () => new Response('{}', { status: 200 })) as never } }
}
async function run(site: Site) {
  const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'
  try {
    const r = await runFixture(fx(site))
    const lead = r.db.prepare('SELECT id, review_reason, company_domain, contact FROM leads').get() as { id: string; review_reason: string | null; company_domain: string | null; contact: string | null } | undefined
    const enr = lead ? r.db.prepare("SELECT kind, value, label, connector FROM lead_enrichments WHERE lead_id = ?").all(lead.id) as { kind: string; value: string; label: string | null; connector: string }[] : []
    return { r, lead, enr, attached: enr.filter(e => ['email', 'phone', 'person'].includes(e.kind)) }
  } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved }
}
const NYC_HOME = pad('<html><body><h1>Bright Smile Dental</h1><p>Family dentistry at 120 Court Street, Brooklyn, NY 11201.</p> <a href="/team">Team</a> <a href="/contact">Contact</a>')
const NYC_CONTACT = '<html><body><p>Bright Smile Dental, 120 Court Street, Brooklyn, NY 11201. Call (718) 555-0142.</p><a href="mailto:hello@brightsmiledental.com">hello@brightsmiledental.com</a></body></html>'

const PICO_HOME = pad('<html><body><h1>Bright Smile Dental</h1><p>Family dentistry at 8801 Slauson Avenue, Pico Rivera, CA 90660.</p> <a href="/team">Team</a> <a href="/contact">Contact</a>')
const PICO_CONTACT = '<html><body><p>Bright Smile Dental, 8801 Slauson Avenue, Pico Rivera, CA 90660. Call (562) 555-0188.</p><a href="mailto:hello@brightsmiledental.com">hello@brightsmiledental.com</a></body></html>'
const NO_PLACE_HOME = pad('<html><body><h1>Bright Smile Dental</h1><p>Gentle family dentistry for the whole family.</p> <a href="/team">Team</a> <a href="/contact">Contact</a>')
const refused = (x: Awaited<ReturnType<typeof run>>) => { assert.deepEqual(x.attached, [], JSON.stringify(x.enr)); assert.equal(x.lead?.company_domain, null); assert.ok(x.enr.some(e => e.kind === 'contact_rejected' && /^contact_location_(mismatch|unconfirmed)$/.test(e.label ?? '')), JSON.stringify(x.enr)) }

test('POSITIVE CONTROL: the practice\'s own site agrees on the Brooklyn address -> the domain and the published email are attached', async () => {
  const x = await run({ home: NYC_HOME, contact: NYC_CONTACT, link: true })
  assert.equal(x.lead?.company_domain, 'brightsmiledental.com'); assert.ok(x.attached.some(a => a.kind === 'email' && a.value === 'hello@brightsmiledental.com'), JSON.stringify(x.enr))
})
test('PICO RIVERA: the same-name practice linked from the NYC article states its Pico Rivera, CA address -> no domain, no email, no phone, no person; the refusal is recorded', async () => {
  refused(await run({ home: PICO_HOME, contact: PICO_CONTACT, link: true }))
})
test('PICO RIVERA via a guessed domain: the homepage names no place but the contact page is Pico Rivera -> still nothing attached (a guessed domain must AGREE on place for a city ask)', async () => {
  refused(await run({ home: NO_PLACE_HOME, contact: PICO_CONTACT }))
})
test('UNCONFIRMED place anywhere: a linked same-name site that states no place at all attaches nothing (a city ask needs a positive place or address), the reason is location_unconfirmed', async () => {
  const x = await run({ home: NO_PLACE_HOME, contact: '<html><body><p>Bright Smile Dental. Call (562) 555-0188.</p><a href="mailto:hello@brightsmiledental.com">hello@brightsmiledental.com</a></body></html>', link: true })
  refused(x)
})
