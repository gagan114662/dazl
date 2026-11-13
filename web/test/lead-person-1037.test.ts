// #1037: every ready lead names the person to contact (name, title, LinkedIn or source) on the row itself, including on
// the first play (first5) and free-trial scans, or says "No buyer named yet". TEST-ONLY fixtures: invented companies and
// people, TinyFish stubbed, no network, no paid call, no LinkedIn access.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { leadPerson, leadPersonLine, NO_BUYER } from '../lib/people/lead-person.ts'
import { tiedLabel } from '../lib/people/company-tie.ts'
import { LABEL, findPeople, firstPlayPeopleCap, peopleTraceMessage, peopleTraceStatus, FIRST_PLAY_MAX, MAX_COMPANIES } from '../lib/people/people-search.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { migrateTinyfish, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'

// A search result row as the search stores it now: its label says what tied it to the company beyond the name.
const P = (value: string, source_url: string, connector = 'search:people', kind = 'person') => ({ kind, value, label: connector === 'search:people' ? tiedLabel(LABEL, 'place') : 'x', source_url, connector })
const LI = 'https://www.linkedin.com/in/jane-doe-1'

// ---- the row rule (lib/people/lead-person.ts) ----
test('row: a role-matching person with a LinkedIn profile is named with title and link, labelled search result', () => {
  const p = leadPerson([P('Jane Doe, Head of Sales', LI)], 'Head of Sales; VP Sales')
  assert.deepEqual(p, { name: 'Jane Doe', title: 'Head of Sales', linkedin: LI, source: null, via: 'a public LinkedIn search result (not verified as current)', current: false })
  assert.equal(leadPersonLine(p), 'Jane Doe · Head of Sales')
  assert.equal(leadPersonLine(null), NO_BUYER); assert.equal(NO_BUYER, 'No buyer named yet')
})

test('row: a site-listed person keeps its source page as the link; the best title match wins', () => {
  const p = leadPerson([P('Al Weak, Sales Associate', 'https://acme.example/team', 'sitecrawl'), P('Bo Strong, VP Sales', 'https://acme.example/team', 'sitecrawl')], 'VP Sales')
  assert.equal(p?.name, 'Bo Strong'); assert.equal(p?.linkedin, null); assert.equal(p?.source, 'https://acme.example/team')
})

test('row fails closed: historical, contradicted, off-role, untitled, non-names and unlinked rows never become the person', () => {
  const roles = 'Head of Sales'
  const cases: [string, unknown[]][] = [
    ['SEC Form D officer (historical)', [P('Jane Doe, Head of Sales', 'https://sec.example/f', 'signals:sec-form-d')]],
    ['former role', [P('Jane Doe, Former Head of Sales', LI)]],
    ['assistant to the role', [P('Jane Doe, Assistant to the Head of Sales', LI)]],
    ['ended by date', [P('Jane Doe, Head of Sales (2019 - 2021)', LI)]],
    ['no title', [P('Jane Doe', LI)]],
    ['empty title', [P('Jane Doe, ', LI)]],
    ['single name', [P('Jane, Head of Sales', LI)]],
    ['an email as the name', [P('jane@acme.example, Head of Sales', LI)]],
    ['digits in the name', [P('Jane D0e 2, Head of Sales', LI)]],
    ['a URL as the name', [P('https://x.example, Head of Sales', LI)]],
    ['no link at all', [P('Jane Doe, Head of Sales', '')]],
    ['javascript: link', [P('Jane Doe, Head of Sales', 'javascript:alert(1)')]],
    ['data: link', [P('Jane Doe, Head of Sales', 'data:text/html,hi')]],
    ['a non-people kind', [{ kind: 'email', value: 'Jane Doe, Head of Sales', label: null, source_url: LI, connector: 'sitecrawl' }]],
    ['huge title', [P(`Jane Doe, Head of Sales ${'x'.repeat(200)}`, LI)]],
  ]
  for (const [why, rows] of cases) assert.equal(leadPerson(rows, roles), null, why)
})

test('row: malformed input of every shape returns null (or skips the bad row) and never throws', () => {
  const good = P('Jane Doe, Head of Sales', LI)
  for (const rows of [null, undefined, 5, 'Jane Doe', {}, { length: 3 }, true, [null], [5], ['x'], [[good]], [{}], [{ kind: 'person' }], [{ kind: 'person', value: 7, source_url: LI }],
    [{ kind: 'person', value: { a: 1 }, source_url: LI }], [{ kind: ['person'], value: 'Jane Doe, Head of Sales', source_url: LI }], [{ kind: 'person', value: 'Jane Doe, Head of Sales', source_url: 42 }],
    [{ kind: 'person', value: 'x'.repeat(5000), source_url: LI }], [{ kind: 'person', value: '\uFFFD\uD800 bad, Head of Sales', source_url: LI }]])
    assert.equal(leadPerson(rows as unknown, 'Head of Sales'), null, JSON.stringify(rows)?.slice(0, 80))
  // bad rows around a good one: the good one is still found
  assert.equal(leadPerson([null, 5, { kind: 'person', value: 9 }, good, 'x'], 'Head of Sales')?.name, 'Jane Doe')
  // icp text of the wrong type is treated as no roles (any titled person), never a crash
  for (const icp of [null, 5, {}, ['Head of Sales'], undefined]) assert.equal(leadPerson([good], icp)?.name, 'Jane Doe')
  // a non-finite clock does not throw
  assert.equal(leadPerson([good], 'Head of Sales', Number.NaN)?.name, 'Jane Doe')
  // a getter that throws on a row is contained
  const evil = { get kind() { throw new Error('boom') } }
  assert.equal(leadPerson([evil], 'Head of Sales'), null)
})

test('row: the best buyer-role match is named first; an off-role titled person is only named when nobody better is stored; contradicted ones never', () => {
  assert.equal(leadPerson([P('Sam Roe, Software Engineer', 'https://www.linkedin.com/in/sam-roe'), P('Jane Doe, VP Sales', LI)], 'Head of Sales; VP Sales')?.name, 'Jane Doe')
  assert.equal(leadPerson([P('Omar Haddad, Co-founder', 'https://www.linkedin.com/in/omar-h')], 'Founder')?.title, 'Co-founder')
  assert.equal(leadPerson([P('Jane Doe, Software Engineer', LI)], '')?.name, 'Jane Doe')
  assert.equal(leadPerson([P('Jane Doe, Former CEO', LI)], ''), null)
})

// ---- the first-play people pass (lib/people/people-search.ts) ----
// The request names a place and every result names it: a company NAME alone no longer ties a result to a lead (company-tie.ts).
const ICP = { summary: 's', who: ['Head of Sales'], industries: [], sizes: [], where: ['Ohio'], signals: [], exclude: [], country: 'US', language: 'en' }
const env = { TINYFISH_API_KEY: 'k', TINYFISH_TENANT_DAILY: '500', TINYFISH_PER_MINUTE: '500' }
function setup(n: number) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateTinyfish(db); resetTinyfishState()
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
  for (let i = 0; i < n; i++) ins.run(`L${i}`, job, `Company${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)} Labs`, null, 's', `https://news.example.test/${i}`, 'e', 90, 100 - i)
  return { db, job }
}
// Answers each profile search with one matching person for the company named in the query.
function stub() {
  const queries: string[] = []
  const f = (async (u: string) => {
    const q = new URL(u).searchParams.get('query') ?? ''; queries.push(q)
    const company = /"([^"]+)"/.exec(q)?.[1] ?? 'x'
    return new Response(JSON.stringify({ results: [{ url: `https://www.linkedin.com/in/pat-lee-${queries.length}`, title: `Pat Lee - Head of Sales - ${company} | LinkedIn`, snippet: 'Columbus, Ohio, United States · Head of Sales' }] }))
  }) as unknown as typeof fetch
  return { f, queries }
}

test('first play: one search per lead, capped at maxCompanies; every searched lead then names its person', async () => {
  const { db, job } = setup(14); const s = stub()
  const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true })
  assert.equal(s.queries.length, 10); assert.equal(n, 10)
  const named = (db.prepare("SELECT count(DISTINCT lead_id) AS c FROM lead_enrichments WHERE kind = 'person'").get() as { c: number }).c
  assert.equal(named, 10)
  const rows = db.prepare("SELECT kind, value, label, source_url, connector FROM lead_enrichments WHERE lead_id = 'L0'").all()
  assert.match(leadPersonLine(leadPerson(rows, 'Head of Sales')), /^Pat Lee · Head of Sales$/)
})

test('first play cap is clamped: above FIRST_PLAY_MAX -> FIRST_PLAY_MAX; zero, negative, fractional, NaN, Infinity -> no search', async () => {
  { const { db, job } = setup(14); const s = stub(); await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 50, skipNamed: true }); assert.equal(s.queries.length, FIRST_PLAY_MAX) }
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number, null as unknown as number]) {
    const { db, job } = setup(3); const s = stub()
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: bad, skipNamed: true }), 0, String(bad)); assert.equal(s.queries.length, 0, String(bad))
  }
  // the ordinary (non-first-play) pass keeps its own cap
  { const { db, job } = setup(14); const s = stub(); await findPeople(db, 'A', job, { env, fetchImpl: s.f }); assert.equal(s.queries.length, MAX_COMPANIES) }
})

test('first play skips a lead that already names its person, but still searches one whose only person is historical or former', async () => {
  const { db, job } = setup(3); const s = stub()
  addEnrichment(db, 'A', 'L0', { connector: 'sitecrawl', kind: 'person', value: 'Ana Ruiz, Head of Sales', label: 'site', confidence: null, source_url: 'https://companyaa.example/team', source_date: daysAgo(1), retrieved_at: Math.floor(Date.now() / 1000) })
  addEnrichment(db, 'A', 'L1', { connector: 'signals:sec-form-d', kind: 'person', value: 'Old Officer, Head of Sales', label: 'sec', confidence: null, source_url: 'https://sec.example/x', source_date: daysAgo(400), retrieved_at: Math.floor(Date.now() / 1000) })
  addEnrichment(db, 'A', 'L2', { connector: 'search:people', kind: 'person', value: 'Ex Person, Former Head of Sales', label: 'x', confidence: null, source_url: 'https://www.linkedin.com/in/ex-person', source_date: daysAgo(1), retrieved_at: Math.floor(Date.now() / 1000) })
  await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true })
  assert.equal(s.queries.length, 2); assert.ok(!s.queries.some(q => q.includes('CompanyAA')), 'no search spent on the already-named lead')
})

test('first play: another tenant\'s person row does not count as naming the lead (tenant-scoped read)', async () => {
  const { db, job } = setup(1); const s = stub()
  addEnrichment(db, 'B', 'L0', { connector: 'search:people', kind: 'person', value: 'Other Tenant, Head of Sales', label: 'x', confidence: null, source_url: 'https://www.linkedin.com/in/other-tenant', source_date: daysAgo(1), retrieved_at: Math.floor(Date.now() / 1000) })
  await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true })
  assert.equal(s.queries.length, 1)
})

test('another tenant cannot run the pass on this job: no search, nothing stored', async () => {
  const { db, job } = setup(3); const s = stub()
  assert.equal(await findPeople(db, 'B', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true }), 0); assert.equal(s.queries.length, 0)
})

test('budget: canSearch=false stops before any search and says why; charge runs once per search; a charge refusal stops the pass without throwing', async () => {
  { const { db, job } = setup(3); const s = stub(); const why: string[] = []
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true, canSearch: () => false, onStop: w => why.push(w) }), 0)
    assert.equal(s.queries.length, 0); assert.deepEqual(why, ['budget_kept']) }
  { const { db, job } = setup(3); const s = stub(); let charged = 0
    await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true, charge: async k => { assert.equal(k, 'search'); charged++ } })
    assert.equal(charged, 3); assert.equal(s.queries.length, 3) }
  { const { db, job } = setup(3); const s = stub(); let calls = 0; const why: string[] = []
    const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true, onStop: w => why.push(w), charge: async () => { if (++calls === 2) throw new Error('spend_refused:trial_budget') } })
    assert.equal(n, 1, 'the person stored before the refusal is kept and counted'); assert.equal(s.queries.length, 1, 'no search after the refusal'); assert.deepEqual(why, ['error']) }
})

test('provider failures: an auth / quota answer stops the pass and records why; a malformed body is skipped; never throws', async () => {
  { const { db, job } = setup(3); const why: string[] = []
    const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: f, maxCompanies: 10, skipNamed: true, onStop: w => why.push(w) }), 0); assert.ok(why.length <= 1) }
  { const { db, job } = setup(2)
    const f = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: f, maxCompanies: 10, skipNamed: true }), 0) }
  { const { db, job } = setup(2)
    const f = (async () => new Response(JSON.stringify({ results: [{ url: 5, title: null }, null, 'x', { url: LI, title: { a: 1 } }] }), { status: 200 })) as unknown as typeof fetch
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: f, maxCompanies: 10, skipNamed: true }), 0) }
  { const { db, job } = setup(2); db.prepare('UPDATE scan_jobs SET icp = ?').run('{not json')
    const s = stub(); assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true }), 0); assert.equal(s.queries.length, 0) }
})

test('operator setting DAZL_FIRST_PLAY_PEOPLE_SEARCHES: default 10, can only lower it, anything malformed is 0 (off)', () => {
  const cases: [string | undefined, number][] = [[undefined, 10], ['', 10], ['  ', 10], ['3', 3], [' 5 ', 5], ['0', 0], ['10', 10], ['50', 10], ['999', 10], ['-1', 0], ['abc', 0], ['1e3', 0], ['2.5', 0], ['0x5', 0], ['1000', 0], ['\u0663', 0]]
  for (const [v, want] of cases) assert.equal(firstPlayPeopleCap(v === undefined ? {} : { DAZL_FIRST_PLAY_PEOPLE_SEARCHES: v }), want, String(v))
})

// ---- through the real runJob: the first play (first5) and a free-trial scan run the people step ----
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const RICP = { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const QUOTE = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const page = { title: 'Brightloop raises seed round', text: `On ${daysAgo(12)}, ${QUOTE}. ${'More about the company and its people. '.repeat(15)}` }
const FIRST5 = JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false })
const gdelt = JSON.stringify({ articles: [{ url: NEWS, title: page.title, seendate: '20261016T100000Z' }] })
function fx(over: Partial<Fixture>, people: string[], found = true, peopleStatus = 200): Fixture {
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const s = String(u)
    if (s.startsWith('https://api.search.tinyfish.ai') && (new URL(s).searchParams.get('query') ?? '').startsWith('site:linkedin.com/in ')) {
      people.push(new URL(s).searchParams.get('query')!)
      if (peopleStatus !== 200) return new Response('{}', { status: peopleStatus })
      return new Response(JSON.stringify({ results: !found ? [] : [{ url: 'https://uk.linkedin.com/in/jane-doe-bl', title: 'Jane Doe - Founder - Brightloop | LinkedIn', snippet: 'London, England, United Kingdom - Founder - Brightloop' }] }), { status: 200 })
    }
    return globalThis.fetch(u, init)
  }) as typeof fetch
  return { request: REQUEST, modelIcp: RICP, modelQueries: ['London SaaS startup seed round'], hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page },
    extraction: [{ company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: QUOTE, event_date: daysAgo(12) }], runBudget: FIRST5, deps: { newsHttp: async () => ({ status: 200, body: gdelt }), fetchImpl }, ...over }
}
async function withEnv<T>(e: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(e).map(k => [k, process.env[k]]))
  Object.assign(process.env, e)
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const stage = (r: Awaited<ReturnType<typeof runFixture>>) => {
  const rep = JSON.parse((r.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { enrichment: { stage: string; status: string; reason: string | null; detail?: Record<string, unknown> }[] }
  return rep.enrichment.find(x => x.stage === 'people_search')
}
const rowPerson = (r: Awaited<ReturnType<typeof runFixture>>) => {
  const l = r.db.prepare("SELECT id FROM leads WHERE company = 'Brightloop' AND review_reason IS NULL").get() as { id: string } | undefined
  assert.ok(l, 'the verified lead exists')
  return leadPerson(r.db.prepare('SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(l!.id), 'Founder')
}

test('THE FIRST PLAY (first5): people_search runs (ok, not skipped) and the ready lead names Jane Doe, Founder, with her LinkedIn', async () => {
  const people: string[] = []
  const r = await runFixture(fx({}, people))
  assert.equal(r.calls.searches.length, 0, 'still no TinyFish lead search in first5: only the capped people search runs')
  assert.equal(people.length, 1); assert.match(people[0], /"Brightloop"/)
  const st = stage(r); assert.equal(st?.status, 'ok', JSON.stringify(st)); assert.notEqual(st?.status, 'skipped')
  assert.deepEqual(rowPerson(r), { name: 'Jane Doe', title: 'Founder', linkedin: 'https://uk.linkedin.com/in/jane-doe-bl', source: null, via: 'a public LinkedIn search result (not verified as current)', current: false })
})

test('THE FIRST PLAY with nobody found: people_search is attempted_no_result (not skipped) and the row reads "No buyer named yet"', async () => {
  const people: string[] = []
  const r = await runFixture(fx({}, people, false))
  assert.equal(people.length, 1, 'the profile search really ran')
  const st = stage(r); assert.equal(st?.status, 'attempted_no_result', JSON.stringify(st))
  assert.equal(leadPersonLine(rowPerson(r)), NO_BUYER)
})

test('BEFORE #1037 the first play skipped the step: with DAZL_FIRST_PLAY_PEOPLE_SEARCHES=0 (the old behaviour) it is skipped and no search is made', async () => {
  const people: string[] = []
  const r = await withEnv({ DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '0' }, () => runFixture(fx({}, people)))
  assert.equal(stage(r)?.status, 'skipped'); assert.equal(people.length, 0); assert.equal(rowPerson(r), null)
})

test('kill switch PEOPLE_SEARCH_ENABLED=0 still wins on the first play', async () => {
  const people: string[] = []
  const r = await withEnv({ PEOPLE_SEARCH_ENABLED: '0' }, () => runFixture(fx({}, people)))
  assert.equal(stage(r)?.status, 'skipped'); assert.equal(people.length, 0)
})

const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-test-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_ENABLED: '1', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.01', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' }
const reserved = (r: Awaited<ReturnType<typeof runFixture>>) => (r.db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs').get() as { s: number | null }).s ?? 0

test('FREE TRIAL first play: the people search runs, is paid from the trial reserve (one search = one search price), and names the person', async () => {
  const people: string[] = [], control: string[] = []
  const t = await withEnv(TRIAL_ENV, () => runFixture(fx({ fundedBy: 'trial', model: 'claude-sonnet-4-5' }, people)))
  const off = await withEnv({ ...TRIAL_ENV, DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '0' }, () => runFixture(fx({ fundedBy: 'trial', model: 'claude-sonnet-4-5' }, control)))
  assert.equal(stage(t)?.status, 'ok', JSON.stringify(stage(t))); assert.equal(people.length, 1); assert.equal(control.length, 0)
  assert.equal(rowPerson(t)?.name, 'Jane Doe')
  assert.ok(Math.abs((reserved(t) - reserved(off)) - 0.01) < 1e-9, `exactly one search price reserved for the people step (${reserved(t)} vs ${reserved(off)})`)
  assert.ok(reserved(t) <= 1, 'inside the trial reserve')
})

test('FREE TRIAL: a search that would eat into the last quarter of the reserve is not made (budget kept for later checks), and the trace says so', async () => {
  const people: string[] = []
  const t = await withEnv({ ...TRIAL_ENV, DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.9' }, () => runFixture(fx({ fundedBy: 'trial', model: 'claude-sonnet-4-5' }, people)))
  assert.equal(people.length, 0)
  const st = stage(t); assert.equal(st?.status, 'attempted_no_result', JSON.stringify(st)); assert.match(String(st?.reason), /kept its remaining budget/)
})

// ---- review round 1 (xhawk / Greptile findings on #1046) ----

test('review: full names written without spaces (Han, Hangul, Kana) are names; a bare Latin given name is still not', () => {
  assert.equal(leadPerson([P('王伟, 销售总监', 'https://www.linkedin.com/in/wang-wei-1')], '')?.name, '王伟')
  assert.equal(leadPerson([P('김민준, 영업 이사', 'https://www.linkedin.com/in/kim-mj')], '')?.name, '김민준')
  assert.equal(leadPerson([P('山田タロウ, 営業部長', 'https://www.linkedin.com/in/yamada-t')], '')?.name, '山田タロウ')
  assert.equal(leadPerson([P('王, 销售总监', 'https://www.linkedin.com/in/wang')], ''), null, 'one character is not a full name')
  assert.equal(leadPerson([P('Jane, Head of Sales', LI)], ''), null)
  assert.equal(leadPerson([P('王伟Jane, Head of Sales', LI)], ''), null, 'mixed script with no space is not accepted as a no-space name')
})

test('review: the first-play pass searches only leads the first play lists (fit 0-1 and gate-held leads get no search)', async () => {
  const { db, job } = setup(4); const s = stub()
  db.prepare("UPDATE leads SET fit = 1 WHERE id = 'L0'").run()
  db.prepare("UPDATE leads SET fit = 0 WHERE id = 'L1'").run()
  addEnrichment(db, 'A', 'L2', { connector: 'scan:gate', kind: 'gate_failed', value: 'held', label: null, confidence: null, source_url: 'https://news.example.test/2', source_date: daysAgo(0), retrieved_at: Math.floor(Date.now() / 1000) })
  await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true })
  assert.equal(s.queries.length, 1); assert.match(s.queries[0], /CompanyDD/)
  // the ordinary (non-first-play) pass is unchanged: it still looks at its top leads by fit
  { const o = setup(4); const s2 = stub(); await findPeople(o.db, 'A', o.job, { env, fetchImpl: s2.f }); assert.equal(s2.queries.length, 4) }
})

test('review: an operator-set TINYFISH_SEARCHES_PER_SCAN still binds (it can only lower the people cap)', async () => {
  for (const [opts, want] of [[{}, MAX_COMPANIES], [{ maxCompanies: 10, skipNamed: true }, 2]] as const) {
    const { db, job } = setup(12); const s = stub()
    await findPeople(db, 'A', job, { env: { ...env, TINYFISH_SEARCHES_PER_SCAN: '2' }, fetchImpl: s.f, ...opts })
    assert.equal(s.queries.length, Math.min(want, 2), JSON.stringify(opts))
  }
  { const { db, job } = setup(12); const s = stub(); await findPeople(db, 'A', job, { env: { ...env, TINYFISH_SEARCHES_PER_SCAN: '50' }, fetchImpl: s.f, maxCompanies: 10, skipNamed: true }); assert.equal(s.queries.length, 10, 'a higher operator value never raises the people cap') }
})

test('review: a lost job (cancelled or re-claimed) stops the pass before the next search and writes nothing from an in-flight one', async () => {
  { const { db, job } = setup(3); const s = stub(); const why: string[] = []
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true, alive: () => false, onStop: w => why.push(w) }), 0)
    assert.equal(s.queries.length, 0); assert.deepEqual(why, ['ownership_lost']) }
  { const { db, job } = setup(3); const s = stub(); const why: string[] = []; let calls = 0
    // alive for the first search and its write (3 checks); lost while the second search is in flight
    const alive = () => { calls++; return calls <= 4 }
    const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true, alive, onStop: w => why.push(w) })
    assert.equal(n, 1); assert.equal(s.queries.length, 2); assert.deepEqual(why, ['ownership_lost'])
    assert.equal((db.prepare("SELECT count(*) AS c FROM lead_enrichments WHERE kind = 'person'").get() as { c: number }).c, 1, 'the result of the search in flight when the job was lost is not written') }
})

test('review: ownership is re-checked immediately before each person write (a reclaim between the post-search check and the write stores nothing)', async () => {
  const { db, job } = setup(2); const s = stub(); const why: string[] = []; let calls = 0
  // 1 = before the search, 2 = after it, 3 = just before the write: lost exactly there
  const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true, alive: () => ++calls < 3, onStop: w => why.push(w) })
  assert.equal(n, 0); assert.deepEqual(why, ['ownership_lost']); assert.equal(s.queries.length, 1)
  assert.equal((db.prepare("SELECT count(*) AS c FROM lead_enrichments WHERE kind = 'person'").get() as { c: number }).c, 0)
})

test('review: on the pass deadline the in-flight search is awaited (no paid call outlives the pass) and its result is dropped', async () => {
  const { db, job } = setup(2); let settled = false
  const f = (async (u: string) => { await new Promise(r => setTimeout(r, 250)); settled = true
    const company = /"([^"]+)"/.exec(new URL(u).searchParams.get('query') ?? '')?.[1] ?? 'x'
    return new Response(JSON.stringify({ results: [{ url: 'https://www.linkedin.com/in/late-lee', title: `Late Lee - Head of Sales - ${company} | LinkedIn`, snippet: 'Columbus, Ohio, United States · Head of Sales' }] })) }) as unknown as typeof fetch
  const why: string[] = []
  const n = await findPeople(db, 'A', job, { env, fetchImpl: f, maxCompanies: 10, skipNamed: true, deadlineMs: 30, onStop: w => why.push(w) })
  assert.equal(settled, true, 'findPeople returned only after the search it started had ended')
  assert.equal(n, 0); assert.deepEqual(why, ['deadline'])
  assert.equal((db.prepare("SELECT count(*) AS c FROM lead_enrichments WHERE kind = 'person'").get() as { c: number }).c, 0)
})

test('review: the trace status never reports a pass cut short by an error or a lost job as a clean success', () => {
  assert.equal(peopleTraceStatus(3, null), 'ok')
  assert.equal(peopleTraceStatus(0, null), 'attempted_no_result')
  assert.equal(peopleTraceStatus(0, 'budget_kept'), 'attempted_no_result')
  assert.equal(peopleTraceStatus(2, 'deadline'), 'ok')
  assert.equal(peopleTraceStatus(1, 'error'), 'failed', 'one stored, then an error: failed (people_stored stays in the detail)')
  assert.equal(peopleTraceStatus(0, 'error'), 'failed')
  assert.equal(peopleTraceStatus(1, 'ownership_lost'), 'failed')
  // Ziggy review (#1046 @ ac3b7a1a): a provider refusal (auth / quota) is a failure even after people were stored
  assert.equal(peopleTraceStatus(0, 'auth'), 'failed', 'auth stop, nobody stored')
  assert.equal(peopleTraceStatus(1, 'auth'), 'failed', 'auth stop after one stored: not a clean success')
  assert.equal(peopleTraceStatus(3, 'quota'), 'failed', 'quota stop after people stored: not a clean success')
  assert.equal(peopleTraceStatus(0, 'quota'), 'failed')
  // planned stops follow the count
  assert.equal(peopleTraceStatus(2, 'cap'), 'ok'); assert.equal(peopleTraceStatus(0, 'cap'), 'attempted_no_result')
})

test('Ziggy review: the trace message names every stop and the count stored before it (auth 0, auth 1+, quota 1+, deadline)', () => {
  assert.equal(peopleTraceMessage(0, 'auth'), 'the search provider refused the people search (its key was rejected): it stopped; 0 person(s) stored before it stopped')
  assert.equal(peopleTraceMessage(1, 'auth'), 'the search provider refused the people search (its key was rejected): it stopped; 1 person(s) stored before it stopped')
  assert.equal(peopleTraceMessage(4, 'quota'), 'the search provider refused the people search (its quota is used up): it stopped; 4 person(s) stored before it stopped')
  // a deadline stop stays ok (status) but says it hit the time budget, with the count
  assert.equal(peopleTraceStatus(2, 'deadline'), 'ok')
  assert.equal(peopleTraceMessage(2, 'deadline'), 'the people search stopped at its time budget; 2 person(s) stored before it stopped')
  assert.equal(peopleTraceMessage(0, 'deadline'), 'the people search stopped at its time budget; 0 person(s) stored before it stopped')
  assert.match(String(peopleTraceMessage(1, 'error')), /stopped on an error.*; 1 person\(s\) stored/)
  assert.match(String(peopleTraceMessage(1, 'ownership_lost')), /cancelled or re-claimed.*; 1 person\(s\) stored/)
  assert.match(String(peopleTraceMessage(2, 'cap')), /search limit.*; 2 person\(s\) stored/)
  assert.match(String(peopleTraceMessage(0, 'budget_kept')), /kept its remaining budget/)
  // only a pass that ran to its end and stored someone has no message
  assert.equal(peopleTraceMessage(3, null), null)
  assert.match(String(peopleTraceMessage(0, null)), /no profile results named/)
  // malformed inputs never throw, never read as success, never borrow a prototype key
  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, '2' as unknown as number, null as unknown as number, undefined as unknown as number]) {
    assert.equal(peopleTraceStatus(bad, null), 'attempted_no_result', String(bad))
    assert.equal(peopleTraceStatus(bad, 'auth'), 'failed', String(bad))
    assert.match(String(peopleTraceMessage(bad, 'quota')), /; 0 person\(s\) stored/, String(bad))
  }
  for (const odd of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    assert.equal(peopleTraceStatus(1, odd), 'ok', odd); assert.match(String(peopleTraceMessage(1, odd)), /stopped early/, odd)
  }
  assert.equal(peopleTraceStatus(1, undefined as unknown as string), 'ok'); assert.equal(peopleTraceMessage(1, undefined as unknown as string), null)
  assert.equal(peopleTraceStatus(1, 5 as unknown as string), 'ok'); assert.match(String(peopleTraceMessage(1, 5 as unknown as string)), /stopped early \(5\)/)
  assert.ok(String(peopleTraceMessage(1, 'x'.repeat(5000))).length < 200, 'a huge stop reason is truncated')
})

// Answers the first `okFirst` profile searches with a person, then every later one with HTTP `status` (401 auth, 402 quota).
function stubThen(okFirst: number, status: number) {
  const s = stub(); let calls = 0
  const f = (async (u: string, init?: RequestInit) => (++calls <= okFirst ? (s.f as unknown as (u: string, i?: RequestInit) => Promise<Response>)(u, init) : new Response('{}', { status }))) as unknown as typeof fetch
  return { f, calls: () => calls }
}
for (const [label, okFirst, status, why] of [['auth stop with 0 stored', 0, 401, 'auth'], ['auth stop with 1 stored', 1, 401, 'auth'], ['quota stop with 1 stored', 1, 402, 'quota'], ['quota stop with 2 stored', 2, 402, 'quota']] as const) {
  test(`Ziggy review, real pass: ${label} -> failed, the stop and the count are reported, no search after the refusal`, async () => {
    const { db, job } = setup(5); const s = stubThen(okFirst, status); const stops: string[] = []
    const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 10, skipNamed: true, onStop: w => stops.push(w) })
    assert.equal(n, okFirst, 'people stored before the refusal are kept and counted')
    assert.deepEqual(stops, [why]); assert.equal(s.calls(), okFirst + 1, 'the pass stopped at the refusal')
    const stopped = stops[0] ?? null
    assert.equal(peopleTraceStatus(n, stopped), 'failed', 'never a clean success')
    assert.match(String(peopleTraceMessage(n, stopped)), new RegExp(`refused the people search.*; ${okFirst} person\\(s\\) stored before it stopped`))
    // BEFORE this fix the 1+ cases read 'ok' (status came from the count alone): shown by running this test on ac3b7a1a's people-search.ts (see the PR comment)
  })
}

test('Ziggy review, real pass: a deadline stop with people stored stays ok but says it hit the time budget', async () => {
  const { db, job } = setup(3); let calls = 0; const stops: string[] = []
  const s = stub()
  const f = (async (u: string, init?: RequestInit) => { calls++; if (calls > 1) await new Promise(r => setTimeout(r, 200)); return (s.f as unknown as (u: string, i?: RequestInit) => Promise<Response>)(u, init) }) as unknown as typeof fetch
  const n = await findPeople(db, 'A', job, { env, fetchImpl: f, maxCompanies: 10, skipNamed: true, deadlineMs: 100, drainMs: 400, onStop: w => stops.push(w) })
  assert.equal(n, 1); assert.deepEqual(stops, ['deadline'])
  assert.equal(peopleTraceStatus(n, 'deadline'), 'ok')
  assert.equal(peopleTraceMessage(n, 'deadline'), 'the people search stopped at its time budget; 1 person(s) stored before it stopped')
})

test('Ziggy review, THE FIRST PLAY through the real runner: the provider rejecting the key makes people_search failed, named, with the count', async () => {
  for (const [status, why, re] of [[401, 'auth', /key was rejected/], [402, 'quota', /quota is used up/]] as const) {
    const people: string[] = []
    const r = await runFixture(fx({}, people, true, status))
    assert.equal(people.length, 1, 'the profile search really ran')
    const st = stage(r); assert.equal(st?.status, 'failed', JSON.stringify(st))
    assert.match(String(st?.reason), re); assert.match(String(st?.reason), /; 0 person\(s\) stored before it stopped/)
    assert.equal(st?.detail?.stopped, why); assert.equal(st?.detail?.people_stored, 0)
    assert.equal(leadPersonLine(rowPerson(r)), NO_BUYER, 'the row still reads "No buyer named yet"')
  }
})

test('review: a job lost WHILE a search is in flight aborts that request (ownership-linked signal), writes nothing, stops ownership_lost', async () => {
  const { db, job } = setup(2); let aborted = false, started = 0
  const f = ((_u: string, init?: RequestInit) => { started++
    return new Promise<Response>((_res, rej) => { init?.signal?.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')) }) }) }) as unknown as typeof fetch
  let alive = true; setTimeout(() => { alive = false }, 40)
  const why: string[] = []
  const t0 = Date.now()
  const n = await findPeople(db, 'A', job, { env, fetchImpl: f, maxCompanies: 10, skipNamed: true, alive: () => alive, aliveEveryMs: 10, onStop: w => why.push(w) })
  assert.equal(aborted, true, 'the in-flight request received the abort')
  assert.ok(Date.now() - t0 < 5_000, 'did not wait out the transport timeout')
  assert.equal(started, 1); assert.equal(n, 0); assert.deepEqual(why, ['ownership_lost'])
  assert.equal((db.prepare("SELECT count(*) AS c FROM lead_enrichments WHERE kind = 'person'").get() as { c: number }).c, 0)
})
