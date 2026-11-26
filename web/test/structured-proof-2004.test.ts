// #2004: a day the proof page states in its own typed markup is event-date proof - but only when it is the SAME confirmed proof page,
// only when a typed node names the field (a JobPosting's datePosted for a hiring signal, an Article's datePublished - or a
// schema.org subtype's - for any other), and only through the age and future guards. It is its own proof kind (page_structured), never "printed".
// Every page below is a real page, recorded verbatim in fixtures/structured-2004 with its URL and fetch date.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkLead, datesThisPosting, structuredDay, type CheckedLead } from '../lib/discover/check.ts'
import type { DiscoveredLead } from '../lib/discover/agent.ts'
import { discoveredLead } from '../lib/scan/runner.ts'
import { eventDayVerified } from '../lib/scan/scoreboard.ts'

const NOW = new Date('2026-11-26T12:00:00Z')
type Rec = { company: string; country: string; industry: string; url: string; fetched: string; blocks: string[]; text: string }
const rec = (name: string): Rec => JSON.parse(readFileSync(new URL(`./fixtures/structured-2004/${name}`, import.meta.url), 'utf8')) as Rec
const html = (r: Rec): string => r.blocks.map(b => `<script type="application/ld+json">${b}</script>`).join('\n') + `\n<p>${r.text}</p>`
const fetchOf = (body: string) => (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
const leadOf = (r: Rec, signal: string, quote: string): DiscoveredLead => ({
  company: r.company, domain: null, signal, signal_date: null, evidence_url: r.url, evidence_quote: quote, person: null, title: null,
  person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'recorded page',
})

// Real recorded pages from three countries and three industries, each carrying a typed date on its own markup.
const DATED: [string, boolean, string, string][] = [
  ['yonovo-us-software.json', true, '2026-10-20', 'JobPosting.datePosted'],
  ['n8n-de-software.json', true, '2026-11-02', 'JobPosting.datePosted'],
  ['yoast-nl-marketing.json', false, '2026-11-25', 'Article.datePublished'],
]
for (const [name, hiring, day, field] of DATED) {
  test(`#2004 ${name}: the page's own typed ${field} is the day`, () => {
    const r = rec(name)
    assert.ok(r.url.startsWith('https://') && r.fetched === '2026-11-26', `${name} is a recorded page with its URL and fetch date`)
    const s = structuredDay(html(r), NOW, hiring)
    assert.deepEqual([s?.day, s?.field], [day, field])
  })
}

test('#2004 a non-hiring signal does not take a posting datePosted', () => {
  assert.equal(structuredDay(html(rec('yonovo-us-software.json')), NOW, false), null)
})

// End to end through the real check: the recorded proof page is fetched, judged, and its typed day becomes the lead's proof.
test('#2004 the Yoast page dates a non-hiring lead through its own Article.datePublished', async () => {
  const r = rec('yoast-nl-marketing.json')
  const quote = 'The November 2026 SEO Update by Yoast recap'
  const checked = await checkLead(leadOf(r, 'Yoast published its November 2026 SEO update recap', quote), [], fetchOf(html(r)), 5_000, NOW)
  assert.equal(checked.proof, 'confirmed')
  assert.equal(checked.date, '2026-11-25')
  assert.equal(checked.date_on_page, true)
  assert.equal(checked.date_on_page_field, 'Article.datePublished')
  const stored = discoveredLead(checked, NOW.getTime())
  assert.equal(stored.event_date_proof, 'page_structured')
  assert.match(stored.event_date_proof_note ?? '', /Article\.datePublished/)
  assert.doesNotMatch(stored.event_date_proof_note ?? '', /printed/)
  assert.equal(stored.date_status, 'verified')
  assert.equal(eventDayVerified({ event_date: stored.event_date, event_date_proof: stored.event_date_proof, signal: stored.signal }), true)
})

// A day printed in the page text keeps its own proof: it is never relabelled as structured, and a structured day is never called printed.
test('#2004 a printed day stays page_bound and a typed day stays page_structured', () => {
  const base: CheckedLead = {
    company: 'Yonovo', domain: null, signal: 'is hiring an SDR', signal_date: null, evidence_url: 'https://www.yonovo.com/careers',
    evidence_quote: null, person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
    confidence: 'high', why: '', proof: 'confirmed', proof_read_by: 'dazl', quote_on_page: true, signal_seen: true, claim_lacks: [],
    date_on_page: true, page_age: null, date: '2026-10-20', date_source: 'page',
  }
  const printed = discoveredLead(base, NOW.getTime())
  assert.equal(printed.event_date_proof, 'page_bound')
  assert.equal(printed.event_date_proof_note, 'the date is printed on the proof page')
  const typed = discoveredLead({ ...base, date_on_page_field: 'JobPosting.datePosted' }, NOW.getTime())
  assert.equal(typed.event_date_proof, 'page_structured')
  assert.match(typed.event_date_proof_note ?? '', /JobPosting\.datePosted/)
})

// A typed date on a page whose proof is not confirmed proves nothing: the same fail-closed rule as a printed day.
test('#2004 a typed date on an unconfirmed proof is not proof', () => {
  const checked: CheckedLead = {
    company: 'Yoast', domain: null, signal: 'published a recap', signal_date: null, evidence_url: 'https://yoast.com/x', evidence_quote: null,
    person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: '',
    proof: 'company_not_on_page', proof_read_by: 'dazl', quote_on_page: false, signal_seen: false, claim_lacks: [], date_on_page: true,
    date_on_page_field: 'Article.datePublished', page_age: null, date: '2026-11-25', date_source: 'page',
  }
  assert.equal(discoveredLead(checked, NOW.getTime()).event_date_proof, null)
})

// Controls: each stays undated and unproven.
test('#2004 control: a dateModified-only page gives no day', () => {
  const r = rec('yoast-nl-marketing.json')
  const withoutPublished = r.blocks.map(b => b.replace(/"datePublished"/g, '"dateModified"'))
  assert.equal(structuredDay(withoutPublished.map(b => `<script type="application/ld+json">${b}</script>`).join(''), NOW, false), null)
})

test('#2004 control: a typed date in the future gives no day', () => {
  const r = rec('yoast-nl-marketing.json')
  const future = r.blocks.map(b => b.replace(/"datePublished":"[^"]+"/, '"datePublished":"2027-01-05T09:00:00+00:00"'))
  assert.equal(structuredDay(future.map(b => `<script type="application/ld+json">${b}</script>`).join(''), NOW, false), null)
})

test('#2004 control: a typed date older than the age guard gives no day (Hostinger, 2023-08-31)', () => {
  const r = rec('hostinger-lt-hosting.json')
  assert.equal(structuredDay(html(r), NOW, false), null)
})

test('#2004 control: a page with no structured data gives no day', () => {
  assert.equal(structuredDay('<html><body><p>Careers</p></body></html>', NOW, true), null)
})

// The other page in the run carries the date; the proof page carries only a WebPage node's datePublished. Nothing is borrowed across pages.
test('#2004 control: a typed date on a DIFFERENT page than the proof is not this lead\'s day', async () => {
  const r = rec('yoast-nl-marketing.json')
  const webpage = (JSON.parse(r.blocks[0]) as { '@graph': { '@type': string; datePublished?: string }[] })['@graph']
    .filter(n => n['@type'] === 'WebPage')
  assert.ok(webpage.length === 1 && webpage[0].datePublished)
  const page = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': webpage })}</script>\n<p>${r.text}</p>`
  const checked = await checkLead(leadOf(r, 'Yoast published its November 2026 SEO update recap', 'The November 2026 SEO Update by Yoast recap'), [], fetchOf(page), 5_000, NOW)
  assert.equal(checked.proof, 'confirmed')
  assert.equal(checked.date_on_page, false)
  assert.equal(checked.date_on_page_field ?? null, null)
  const stored = discoveredLead(checked, NOW.getTime())
  assert.equal(stored.event_date_proof, null)
  assert.notEqual(stored.date_status, 'verified')
})

// Ziggy, #2004: the schema.org SUBTYPES of the allowed types count too, from ONE hierarchy in one place - never a per-site rule.
// NewsArticle is a subtype of Article; ReportageNewsArticle, AnalysisNewsArticle and the rest are subtypes of NewsArticle.
const SUBTYPES: [string, string, string, string][] = [
  ['cbc-ca-news.json', '2026-11-26', 'ReportageNewsArticle.datePublished', 'Canada, news'],
  ['t3n-de-tech-news.json', '2026-11-26', 'AnalysisNewsArticle.datePublished', 'Germany, tech news'],
]
for (const [name, day, field, where] of SUBTYPES) {
  test(`#2004 subtype (${where}): the page's own typed ${field} is the day`, () => {
    const s = structuredDay(html(rec(name)), NOW, false)
    assert.deepEqual([s?.day, s?.field], [day, field])
  })
}

test('#2004 subtype end to end: the CBC proof page dates the lead through ReportageNewsArticle.datePublished', async () => {
  const r = rec('cbc-ca-news.json')
  const quote = 'Data breaches are coming fast and furious'
  const checked = await checkLead(leadOf(r, 'CBC reported on data breaches', quote), [], fetchOf(html(r)), 5_000, NOW)
  assert.equal(checked.proof, 'confirmed')
  assert.equal(checked.date, '2026-11-26')
  assert.equal(checked.date_on_page, true)
  assert.equal(checked.date_on_page_field, 'ReportageNewsArticle.datePublished')
  const stored = discoveredLead(checked, NOW.getTime())
  assert.equal(stored.event_date_proof, 'page_structured')
  assert.match(stored.event_date_proof_note ?? '', /ReportageNewsArticle\.datePublished/)
  assert.equal(eventDayVerified({ event_date: stored.event_date, event_date_proof: stored.event_date_proof, signal: stored.signal }), true)
})

// Controls: a type outside the Article branch of the hierarchy stays held, however it spells its date. The WebPage node below is the
// Yoast page's own, verbatim; the Product node is that same recorded node with only its @type changed.
test('#2004 control: a WebPage with datePublished is not an article', () => {
  const webpage = (JSON.parse(rec('yoast-nl-marketing.json').blocks[0]) as { '@graph': Record<string, unknown>[] })['@graph']
    .filter(n => n['@type'] === 'WebPage')
  assert.equal(webpage.length, 1)
  assert.ok(webpage[0].datePublished)
  assert.equal(structuredDay(`<script type="application/ld+json">${JSON.stringify(webpage[0])}</script>`, NOW, false), null)
})

test('#2004 control: a Product with datePublished is not an article', () => {
  const node = { '@context': 'https://schema.org', '@type': 'Product', name: 'Widget', datePublished: '2026-11-25T14:14:01+00:00' }
  assert.equal(structuredDay(`<script type="application/ld+json">${JSON.stringify(node)}</script>`, NOW, false), null)
})

// #2004/#2068: the page's own markup dates this lead only when it describes this posting. A careers index lists many postings; a page
// can carry another posting's markup in a rail. Either way that markup is not this lead's day.
test('#2004 a typed posting dates the lead only when it is the page\'s only posting and the page names it', () => {
  const one = structuredDay(html(rec('yonovo-us-software.json')), NOW, true)!
  assert.equal(datesThisPosting(one, '', new URL('https://www.yonovo.com/careers/founding-sdr')), true, 'the node names this page')
  assert.equal(datesThisPosting(one, '', new URL('https://www.yonovo.com/careers')), false, 'another page is not this posting')
  const untitled = { ...one, url: null, title: null }
  assert.equal(datesThisPosting(untitled, 'Careers at Yonovo', new URL('https://www.yonovo.com/careers/founding-sdr')), false, 'nothing names the posting')
  const titled = { ...one, url: null }
  assert.equal(datesThisPosting(titled, 'Careers: Founding Sales Development Representative (SDR)', new URL('https://www.yonovo.com/careers')), true, 'the page prints its title')
  assert.equal(datesThisPosting(titled, 'Careers: Bookkeeper', new URL('https://www.yonovo.com/careers')), false, 'a different title is a different posting')
  assert.equal(datesThisPosting({ ...one, postings: 2 }, '', new URL('https://www.yonovo.com/careers/founding-sdr')), false, 'a list of postings dates none of them')
})

test('#2004 the page text, not the markup, decides whether its title is printed', async () => {
  const r = rec('yonovo-us-software.json')
  const node = JSON.stringify({ '@type': 'JobPosting', title: 'Bookkeeper', datePosted: '2026-10-20' })
  const page = `<html><body><p>Fern Dental is hiring a dental receptionist in Toronto.</p><script type="application/ld+json">${node}</script></body></html>`
  const lead = { ...leadOf(r, 'Fern Dental is hiring a dental receptionist in Toronto', 'Fern Dental is hiring a dental receptionist in Toronto'), evidence_url: 'https://ferndental.example/careers/receptionist' }
  const checked = await checkLead(lead, [], fetchOf(page), 5_000, NOW)
  assert.equal(checked.date, null, 'markup about another posting dates nothing')
  assert.equal(checked.date_on_page, false)
})
