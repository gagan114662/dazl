// Synthetic transport regression through runJob; NOT live yield evidence. No seeded domain/person/email rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, master, type Fixture } from './helpers/acceptance-harness.ts'
import { enrichmentsForLeads, saveCredential } from '../lib/connectors/store.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { workEmailCopy } from '../lib/people/work-email-eligible.ts'

const ATS = 'https://ats.rippling.com/war-room-careers/jobs/3d46c27a-6efa-4505-b2b4-790d52ce4ee7'
const BOARD = 'https://growthroles.com/jobs/war-room-business-development-representative-torontoremote-toronto-7d65eab6263dde76'
const SITE = 'warroominc.com'
const PROFILE = 'https://www.linkedin.com/in/jane-doe-warroom'
const ON = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '1', ZEROBOUNCE_API_KEY: 'synthetic-test-key' }

async function pipeline(mode: 'board' | 'own' | 'people_error' | 'empty' | 'no_domain', mailbox = 'valid') {
  const saved = { ...process.env }
  Object.assign(process.env, { SITECRAWL_ENABLED: '1', SITECRAWL_GAP_MS: '0', SIGNALS_ENRICH: '0', PEOPLE_SEARCH_ENABLED: '1', TINYFISH_ENABLED: '1' })
  const source = mode === 'board' || mode === 'no_domain' ? BOARD : 'https://' + SITE + '/careers/sdr'
  const place = mode === 'board' ? 'Toronto, Ontario' : 'Austin, Texas'
  const quote = 'War Room is hiring a Sales Development Representative in ' + place
  const page = { title: quote, text: quote + '. ' + 'More about the role and company. '.repeat(30) }
  const events: string[] = []
  let handle: { db: Parameters<typeof enrichmentsForLeads>[0]; job: string } | undefined
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u)
    if (url.startsWith('https://api.search.tinyfish.ai') && (new URL(url).searchParams.get('query') ?? '').startsWith('site:linkedin.com/in ')) {
      const query = new URL(url).searchParams.get('query')!
      events.push('people:' + query)
      assert.ok(query.includes('War Room') && query.includes('Founder'), query)
      assert.equal(new URL(url).searchParams.get('location'), mode === 'board' ? 'CA' : 'US')
      const domain = handle!.db.prepare('SELECT company_domain FROM leads WHERE scan_job_id = ?').get(handle!.job) as { company_domain: string | null }
      assert.equal(domain.company_domain, mode === 'no_domain' ? null : SITE, 'domain persisted before people search')
      if (mode === 'people_error') return new Response('{}', { status: 401 })
      return new Response(JSON.stringify({ results: mode === 'empty' ? [] : [{ url: PROFILE, title: 'Jane Doe - Founder - War Room | LinkedIn', snippet: place + ' - ' + SITE }] }))
    }
    if (url.includes('apollo.io')) {
      events.push('email_provider')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.first_name, 'Jane'); assert.equal(body.last_name, 'Doe'); assert.equal(body.domain, SITE)
      return new Response(JSON.stringify({ person: { name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', title: 'Founder', email: 'jane.doe@' + SITE, email_status: 'unverified', country: 'United States', linkedin_url: PROFILE, organization: { name: 'War Room', primary_domain: SITE } } }))
    }
    if (url.includes('zerobounce.net')) {
      events.push('mailbox:' + new URL(url).searchParams.get('email'))
      return new Response(JSON.stringify({ status: mailbox }))
    }
    return globalThis.fetch(u, init)
  }) as typeof fetch
  const crawlGet = async (url: string) => {
    events.push('crawl:' + url)
    if (mode === 'no_domain') return null
    if (url === BOARD) return { status: 200, body: '<a href=' + ATS + '>Apply</a>', finalUrl: url }
    if (url === ATS) return { status: 200, body: '', finalUrl: url }
    const u = new URL(url)
    if (u.hostname !== SITE) return null
    return { status: 200, body: u.pathname === '/robots.txt' ? 'User-agent: *\nAllow: /' : '<h1>War Room</h1><p>156 Front Street West, ' + place + '</p>', finalUrl: url }
  }
  const f: Fixture = {
    request: 'Find agencies hiring an SDR in ' + place,
    modelIcp: { summary: 'agencies', who: ['Founder'], industries: [], sizes: [], where: [place], signals: ['hiring SDR'], exclude: [], country: mode === 'board' ? 'CA' : 'US', language: 'en' },
    modelQueries: ['agencies SDR'], hits: [{ url: source, title: page.title, snippet: quote, date: daysAgo(1) }], tfPages: { [source]: page }, own: { [source]: page },
    extraction: [{ company: 'War Room', signal: quote, source_url: source, excerpt: quote, event_date: daysAgo(1) }],
    beforeRun: db => { migrateAllSqlite(db) },
    onVerify: (db, job) => { handle = { db, job } },
    deps: { fetchImpl, crawlGet, creditEnrichment: false, paidFallback: false },
  }
  try {
    const r = await runFixture(f)
    assert.equal(r.r, 'done', JSON.stringify(r.job))
    const lead = r.db.prepare('SELECT id, scan_job_id, company_domain, contact FROM leads WHERE company = ?').get('War Room') as { id: string; scan_job_id: string; company_domain: string | null; contact: null }
    assert.ok(lead, JSON.stringify(r.leads))
    const rows = enrichmentsForLeads(r.db, 'A', [lead.id])[lead.id] ?? []
    const person = leadPerson(rows, 'Founder')
    if (mode === 'empty' || mode === 'people_error' || mode === 'no_domain') assert.equal(person, null)
    else assert.deepEqual([person?.name, person?.title, person?.linkedin], ['Jane Doe', 'Founder', PROFILE])
    // Exercise the existing user-clicked lookup on exactly the buyer produced by THIS scan, not another seeded lead.
    saveCredential(r.db, 'A', 'enrich:apollo', 'synthetic-apollo-key', master)
    const email = await findWorkEmail(r.db, 'A', lead.id, person ? person.name + '|' + person.title : 'Jane Doe|Founder', { fetchImpl, master, env: ON })
    return { r, lead, person, email, events }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}

// #1036 / #1250: the buyer's email is only an address printed on the company's own site. With a provider key and a mailbox verifier
// configured, the click calls neither: the address People Data Labs / Apollo would have returned is never shown or checked.
for (const mailbox of ['valid', 'catch-all']) test('same-job own-site resolution -> buyer-role search -> user-clicked email: no provider, no mailbox check (' + mailbox + ' verifier)', async () => {
  const p = await pipeline('own', mailbox)
  assert.equal(p.lead.company_domain, SITE)
  assert.ok('row' in p.email && p.email.row)
  assert.deepEqual([p.email.status, p.email.row.address, p.email.row.provider], ['not_found', null, null])
  assert.equal(workEmailCopy(p.email.row).showAddress, false)
  assert.deepEqual(p.events.filter(x => x === 'email_provider' || x.startsWith('mailbox:')), [])
  let calls = 0
  await findWorkEmail(p.r.db, 'A', p.lead.id, 'Jane Doe|Founder', { master, env: ON, fetchImpl: async () => { calls++; throw new Error('replay must not send') } })
  assert.equal(calls, 0)
  p.r.db.close()
})

test('real reported board shape -> checked domain -> named buyer, but unsettled ownership refuses email (not downstream PASS)', async () => {
  const p = await pipeline('board')
  assert.equal(p.lead.company_domain, SITE)
  assert.equal(p.email.status, 'site_unsettled')
  assert.ok(!p.events.includes('email_provider') && !p.events.some(x => x.startsWith('mailbox:')))
  assert.equal(p.lead.contact, null)
  p.r.db.close()
})

for (const mode of ['people_error', 'empty', 'no_domain'] as const) test('same-job honest failure: ' + mode + ' cannot become a buyer or email PASS', async () => {
  const p = await pipeline(mode)
  assert.equal(p.person, null)
  assert.ok(p.email.status === 'not_eligible' || p.email.status === 'site_unsettled')
  assert.ok(!p.events.includes('email_provider') && !p.events.some(x => x.startsWith('mailbox:')))
  p.r.db.close()
})
