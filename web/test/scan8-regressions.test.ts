// Scan 8 (request unchanged): London UK B2B SaaS, 10-50 employees, seed within 90 days AND hiring sales, founder contacts, dated evidence. Two leads were held:
//   a funding article for a company in ANOTHER place (location_mismatch) and one whose quote did not affirm the raise while its contact page belonged to a DIFFERENT company (no_event_evidence).
// Isolated fixtures through the real runJob: invented companies, stubbed news / pages / sites / grader, no network, no key, no credits. Qualification is measured as the run's ACTIONABLE yield
// (verified + dated + fit >= 4 graded + named person + published contact + sales-hiring proof), never as review_reason === null.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'

const REQUEST = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days and are hiring sales staff. Exclude agencies and recruiters. Include founder contacts and dated evidence.'
const ICP = { summary: 'London seed-funded B2B SaaS hiring sales', who: ['Founder'], industries: ['SaaS'], sizes: ['10-50'], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: ['agencies', 'recruiters'], country: 'GB', language: 'en', window_days: 90 }
const ART = 'https://funding-news.example/querix-raises-seed'
const pad = (s: string) => `${s} ${'More about the company and its people. '.repeat(15)}`
const resp = (body: string, url: string) => ({ status: 200, body, finalUrl: url }), nf = (url: string) => ({ status: 404, body: '', finalUrl: url })
const CAREERS = (c: string) => `<html><body><h1>Careers at ${c}</h1><p>Join ${c}.</p><h2>Open roles</h2><ul><li><a href="/careers/ae">Account Executive - London</a> <a href="/careers/ae">Apply</a></li></ul></body></html>`
const JOB = (c: string) => `<html><body><h1>Account Executive - London</h1><p>Join ${c} in London as our Account Executive.</p><a href="/careers/apply">Apply</a></body></html>`
const FOUNDER = '<div class="card"><h3>Jane Doe</h3><p>Chief Executive Officer</p></div>'

interface Opts { company: string; quote: string; articleBody?: string; siteHost: string; homeText: string; teamHtml?: string; contactHtml?: string; fit?: number; twinHome?: string }
function fx(o: Opts): Fixture {
  const page = { title: `${o.company} funding`, text: pad(`Published ${daysAgo(12)}. ${o.articleBody ?? o.quote}.`) }
  const cand = { company: o.company, signal: 'raised a seed round', source_url: ART, excerpt: o.quote, event_date: daysAgo(12) }
  const reply = (p: string, mt?: number) => p.includes('LEAD <n> | fit') ? `LEAD 1 | fit ${o.fit ?? 5} | intent 4 | action 4 | match yyyy | signals seed_round | why London seed-funded SaaS.` : mt === 300 ? JSON.stringify(['London SaaS startup seed round']) : JSON.stringify([cand])
  const prov = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => reply(p, mt), completeDetailed: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => ({ text: reply(p, mt), model: 'stub', usage: { input_tokens: 1, output_tokens: 1 } }), configuredModel: () => 'stub' }
  const home = pad(`<html><body><h1>${o.company}</h1> <p>${o.homeText}</p> <a href="/team">Team</a> <a href="/careers">Careers</a> <a href="/contact">Contact</a>`)
  const crawl = async (url: string) => {
    const u = new URL(url)
    if (u.hostname === 'funding-news.example') return resp(`<html><body><a href="https://${o.siteHost}/">${o.company}</a> ${page.text}</body></html>`, url)
    if (u.hostname !== o.siteHost) return null
    if (u.pathname === '/robots.txt') return resp('User-agent: *\nAllow: /', url)
    const map: Record<string, string | undefined> = { '/': home, '/team': o.teamHtml ?? pad(`<html><body><p>${o.company} is a London software company building sales tooling for retailers across the UK and beyond.</p>${FOUNDER}`), '/careers': CAREERS(o.company), '/careers/ae': JOB(o.company), '/contact': o.contactHtml ?? `<html><body><p>Say hello to the team at ${o.company}.</p><a href="mailto:hello@${o.siteHost}">hello@${o.siteHost}</a></body></html>` }
    return map[u.pathname] !== undefined ? resp(map[u.pathname]!, url) : nf(url)
  }
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['London SaaS startup seed round'], hits: [{ url: ART, title: page.title, snippet: o.quote, date: daysAgo(12) }], tfPages: { [ART]: page }, own: { [ART]: page }, extraction: [cand],
    deps: { score: true, providers: { anthropic: prov, openai: { research: async () => ({ text: '', citedUrls: [] }) } } as never, crawlGet: crawl as never, fetchImpl: (async () => new Response('{}', { status: 200 })) as never } }
}
async function run(o: Opts) {
  const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'
  try {
    const r = await runFixture(fx(o))
    const lead = r.db.prepare('SELECT id, company, review_reason, confidence, fit, company_domain FROM leads').get() as { id: string; company: string; review_reason: string | null; confidence: number | null; fit: number | null; company_domain: string | null } | undefined
    const rep = JSON.parse((r.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { yield?: { verified: number; actionable: number; missing: Record<string, number> }; resolution?: { leads: { company: string; date: string; identity: string; contact: string; reasons: string[]; resolved: boolean; evidence_hold: string | null }[] } }
    const contacts = lead ? r.db.prepare("SELECT kind, value, connector FROM lead_enrichments WHERE lead_id = ? AND kind IN ('email','phone','person','contact')").all(lead.id) as { kind: string; value: string; connector: string }[] : []
    // Final qualification: verified AND dated AND graded fit >= 4 AND a named person AND a published contact AND the run's own actionable count - never review_reason alone.
    const final = !!lead && lead.review_reason === null && (lead.fit ?? 0) >= 4 && (rep.yield?.actionable ?? 0) >= 1 && contacts.some(c => c.kind === 'person') && contacts.some(c => c.kind === 'email' || c.kind === 'phone')
    return { r, lead, rep, contacts, final }
  } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved }
}
const LONDON_HOME = 'London SaaS platform at 1 Old Street, London EC1V 9HX.'
const GOOD_QUOTE = 'Querix, a London B2B SaaS startup with 24 employees, raised a 3m GBP seed round this month'

test('POSITIVE CONTROL: a London company, seed quote affirmed, own site agrees on place, founder listed, published email, graded fit 5 -> FINALLY qualified (actionable), not merely review_reason=null', async () => {
  const x = await run({ company: 'Querix', quote: GOOD_QUOTE, siteHost: 'querix.io', homeText: LONDON_HOME })
  console.log('# positive', JSON.stringify({ lead: x.lead, y: x.rep.yield, c: x.contacts.map(c => c.kind) }))
  assert.equal(x.lead?.review_reason, null); assert.equal(x.final, true, JSON.stringify([x.lead, x.rep.yield, x.contacts]))
})

const NO_RAISE = 'Concordance, a London B2B SaaS startup with 24 employees, announced a new partnership this month'
const CHICAGO = { siteHost: 'concordance.com', homeText: 'Chicago litigation software at 10 Main Street, Chicago, IL 60601.', teamHtml: pad(`<html><body><p>Concordance is a Chicago software company.</p>${FOUNDER}`) }

test('NO-EVENT-SHAPED: the quote never affirms a raise and the contact page belongs to a same-name company elsewhere -> the event hold and the identity failure are reported SEPARATELY, no contact is copied, nothing is qualified', async () => {
  const x = await run({ company: 'Concordance', quote: NO_RAISE, ...CHICAGO })
  assert.equal(x.lead?.review_reason, 'no_event_evidence'); assert.equal(x.final, false); assert.equal(x.rep.yield?.actionable, 0)
  const res = x.rep.resolution!.leads[0] as { date: string; identity: string; contact: string; reasons: string[]; evidence_hold: string | null }
  assert.deepEqual([res.date, res.identity, res.contact, res.evidence_hold], ['found', 'conflict', 'refused', 'no_event_evidence'], 'a publication date is found, the identity conflicts, the contact is refused, AND the event is missing: four separate facts')
  assert.ok(res.reasons.some(r => /no_event_evidence/.test(r) && /publication date is not event proof/.test(r)), res.reasons.join(' | ')); assert.ok(res.reasons.some(r => /different company \(contact_location_mismatch\)/.test(r)))
  assert.deepEqual(x.contacts.filter(c => c.kind !== 'contact_rejected'), [], 'no person / email / phone from the other company is attached to the lead'); assert.equal(x.lead?.company_domain, null)
})
test('A clean contact and a found date do NOT resolve a lead whose quote never affirms the event: resolved is false and says why (previously resolved: true)', async () => {
  const x = await run({ company: 'Concordance', quote: NO_RAISE, siteHost: 'concordance.io', homeText: LONDON_HOME })
  const res = x.rep.resolution!.leads[0] as { date: string; identity: string; contact: string; resolved: boolean; evidence_hold: string | null; reasons: string[] }
  assert.deepEqual([res.date, res.identity, res.contact], ['found', 'confirmed', 'attached']); assert.equal(res.evidence_hold, 'no_event_evidence'); assert.equal(res.resolved, false, res.reasons.join(' | '))
  assert.equal(x.lead?.review_reason, 'no_event_evidence'); assert.equal(x.final, false, 'review_reason is held, so it is not qualified however clean the contact is')
})
test('OTHER-CITY-SHAPED: a funding article whose page puts the company in ANOTHER UK city stays held as location_mismatch (an explicit place conflict is never relaxed), with nothing attached', async () => {
  const q = 'Querix, a Manchester, UK B2B SaaS startup with 24 employees, raised a 3m GBP seed round this month'
  const x = await run({ company: 'Querix', quote: q, siteHost: 'querix.io', homeText: 'Manchester SaaS platform at 1 Deansgate, Manchester M3 4LZ, UK.' })
  assert.equal(x.lead?.review_reason, 'location_mismatch'); assert.equal(x.final, false); assert.equal(x.rep.yield?.actionable, 0); assert.deepEqual(x.contacts.filter(c => c.kind !== 'contact_rejected'), [])
})
test('SAME NAME, DIFFERENT PLACE: a London Querix whose linked site is a New York Querix gets no domain, no person and no email from it (identity conflict), and is not qualified', async () => {
  const x = await run({ company: 'Querix', quote: GOOD_QUOTE, siteHost: 'querix.com', homeText: 'New York SaaS platform at 1 Broadway, New York, NY 10004.', teamHtml: pad(`<html><body><p>Querix is a New York software company.</p>${FOUNDER}`) })
  assert.equal(x.lead?.company_domain, null); assert.deepEqual(x.contacts.filter(c => c.kind !== 'contact_rejected'), []); assert.equal(x.final, false); assert.equal(x.rep.yield?.actionable, 0)
  const res = x.rep.resolution!.leads[0] as { identity: string; contact: string }; assert.deepEqual([res.identity, res.contact], ['conflict', 'refused'])
})
test('FINAL QUALIFICATION is stricter than review_reason=null: a verified London lead with an ungraded / low fit, or no named person, is not final', async () => {
  const low = await run({ company: 'Querix', quote: GOOD_QUOTE, siteHost: 'querix.io', homeText: LONDON_HOME, fit: 3 }); assert.equal(low.lead?.review_reason, null); assert.equal(low.final, false, JSON.stringify([low.lead, low.rep.yield]))
  const noPerson = await run({ company: 'Querix', quote: GOOD_QUOTE, siteHost: 'querix.io', homeText: LONDON_HOME, teamHtml: pad('<html><body><p>Querix is a London software company building sales tooling.</p>') }); assert.equal(noPerson.lead?.review_reason, null); assert.equal(noPerson.final, false)
})
