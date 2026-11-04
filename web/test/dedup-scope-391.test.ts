// #391 owner decisions: in-scan de-duplication keeps same-name companies apart when their domains differ (the domain counts
// only when the SOURCE states it, never inferred from the name); with no domain on either side the name rule stays, but two
// candidates from different countries are never merged; the original quote and its translation are both kept on the lead.
// Synthetic data, in-memory databases, stub pages and stub providers only: no network, no paid call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { AMBIGUOUS_SAME_NAME, AMBIGUOUS_SCOPE, cleanCountry, cleanDomain, domainStated, scopeDedup, type ScopeFacts } from '../lib/scan/dedup-scope.ts'
import { dedupBaseKey, dedupKey } from '../lib/scan/evidence.ts'
import { claimKeyedJob, parseLeads, runJob, verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { translationOf } from '../lib/text/multilingual.ts'
import { fallbackTargets, mergeFallback } from '../lib/scan/blocked-fallback.ts'
import { bothEngines } from './helpers/engines.ts'
import * as S from '../lib/scan/store-db.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'

const today = new Date()
const iso = (d: Date) => d.toISOString().slice(0, 10)
const recent = iso(new Date(today.getTime() - 5 * 86_400_000))

test('cleanDomain: a stated website becomes a bare host; every malformed value is no domain (fail closed to the name rule)', () => {
  assert.equal(cleanDomain('https://www.Acme.io/about?x=1'), 'acme.io')
  assert.equal(cleanDomain(' acme.co.jp. '), 'acme.co.jp')
  for (const bad of [null, undefined, 42, true, ['acme.io'], { host: 'acme.io' }, '', '   ', 'acme', 'acme.io:8080', '127.0.0.1', 'javascript:alert(1)', 'ａｃｍｅ.io', 'acme..io', '-acme.io', 'mailto:x@acme.io', 'x'.repeat(300) + '.io', `${'a'.repeat(64)}.io`, 'acme.io\u0000evil.com'])
    assert.equal(cleanDomain(bad), null, JSON.stringify(bad))
  assert.equal(cleanCountry('jp'), 'JP'); assert.equal(cleanCountry(' AE '), 'AE')
  for (const bad of [null, 1, 'Japan', 'J', '', ['JP'], {}]) assert.equal(cleanCountry(bad), null, JSON.stringify(bad))
})

test('domainStated: the page itself names the host near the company; a host far away, a lookalike host or a malformed page does not count', () => {
  const page = 'Acme Robotics (acme.io) is hiring two account executives in Tokyo. Apply at www.acme.io/careers.'
  assert.equal(domainStated('acme.io', page, 'Acme Robotics'), true)
  assert.equal(domainStated('acme.io', 'Acme Robotics is hiring. Visit https://www.acme.io today.', 'Acme Robotics'), true)
  assert.equal(domainStated('acme.io', `Acme Robotics is hiring account executives.${' filler'.repeat(80)} Our partner list: acme.io`, 'Acme Robotics'), false, 'far from the company')
  assert.equal(domainStated('acme.io', 'Acme Robotics is hiring. See notacme.io and acme.io.evil.com', 'Acme Robotics'), false, 'only lookalike hosts')
  assert.equal(domainStated('acme.io', 'Acme Robotics is hiring. Mail jobs@acme.io', 'Acme Robotics'), false, 'an email address is not a stated website')
  assert.equal(domainStated('acme.io', page, 'Beta Corp'), false, 'another company')
  for (const bad of [null, 7, ['acme.io'], { text: page }, '']) assert.equal(domainStated('acme.io', bad, 'Acme Robotics'), false)
  assert.equal(domainStated('not a host', page, 'Acme Robotics'), false)
  assert.equal(domainStated('acme.io', page, '株式会社'), false, 'a company key of under 2 characters never binds')
})

const f = (company: string, o: Partial<ScopeFacts> = {}): ScopeFacts => ({ company, name: '', ...o })
test('scopeDedup: different stated domains split; the same domain, or no domain in one country, keeps today\'s key; unknowns in a split group are ambiguous', () => {
  const a = f('Acme', { dedup_domain: 'acme.jp' }), b = f('Acme Inc', { dedup_domain: 'acme.ae' }), c = f('acme', { dedup_domain: 'acme.jp' })
  scopeDedup([a, b, c])
  assert.deepEqual([dedupKey(a), dedupKey(b), dedupKey(c)], ['acme@acme.jp', 'acme@acme.ae', 'acme@acme.jp'])
  const same = [f('Acme', { dedup_domain: 'acme.io' }), f('Acme Ltd', { dedup_domain: 'acme.io' })]; scopeDedup(same)
  assert.deepEqual(same.map(dedupKey), ['acme', 'acme'], 'one domain: today\'s key, no suffix')
  const oneSide = [f('Acme', { dedup_domain: 'acme.io' }), f('Acme')]; scopeDedup(oneSide)
  assert.deepEqual(oneSide.map(dedupKey), ['acme', 'acme'], 'a domain on one side only is not a conflict (today\'s name rule)')
  const countries = [f('Acme', { dedup_country: 'JP' }), f('Acme', { dedup_country: 'AE' }), f('Acme', { dedup_country: 'JP' })]; scopeDedup(countries)
  assert.deepEqual(countries.map(dedupKey), ['acme#JP', 'acme#AE', 'acme#JP'], 'no domain on either side: never merged across countries')
  const oneCountry = [f('Acme', { dedup_country: 'JP' }), f('Acme')]; scopeDedup(oneCountry)
  assert.deepEqual(oneCountry.map(dedupKey), ['acme', 'acme'], 'an unknown country does not conflict')
  const domainVsCountry = [f('Acme', { dedup_domain: 'acme.io', dedup_country: 'JP' }), f('Acme', { dedup_country: 'AE' })]; scopeDedup(domainVsCountry)
  assert.deepEqual(domainVsCountry.map(dedupKey), ['acme@acme.io', 'acme#AE'], 'a domain on one side and two different countries: kept apart')
  const ambiguous = [f('Acme', { dedup_domain: 'acme.jp' }), f('Acme', { dedup_domain: 'acme.ae' }), f('Acme')]; scopeDedup(ambiguous)
  assert.equal(ambiguous[2].dedup_scope, AMBIGUOUS_SCOPE, 'neither a domain nor a country in a split group: ambiguous, never merged into one side')
  const other = [f('Beta', { dedup_domain: 'beta.io' }), f('Gamma', { dedup_domain: 'gamma.io' })]; scopeDedup(other)
  assert.deepEqual(other.map(dedupKey), ['beta', 'gamma'], 'different names: untouched')
  // malformed facts are no facts: wrong types, a host with a path, a lowercase-invalid country
  const junk = [f('Acme', { dedup_domain: 123 as never, dedup_country: ['JP'] as never }), f('Acme', { dedup_domain: 'acme.io/x y' as never, dedup_country: 'Japan' })]; scopeDedup(junk)
  assert.deepEqual(junk.map(dedupKey), ['acme', 'acme'])
  // a stale scope from an earlier pass is cleared when the group no longer needs a split
  const stale = [f('Acme', { dedup_scope: '@old.io' })]; scopeDedup(stale); assert.equal(dedupKey(stale[0]), 'acme')
})

test('scopeDedup with prior rows: a later candidate that conflicts with a kept row is scoped apart, one that matches a split row joins it', () => {
  const kept = f('Acme', {}) // decided earlier with today's key
  const late = f('Acme', { dedup_domain: 'acme.ae', dedup_country: 'AE' })
  const keptJp = f('Acme', { dedup_country: 'JP' })
  scopeDedup([late], [kept, keptJp])
  assert.equal(dedupKey(late), 'acme@acme.ae', 'conflicts with the JP row: never merged into the kept row')
  assert.equal(dedupKey(kept), 'acme', 'prior rows keep their key')
  const split = [f('Acme', { dedup_domain: 'acme.jp', dedup_scope: '@acme.jp' }), f('Acme', { dedup_domain: 'acme.ae', dedup_scope: '@acme.ae' })]
  const again = f('Acme', { dedup_domain: 'acme.jp' }), unknown = f('Acme')
  scopeDedup([again, unknown], split)
  assert.equal(dedupKey(again), 'acme@acme.jp'); assert.equal(unknown.dedup_scope, AMBIGUOUS_SCOPE)
  const noConflict = f('Acme'); scopeDedup([noConflict], [f('Acme')]); assert.equal(dedupKey(noConflict), 'acme')
})

test('dedupKey: no scope is today\'s key; a non-string scope is ignored; the base key never carries the scope', () => {
  assert.equal(dedupKey({ company: 'Acme Inc', name: '' }), 'acme')
  assert.equal(dedupKey({ company: '', name: 'Pat Lee' }), 'pat lee')
  assert.equal(dedupKey({ company: 'Acme', name: '', dedup_scope: 7 as never }), 'acme')
  assert.equal(dedupKey({ company: 'Acme', name: '', dedup_scope: '' }), 'acme')
  assert.equal(dedupBaseKey({ company: 'Acme', name: '', dedup_scope: '@acme.io' } as never), 'acme')
})

test('parseLeads: the stated website is parsed and cleaned; the model can never set the identity scope or the proven domain itself', () => {
  const urls = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4']
  const out = parseLeads(JSON.stringify([
    { company: 'Acme', signal: 's', source_url: urls[0], excerpt: 'Acme is hiring', website: 'https://www.acme.io/', dedup_scope: '@x', dedup_domain: 'evil.io', dedup_country: 'JP' },
    { company: 'Acme', signal: 's', source_url: urls[1], excerpt: 'Acme is hiring', company_domain: 'acme.ae' },
    { company: 'Acme', signal: 's', source_url: urls[2], excerpt: 'Acme is hiring', website: ['acme.io'] },
    { company: 'Acme', signal: 's', source_url: urls[3], excerpt: 'Acme is hiring', website: 'not a domain' },
  ]), urls)!
  assert.deepEqual(out.map(l => l.website ?? null), ['acme.io', 'acme.ae', null, null])
  for (const l of out) { assert.equal('dedup_scope' in l, false); assert.equal('dedup_domain' in l, false); assert.equal('dedup_country' in l, false) }
})

// ---- the verifier: identity decided from what the fetched pages state ----------------------------------------------
const PAGE = (company: string, host: string | null, place: string) =>
  `${company} is hiring two account executives in ${place} this month to grow its sales team.${host ? ` Learn more at ${host}.` : ''} Applications are open now.`
const cand = (url: string, company: string, o: Partial<LeadDraft> = {}): LeadDraft => ({ name: '', company, contact: null, signal: `${company} is hiring account executives`, source_url: url, score: 70, excerpt: `${company} is hiring two account executives`, event_date: null, ...o })
function pages(map: Record<string, string>) { return async (u: string) => map[u] ? { text: map[u], title: 'Careers', retrievedAt: Math.floor(Date.now() / 1000) } : null }

test('verifyLeads: same name, different stated domains stay two leads; same domain stays one; a website the page does not state is ignored', async () => {
  const p = pages({ 'https://jp.example/a': PAGE('Acme', 'acme.jp', 'Tokyo'), 'https://ae.example/a': PAGE('Acme', 'acme.ae', 'Dubai'), 'https://news.example/a': PAGE('Acme', 'acme.jp', 'Osaka'), 'https://blog.example/a': PAGE('Acme', null, 'Kyoto') })
  const two = await verifyLeads([cand('https://jp.example/a', 'Acme', { website: 'acme.jp' }), cand('https://ae.example/a', 'Acme', { website: 'acme.ae' })], p, today)
  assert.deepEqual(two.leads.map(dedupKey).sort(), ['acme@acme.ae', 'acme@acme.jp'])
  assert.equal(two.dropped.duplicate ?? 0, 0)
  const one = await verifyLeads([cand('https://jp.example/a', 'Acme', { website: 'acme.jp' }), cand('https://news.example/a', 'Acme', { website: 'https://acme.jp' })], p, today)
  assert.deepEqual(one.leads.map(dedupKey), ['acme']); assert.equal(one.dropped.duplicate, 1)
  // the model claims a second domain that its page never states: not a source-stated domain, so today's name rule merges them
  const claimed = await verifyLeads([cand('https://jp.example/a', 'Acme', { website: 'acme.jp' }), cand('https://blog.example/a', 'Acme', { website: 'acme-kyoto.jp' })], p, today)
  assert.deepEqual(claimed.leads.map(dedupKey), ['acme'])
  // the original bug: before #391 every same-name pair collapsed; without any stated domain it still does (the base rule is unchanged)
  const before = await verifyLeads([cand('https://jp.example/a', 'Acme'), cand('https://ae.example/a', 'Acme')], p, today)
  assert.equal(before.leads.length, 1)
})

test('verifyLeads: no domain on either side never merges across countries; one country merges; an unplaceable third goes to review, never merged', async () => {
  const p = pages({ 'https://jp.example/a': PAGE('Acme', null, 'Tokyo'), 'https://ae.example/a': PAGE('Acme', null, 'Dubai'), 'https://jp.example/b': PAGE('Acme', null, 'Osaka'), 'https://x.example/a': PAGE('Acme', null, 'somewhere') })
  const two = await verifyLeads([cand('https://jp.example/a', 'Acme', { dedup_country: 'JP' }), cand('https://ae.example/a', 'Acme', { dedup_country: 'AE' })], p, today)
  assert.deepEqual(two.leads.map(dedupKey).sort(), ['acme#AE', 'acme#JP'])
  const one = await verifyLeads([cand('https://jp.example/a', 'Acme', { dedup_country: 'JP' }), cand('https://jp.example/b', 'Acme', { dedup_country: 'JP' })], p, today)
  assert.deepEqual(one.leads.map(dedupKey), ['acme'])
  const audit: never[] = []
  const three = await verifyLeads([cand('https://jp.example/a', 'Acme', { dedup_country: 'JP' }), cand('https://ae.example/a', 'Acme', { dedup_country: 'AE' }), cand('https://x.example/a', 'Acme')], p, today, undefined, null, undefined, audit)
  assert.equal(three.leads.length, 2)
  assert.deepEqual(three.review.map(r => [dedupKey(r), r.review_reason]), [[`acme${AMBIGUOUS_SCOPE}`, AMBIGUOUS_SAME_NAME]])
  assert.ok((audit as { reason: string | null }[]).some(a => a.reason === AMBIGUOUS_SAME_NAME), 'the hold is recorded in the run audit')
  // a candidate whose page cannot be read keeps its own outcome (no crash, recorded as dropped)
  const gone = await verifyLeads([cand('https://jp.example/a', 'Acme', { website: 'acme.jp' }), cand('https://missing.example/a', 'Acme', { website: 'acme.ae' })], p, today)
  assert.deepEqual(gone.leads.map(dedupKey), ['acme']); assert.equal(gone.dropped.page_unreachable, 1)
  // a page fetch that throws is a vanished resource, not an escaped exception
  const boom = await verifyLeads([cand('https://jp.example/a', 'Acme', { website: 'acme.jp' })], async () => { throw Object.assign(new Error('x'), { errno: undefined }) }, today)
  assert.equal(boom.leads.length, 0); assert.equal(boom.dropped.page_unreachable, 1)
})

test('blocked-company recovery targets the held row by its scoped key: a rescue never lands on a same-name company kept apart', () => {
  const heldJp = { company: 'Acme', name: '', signal: 'raised a seed round', source_url: 'https://jp.example/blocked', review_reason: 'blocked_by_site', dedup_scope: '@acme.jp' }
  const t = fallbackTargets([heldJp], ['Tokyo'])
  assert.equal(t[0].key, 'acme@acme.jp')
  const outcome = { leads: [{ company: 'Acme', name: '', source_url: 'https://ae.example/a', dedup_scope: '@acme.ae' }], review: [heldJp], dropped: {} }
  const wrong = mergeFallback(outcome as never, { leads: [{ company: 'Acme', name: '', source_url: 'https://press.example/ae', dedup_scope: '@acme.ae' }], dropped: {} } as never, t)
  assert.equal(wrong.length, 0, 'the Dubai company is not the held Tokyo row')
  const right = mergeFallback(outcome as never, { leads: [{ company: 'Acme', name: '', source_url: 'https://press.example/jp', dedup_scope: '@acme.jp' }], dropped: {} } as never, t)
  assert.equal(right.length, 1); assert.equal(outcome.review.length, 0)
})

test('translationOf: kept only as a string that differs from the stored original; every malformed value is dropped', () => {
  assert.equal(translationOf({ excerpt: 'ソフトバンクは採用します', excerpt_translation: 'SoftBank is hiring' }), 'SoftBank is hiring')
  assert.equal(translationOf({ excerpt: 'ソフトバンクは採用します', excerpt_translation: 'x'.repeat(5000) })!.length, 400)
  assert.equal(translationOf({ excerpt: 'q', excerpt_translation: 'line\u0000one\nline' }), 'line one line')
  for (const bad of [null, undefined, 7, ['t'], { t: 1 }, true, '', '   ']) assert.equal(translationOf({ excerpt: 'ソフトバンク', excerpt_translation: bad }), null, JSON.stringify(bad))
  assert.equal(translationOf({ excerpt: 'Acme is hiring', excerpt_translation: 'ACME is hiring' }), null, 'a "translation" equal to the original is not one')
  assert.equal(translationOf({ excerpt: null, excerpt_translation: 'orphan' }), null, 'no stored quote: no gloss')
  assert.equal(translationOf({ excerpt: 5, excerpt_translation: 'orphan' }), null)
})

// ---- storage: the Db-layer finish (both engines) stores the gloss beside the original, the generated schema caps it ----
bothEngines('finishJob stores evidence_translation beside the original quote on lead and review rows; malformed glosses store NULL; the column caps at 400', async ({ db }) => {
  const A = 'a'.repeat(32), T0 = 1_800_000_000
  const id = await S.createJob(db, A, { business_name: 'Biz', industry: 'software', location: 'Tokyo' }, null, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [T0, id])
  const L = (key: string, o: Partial<S.LeadRow> = {}): S.LeadRow => ({ name: '', company: `Co ${key}`, contact: null, signal: 'Hiring', source_url: `https://e.example/${key}`, score: 70, evidence_excerpt: 'ソフトバンクは採用します', event_date: null, date_status: 'undated', retrieved_at: T0, confidence: 70, dedup_key: key, ...o })
  const r = await S.finishJob(db, { id, attempts: 1 }, { status: 'done', error: null, now: T0 + 1,
    leads: [L('k1', { evidence_translation: 'SoftBank is hiring' }), L('k2', { evidence_translation: 42 as never }), L('k3')],
    review: [{ name: '', company: 'Rev', signal: 's', source_url: 'https://r.example/1', score: 40, evidence_excerpt: 'أرامكو توظف', event_date: null, dedup_key: 'review:rev', review_reason: AMBIGUOUS_SAME_NAME, evidence_translation: 'Aramco is hiring' }] })
  assert.equal(r.owned, true)
  const rows = await db.all<{ dedup_key: string; evidence_excerpt: string; evidence_translation: string | null }>('SELECT dedup_key, evidence_excerpt, evidence_translation FROM leads ORDER BY dedup_key')
  assert.deepEqual(rows.map(x => [x.dedup_key, x.evidence_translation]), [['k1', 'SoftBank is hiring'], ['k2', null], ['k3', null], ['review:rev', 'Aramco is hiring']])
  const listed = await S.listLeads(db, A, id, 200, true) as { dedup_key?: string; evidence_translation: string | null; evidence_excerpt: string }[]
  assert.ok(listed.some(l => l.evidence_translation === 'SoftBank is hiring' && l.evidence_excerpt === 'ソフトバンクは採用します'), 'the lead read returns the original and the gloss')
  await assert.rejects(db.run('UPDATE leads SET evidence_translation = ? WHERE dedup_key = ?', ['x'.repeat(401), 'k1']), 'the column refuses an over-long gloss')
})

// ---- end to end: one scan, two markets, two different companies both called Acme -----------------------------------
const master = randomBytes(32)
test('one multi-market scan: "Acme" in Tokyo and "Acme" in Dubai stay two leads (stored dedup_key per country), each with its original quote and translation', async () => {
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', '«redacted:sk-…»', master)
  const ja = 'Acmeは東京本社で法人営業マネージャーを3名募集すると発表しました', ar = 'أعلنت Acme عن توظيف مدير مبيعات إقليمي جديد في مكتب دبي'
  const PAGES: Record<string, { country: string; title: string; text: string; lead: Record<string, unknown> }> = {
    'https://jp.example/acme-jobs': { country: 'JP', title: 'Acme 採用情報', text: `${ja}。応募は採用ページから受け付けます。`, lead: { company: 'Acme', excerpt: ja, excerpt_en: 'Acme is hiring three corporate sales managers in Tokyo' } },
    'https://ae.example/acme-jobs': { country: 'AE', title: 'Acme وظائف', text: `${ar}. التقديم متاح عبر الموقع الرسمي للشركة.`, lead: { company: 'Acme', excerpt: ar, excerpt_en: 'Acme is hiring a regional sales manager in Dubai' } },
  }
  for (const [url, p] of Object.entries(PAGES)) Object.assign(p.lead, { name: '', contact: null, signal: 'Hiring a sales manager', source_url: url, event_date: null, score: 80 })
  const markets = [{ where: '東京', country: 'JP', language: 'ja' }, { where: 'Dubai', country: 'AE', language: 'ar' }]
  const icp = { summary: 'companies hiring sales managers in Tokyo and Dubai', who: ['Head of Sales'], industries: ['SaaS'], sizes: [], where: ['東京', 'Dubai'], signals: ['hiring a sales manager'], exclude: [], markets }
  const jobId = createQueryJob(db, 'A', { query: 'companies hiring sales managers in 東京 and Dubai', icp: JSON.stringify(icp) })
  const job = claimKeyedJob(db)!
  const realFetch = globalThis.fetch
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      const sp = new URL(u).searchParams
      if ((sp.get('query') ?? '').startsWith('site:linkedin.com/in ')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      const results = Object.entries(PAGES).filter(([, p]) => p.country === sp.get('location')).map(([url, p]) => ({ url, title: p.title, snippet: p.text.slice(0, 120), date: recent }))
      return new Response(JSON.stringify({ results }), { status: 200 })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
      return new Response(JSON.stringify({ results: urls.filter(x => PAGES[x]).map(x => ({ url: x, title: PAGES[x].title, text: PAGES[x].text })) }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: '', citedUrls: [] }),
      complete: async (_k: string, _p: string, _f?: typeof fetch, maxTokens?: number) => maxTokens === 300
        ? JSON.stringify(['営業マネージャー 採用 東京', 'شركات توظف مدير مبيعات'])
        : JSON.stringify(Object.values(PAGES).map(p => p.lead)),
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async (url: string) => PAGES[url] ? { text: PAGES[url].text, title: PAGES[url].title, retrievedAt: Math.floor(Date.now() / 1000) } : null
  globalThis.fetch = fetchImpl
  try {
    assert.equal(await runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, judge: null }), 'done')
  } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
  const rows = db.prepare('SELECT company, dedup_key, evidence_excerpt, evidence_translation, review_reason FROM leads ORDER BY dedup_key').all() as { company: string; dedup_key: string; evidence_excerpt: string; evidence_translation: string | null; review_reason: string | null }[]
  assert.deepEqual(rows.map(r => r.dedup_key.replace(/^review:/, '')), ['acme#AE', 'acme#JP'], JSON.stringify(rows))
  for (const r of rows) {
    const p = Object.values(PAGES).find(x => x.lead.excerpt === r.evidence_excerpt)
    assert.ok(p, 'the stored quote is the ORIGINAL-language passage')
    assert.equal(r.evidence_translation, p!.lead.excerpt_en, 'the translation is stored beside it')
  }
  const listed = listLeads(db, 'A', String(jobId), 200, true) as { evidence_translation: string | null }[]
  assert.equal(listed.filter(l => l.evidence_translation).length, 2, 'the leads read returns the translation for the card')
})
