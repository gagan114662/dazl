// #379: claim-to-quote binding for seller research. A verbatim quote proves only that its words are on the page; a statement is
// source-backed only when that quote also carries the claim. Synthetic site and model output; stubbed fetch; no network, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { buildResearch, type FetchedPage, type SellerResearch } from '../lib/scan/seller-research.ts'
import { normalizeResearch } from '../lib/scan/icp.ts'
import { icpFromWebsite } from '../lib/scan/icp-from-site.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'

const PRICING = 'Booking starts at $49 per location per month. Payroll is priced per employee for clinics with 10 to 50 staff.'
const CUSTOMERS = 'Case study: Harbor Dental, a four-chair dental practice, cut no-shows with Acme Booking.'
const BOOKING = 'Acme Booking lets practice managers fill their appointment book and send reminders.'
const PAGES: FetchedPage[] = [
  { url: 'https://acme.example/pricing', kind: 'pricing', title: 'Pricing', text: PRICING, fetched_at: 1_800_000_000 },
  { url: 'https://acme.example/customers', kind: 'customers', title: 'Customers', text: CUSTOMERS, fetched_at: 1_800_000_000 },
  { url: 'https://acme.example/products/booking', kind: 'product', title: 'Booking', text: BOOKING, fetched_at: 1_800_000_000 },
]
const item = (kind: string, text: string, url: string, quote: string, inferred = false) => ({ offer: 'o1', kind, text, url, quote, inferred })

test('a real quote next to an invented headcount or place is not evidence: size and location stay unknown', () => {
  const r = buildResearch({ offers: [{ id: 'o1', name: 'Acme Payroll' }], items: [
    item('size', '10,000 employees', PAGES[0].url, 'clinics with 10 to 50 staff'),   // verbatim on the page, wrong number
    item('location', 'Texas', PAGES[0].url, 'clinics with 10 to 50 staff'),          // verbatim on the page, no place in it
  ] }, PAGES, 'acme.example')
  assert.ok(!('error' in r)); if ('error' in r) return
  for (const kind of ['size', 'location']) {
    const h: SellerResearch['hypotheses'][number] = r.hypotheses.find(x => x.kind === kind)!
    assert.deepEqual([h.status, h.text, h.url, h.quote], ['unknown', 'unknown', null, null], kind)
  }
})

test('a quote that carries the claim stays sourced, with its URL and fetch time', () => {
  const r = buildResearch({ offers: [{ id: 'o1', name: 'Acme Payroll' }], items: [
    item('size', '10-50 employees', PAGES[0].url, 'clinics with 10 to 50 staff'),
    item('persona', 'practice managers', PAGES[2].url, 'lets practice managers fill their appointment book'),
    item('industry', 'dental practices', PAGES[1].url, 'Harbor Dental, a four-chair dental practice'),
  ] }, PAGES, 'acme.example')
  assert.ok(!('error' in r)); if ('error' in r) return
  for (const h of r.hypotheses.filter(x => x.kind !== 'offer')) assert.deepEqual([h.status, h.fetched_at], ['sourced', 1_800_000_000], h.text)
  assert.equal(r.hypotheses.find(x => x.kind === 'size')!.text, '10-50 employees')
})

test('a persona whose verbatim quote says nothing about it, or that the model marked inferred, is a hypothesis with no evidence', () => {
  const r = buildResearch({ offers: [{ id: 'o1', name: 'Acme Booking' }], items: [
    item('persona', 'hospital group CFOs', PAGES[1].url, 'Harbor Dental, a four-chair dental practice'),
    item('persona', 'practice managers', PAGES[2].url, 'lets practice managers fill their appointment book', true),
  ] }, PAGES, 'acme.example')
  assert.ok(!('error' in r)); if ('error' in r) return
  for (const t of ['hospital group CFOs', 'practice managers']) {
    const h: SellerResearch['hypotheses'][number] = r.hypotheses.find(x => x.text === t)!
    assert.deepEqual([h.status, h.url, h.quote, h.fetched_at], ['hypothesis', null, null, null], t)
  }
})

test('a stored or client-sent research block is re-checked: an unbacked sourced headcount is dropped, an unbacked persona becomes a hypothesis', () => {
  const hyp = (i: string, k: string, t: string, q: string | null, at: number | null = 1_800_000_000) => ({ i, o: 'acme-payroll', k, t, s: 'sourced', u: 'https://acme.example/pricing', q, at })
  const r = normalizeResearch({ v: 1, site: 'acme.example', offers: [{ i: 'acme-payroll', n: 'Acme Payroll' }], q: null, ans: null, hyps: [
    hyp('h1', 'size', '10,000 employees', 'clinics with 10 to 50 staff'),
    hyp('h2', 'location', 'Texas', 'clinics with 10 to 50 staff'),
    hyp('h3', 'persona', 'hospital group CFOs', 'clinics with 10 to 50 staff'),
    hyp('h4', 'size', '10-50 employees', 'clinics with 10 to 50 staff'),
    hyp('h5', 'persona', 'clinic owners', 'clinics with 10 to 50 staff', null),   // no fetch time: not sourced
  ] })!
  const by = (i: string) => r.hyps.find(h => h.i === i)
  assert.equal(by('h1'), undefined, 'an unbacked headcount is never kept as a statement')
  assert.equal(by('h2'), undefined, 'an unbacked place is never kept as a statement')
  assert.deepEqual(by('h3'), { i: 'h3', o: 'acme-payroll', k: 'persona', t: 'hospital group CFOs', s: 'hypothesis', u: null, q: null, at: null })
  assert.deepEqual([by('h4')!.s, by('h4')!.q, by('h4')!.at], ['sourced', 'clinics with 10 to 50 staff', 1_800_000_000])
  assert.equal(by('h5')!.s, 'hypothesis')
})

test('quoteSupports: numbers must match, places must all be named, other claims need a distinctive word, generic filler never counts', async () => {
  const { quoteSupports } = await import('../lib/scan/claim-quote.ts')
  assert.equal(quoteSupports('size', '10-50 employees', 'clinics with 10 to 50 staff'), true)
  assert.equal(quoteSupports('size', '10,000 employees', 'serves 10,000 employees worldwide'), true)
  assert.equal(quoteSupports('size', '10,000 employees', 'clinics with 10 to 50 staff'), false)
  assert.equal(quoteSupports('location', 'Austin, Texas', 'offices across Texas'), false)
  assert.equal(quoteSupports('location', 'Texas', 'offices across Texas'), true)
  assert.equal(quoteSupports('industry', 'physiotherapy clinics', 'Elm Street Physio runs Acme Booking'), true)
  assert.equal(quoteSupports('industry', 'SaaS companies', 'hair salons and their teams'), false, 'generic filler alone never carries a claim')
  assert.equal(quoteSupports('persona', 'clinic owners', ''), false)
})

// The multi-page read: a research link that redirects back to a page already read is not a second page of evidence.
const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
const HOME = `<html><title>Multi</title><body><h1>${'Multi builds practice software. '.repeat(20)}</h1><a href="/pricing">Pricing</a><a href="/customers">Customers</a></body></html>`
test('icpFromWebsite: a research link that redirects to an already-read page is read once', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-' + 'A'.repeat(40), master)
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.endsWith('/customers')) return html('', 302, { location: 'https://multi.example/' })
    if (url.endsWith('/pricing')) return html(`<html><body>${(PRICING + ' ').repeat(5)}</body></html>`)
    return html(HOME)
  }) as unknown as typeof fetch
  const prompts: string[] = []
  const provider: Provider = { research: async () => { throw new Error('unused') }, complete: async (_k: string, p: string) => { prompts.push(p); return JSON.stringify({ draft: { summary: 'Clinics.', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] } }) } }
  const out = await icpFromWebsite(db, 'A', 'https://multi.example', { master, lookup: pubLookup, fetchImpl, providers: { anthropic: provider } })
  assert.ok('icp' in out, JSON.stringify(out))
  assert.equal(prompts.length, 1)
  assert.deepEqual([...prompts[0].matchAll(/^PAGE \d+ \((\w+)\) (\S+)$/gm)].map(m => [m[1], m[2]]), [['home', 'https://multi.example/'], ['pricing', 'https://multi.example/pricing']])
})
