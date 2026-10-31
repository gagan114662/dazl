// One bounded completion step before a scan returns: kept-but-incomplete leads get the free sources' answer (source date from the page's own structured data, the company domain through the identity check, a
// contact on that domain), the lead's score is recomputed from the evidence it actually has, and a per-lead record says what was filled and what is still missing. Stubbed pages / sites / grader through the real
// runJob, five incomplete leads; invented practices; no network, no key, no credits; no gate is loosened.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { evidenceScore, FACT_LABEL } from '../lib/scan/completion.ts'

const REQUEST = 'Find dental practices in Brooklyn, NY that opened a new location. Include owner contacts.'
const ICP = { summary: 'Brooklyn dental practices expanding', who: ['Owner'], industries: ['Dental'], sizes: [], where: ['Brooklyn, NY'], signals: ['opened a new location'], exclude: [], country: 'US', language: 'en' }   // NO window: undated leads are kept
const pad = (s: string) => `${s} ${'More about the practice and its patients. '.repeat(15)}`
const resp = (body: string, url: string) => ({ status: 200, body, finalUrl: url }), nf = (url: string) => ({ status: 404, body: '', finalUrl: url })
const OWNER = (n: string) => `<div class="card"><h3>${n}</h3><p>Chief Executive Officer</p></div>`
interface Co { name: string; slug: string; host: string; dated: boolean; structured?: boolean; site: 'full' | 'no-person' | 'no-contacts' | 'none' }
const COS: Co[] = [
  { name: 'Aone Dental', slug: 'aone', host: 'aonedental.com', dated: true, site: 'full' },
  { name: 'Btwo Dental', slug: 'btwo', host: 'btwodental.com', dated: true, site: 'no-person' },
  { name: 'Cthree Dental', slug: 'cthree', host: 'cthreedental.com', dated: true, site: 'no-contacts' },
  { name: 'Dfour Dental', slug: 'dfour', host: 'dfourdental.com', dated: true, site: 'none' },
  { name: 'Efive Dental', slug: 'efive', host: 'efivedental.com', dated: false, structured: true, site: 'full' },
]
const url = (c: Co) => `https://news.example/${c.slug}-opens`
// A dated lead's page states the day in the quote's own sentence (#460: a day the text never ties to this company and event is not the event's date;
// the hit's date alone would read undated). The undated lead's page says only "this month": its day comes from its structured data.
const quote = (c: Co) => `${c.name} opened a new location in Brooklyn, New York ${c.dated ? `on ${daysAgo(10)}` : 'this month'}`
const EVENT = (c: Co, startDate: string) => JSON.stringify({ '@context': 'https://schema.org', '@type': 'Event', name: `${c.name} grand opening`, startDate, organizer: { '@type': 'Organization', name: c.name }, location: { '@type': 'Place', name: 'Brooklyn, NY' } })

function fx(): Fixture {
  const cands: Cand[] = COS.map(c => ({ company: c.name, signal: 'opened a new location', source_url: url(c), excerpt: quote(c), event_date: c.dated ? daysAgo(10) : null }))
  const pages = Object.fromEntries(COS.map(c => [url(c), { title: `${c.name} opens in Brooklyn`, text: pad(`${quote(c)}.`), ...(c.structured ? { structured: [EVENT(c, daysAgo(8))] } : {}) }]))
  const reply = (p: string, mt?: number) => p.includes('LEAD <n> | fit') ? COS.map((_, i) => `LEAD ${i + 1} | fit 5 | intent 4 | action 4 | match yyyy | signals expansion | why a Brooklyn practice opening.`).join('\n') : mt === 300 ? JSON.stringify(['brooklyn dental practice opens new location']) : JSON.stringify(cands)
  const prov = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => reply(p, mt), completeDetailed: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => ({ text: reply(p, mt), model: 'stub', usage: { input_tokens: 1, output_tokens: 1 } }), configuredModel: () => 'stub' }
  const crawl = async (u: string) => {
    const x = new URL(u), co = COS.find(c => x.hostname.replace(/^www\./, '') === c.host)
    if (x.hostname === 'news.example') return resp(`<html><body>${pad(quote(COS.find(c => u.includes(c.slug))!))}</body></html>`, u)
    if (!co || co.site === 'none') return null
    if (x.pathname === '/robots.txt') return resp('User-agent: *\nAllow: /', u)
    const home = pad(`<html><body><h1>${co.name}</h1><p>Family dentistry at 120 Court Street, Brooklyn, NY 11201.</p> <a href="/team">Team</a> <a href="/contact">Contact</a>`)
    const contact = co.site === 'no-contacts' ? '<html><body><p>Visit us in Brooklyn, NY.</p></body></html>' : `<html><body><p>${co.name}, 120 Court Street, Brooklyn, NY 11201. Call (718) 555-01${co.slug.length}0.</p><a href="mailto:hello@${co.host}">hello@${co.host}</a></body></html>`
    const team = co.site === 'full' ? pad(`<html><body><p>${co.name} is a Brooklyn family dental practice. Our dentists welcome families, children and seniors every weekday with gentle care, modern equipment and friendly staff.</p>${OWNER('Maria Lopez')}`) : pad(`<html><body><p>${co.name} is a Brooklyn family dental practice.</p>`)
    const map: Record<string, string> = { '/': home, '/contact': contact, '/team': team }
    return map[x.pathname] !== undefined ? resp(map[x.pathname], u) : nf(u)
  }
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['brooklyn dental practice opens new location'], hits: COS.map(c => ({ url: url(c), title: `${c.name} opens`, snippet: quote(c), date: c.dated ? daysAgo(10) : null })),
    tfPages: pages, own: pages, extraction: cands, deps: { score: true, providers: { anthropic: prov, openai: { research: async () => ({ text: '', citedUrls: [] }) } } as never, crawlGet: crawl as never, fetchImpl: (async () => new Response('{}', { status: 200 })) as never } }
}
async function run() {
  const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'
  try {
    const x = await runFixture(fx())
    const rows = x.db.prepare('SELECT id, company, event_date, company_domain, score, review_reason FROM leads ORDER BY company').all() as { id: string; company: string; event_date: string | null; company_domain: string | null; score: number; review_reason: string | null }[]
    const rec = (id: string) => x.db.prepare("SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:completion'").get(id) as { value: string; label: string } | undefined
    return { x, rows, rec }
  } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved }
}

test('REPLAY: five incomplete leads - before / after fields and scores, with what was filled and what is still missing recorded per lead', async () => {
  const { rows, rec } = await run()
  assert.equal(rows.length, 5); assert.ok(rows.every(r => r.review_reason === null), JSON.stringify(rows.map(r => r.review_reason)))
  const table: string[] = []
  const want: Record<string, { filled: string[]; missing: string[]; score: number }> = {
    'Aone Dental': { filled: ['domain', 'person', 'route'], missing: [], score: 100 },
    'Btwo Dental': { filled: ['domain', 'route'], missing: ['person'], score: 85 },
    'Cthree Dental': { filled: ['domain'], missing: ['person', 'route'], score: 75 },
    'Dfour Dental': { filled: [], missing: ['domain', 'person', 'route'], score: 60 },
    'Efive Dental': { filled: ['date', 'domain', 'person', 'route'], missing: [], score: 100 },
  }
  for (const r of rows) {
    const e = rec(r.id)!; const l = JSON.parse(e.label) as { filled: string[]; missing: string[]; score: [number, number] }
    table.push(`${r.company.padEnd(14)} date=${r.event_date ?? '-'} domain=${r.company_domain ?? '-'} score ${l.score[0]} -> ${l.score[1]} | ${e.value}`)
    assert.deepEqual([l.filled.sort(), l.missing.sort(), r.score], [want[r.company].filled.sort(), want[r.company].missing.sort(), want[r.company].score], `${r.company}: ${e.value}`)
    assert.equal(r.score, l.score[1], 'the stored score is the recomputed one')
  }
  console.log(`# completion replay (stub)\n# ${table.join('\n# ')}`)
})
test('the score is a pure function of the evidence found: no domain / person / route / date is worth nothing, a graded fit of 4+ adds 5, and the weights cap at 100', () => {
  const none = { date: false, domain: false, person: false, route: false }, all = { date: true, domain: true, person: true, route: true }
  assert.equal(evidenceScore(none, null), 40); assert.equal(evidenceScore(none, 5), 45); assert.equal(evidenceScore(all, null), 95); assert.equal(evidenceScore(all, 4), 100); assert.equal(evidenceScore({ ...none, domain: true }, 3), 55)
  assert.deepEqual(Object.keys(FACT_LABEL).sort(), ['date', 'domain', 'person', 'route'])
})
test('NO GATE MOVES: the dated lead without a window keeps its quote date, the undated one gets its date ONLY from its own page\'s same-event structured data, and nothing was held or promoted by the step', async () => {
  const { rows } = await run()
  const by = Object.fromEntries(rows.map(r => [r.company, r])); assert.equal(by['Efive Dental'].event_date, daysAgo(8)); assert.equal(by['Aone Dental'].event_date, daysAgo(10)); assert.ok(rows.every(r => r.review_reason === null))
})

// ---- the score counts only evidence that belongs to the lead ----
import { completeLeads, snapshotLeads } from '../lib/scan/completion.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
test('NOT EVIDENCE: a person / phone / email from a namesake\'s domain, or any site contact on a lead with no confirmed domain, adds nothing to the score and is not "filled"', async () => {
  const { x, rows } = await run()
  const dfour = rows.find(r => r.company === 'Dfour Dental')!, bt = rows.find(r => r.company === 'Btwo Dental')!, job = (x.db.prepare('SELECT scan_job_id AS j FROM leads WHERE id = ?').get(dfour.id) as { j: string }).j
  const add = (id: string, kind: string, value: string, host: string) => addEnrichment(x.db, 'A', id, { connector: 'sitecrawl', kind, value, label: 'x', confidence: 60, source_url: `https://${host}/team`, source_date: '2026-10-20', retrieved_at: 1 })
  add(dfour.id, 'person', 'Maria Lopez, Chief Executive Officer', 'dfourdental.com'); add(dfour.id, 'email', 'hello@dfourdental.com', 'dfourdental.com')   // lead has NO confirmed domain
  add(bt.id, 'person', 'Maria Lopez, Chief Executive Officer', 'btwo-picorivera.com'); add(bt.id, 'email', 'hello@btwo-picorivera.com', 'btwo-picorivera.com')   // wrong domain
  add(bt.id, 'email', 'owner@somewhere-else.com', 'btwodental.com')   // right page, email at another domain
  const before = snapshotLeads(x.db, 'A', job)
  const out = completeLeads(x.db, { id: job, user_id: 'A' }, before, { windowed: false })
  const d4 = out.find(o => o.company === 'Dfour Dental')!, b2 = out.find(o => o.company === 'Btwo Dental')!
  assert.deepEqual([d4.after.person, d4.after.route, d4.score_after], [false, false, 60]); assert.deepEqual([b2.after.person, b2.after.route, b2.score_after], [false, true, 85])
})
