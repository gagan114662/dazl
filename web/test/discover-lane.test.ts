// The Claude discovery lane inside a real scan job (lib/scan/runner.ts runDiscoverLane): the leads the loop returns are stored, the
// ones whose proof names the company are READY the way Home and the Leads page decide it, and the rest go to review. The loop itself
// is replaced by a canned answer; invented companies only, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, discoverLaneEnabled, runJob } from '../lib/scan/runner.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { leadHoldReason, timingOptsFor } from '../lib/outreach/lead-hold.ts'
import type { DiscoverResult, DiscoveredLead } from '../lib/discover/agent.ts'
import { discoverApprove, discoverContact } from '../lib/discover/card.ts'

const lead = (o: Partial<DiscoveredLead>): DiscoveredLead => ({ company: 'Northwind Dental', domain: 'northwind-dental.example', signal: 'Opening a second clinic', signal_date: '2026-10-14', evidence_url: 'https://news.example/northwind', evidence_quote: 'Northwind Dental will open its second clinic', person: 'Dana Ruiz', title: 'Practice Owner', person_source_url: 'https://northwind-dental.example/team', linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'expanding', ...o })

const proofJudgeYes: typeof fetch = async input => {
  if (String(input) !== 'https://api.anthropic.com/v1/messages') return new Response(null, { status: 403 })
  return Response.json({ model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'YES' }],
    usage: { input_tokens: 0, output_tokens: 0 } })
}

test('the lane runs for an ordinary request on the workspace\'s own Anthropic key, and only then', () => {
  const job = { query: 'dental clinics expanding', csv_domain: null, watch_id: null, funded_by: 'user' }
  assert.equal(discoverLaneEnabled(job, 'anthropic', {}), true)
  assert.equal(discoverLaneEnabled(job, 'anthropic', { DAZL_DISCOVER_LANE: '0' }), false, 'the switch turns it off')
  assert.equal(discoverLaneEnabled(job, 'openai', {}), false)
  assert.equal(discoverLaneEnabled({ ...job, funded_by: 'trial' }, 'anthropic', {}), false, 'a free-trial scan with no stated reserve cannot use the lane (the scan then ends as not available, #1435)')
  assert.equal(discoverLaneEnabled({ ...job, funded_by: 'trial' }, 'anthropic', {}, 0.2), false, 'a trial reserve too small for any run cannot use the lane (the scan then ends as not available, #1435)')
  assert.equal(discoverLaneEnabled({ ...job, funded_by: 'trial' }, 'anthropic', {}, 0.3), true, 'the current US$0.30 trial scan uses the lane, at its smallest budget')
  assert.equal(discoverLaneEnabled({ ...job, csv_domain: 'acme.example' }, 'anthropic', {}), false)
  assert.equal(discoverLaneEnabled({ ...job, watch_id: 'w1' }, 'anthropic', {}), true, 'a play that runs again uses the lane too')
})

test('a scan through the lane: confirmed leads are ready, an undated one too, an unconfirmed proof goes to review; the person and website are kept', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const canned: DiscoverResult = {
    leads: [
      lead({}),
      lead({ company: 'Harbour Smiles', signal: 'Opening a new location', domain: null, evidence_url: 'https://harboursmiles.example/news', evidence_quote: 'Harbour Smiles is opening a new location', signal_date: null, person: null, title: null, person_source_url: null, confidence: 'medium' }),
      lead({ company: 'Ghost Dental', evidence_url: 'https://nowhere.example/ghost' }),
    ],
    seen: [
      { url: 'https://news.example/northwind', title: 'Northwind Dental', page_age: null, text: 'On 14 October 2026 Northwind Dental will open its second clinic downtown.' },
      { url: 'https://harboursmiles.example/news', title: 'News', page_age: null, text: 'Harbour Smiles is opening a new location this year.' },
    ],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 }, stop: 'end_turn', model: 'claude-opus-5-5', note: null,
  }
  const asked: { query: string; offer?: string | null; exclude?: string[] }[] = []
  const blocked = proofJudgeYes   // dazl's own read of the unseen proof fails
  const result = await runJob(db, job!, { master, fetchImpl: blocked, discover: true, discoverImpl: async input => { asked.push(input); return asked.length === 1 ? canned : { ...canned, leads: [], seen: [] } },
    // the second pass fills the website of the lead that had none, and costs a little more
    enrichImpl: async leads => ({ leads: leads.map(l => l.company === 'Harbour Smiles' ? { ...l, domain: 'harboursmiles.example' } : l), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.011 }, seen: [], enriched: 1 }) })
  assert.equal(result, 'done')
  assert.deepEqual(asked[0], { query: 'Dental clinics in a city opening a new location', offer: 'Clinic fit-out contractor' }, 'the request and the offer go to the loop as written')
  assert.deepEqual(asked[1]?.exclude, ['Northwind Dental', 'Harbour Smiles', 'Ghost Dental'], 'fewer than five shown: a second pass looks for different companies')
  assert.equal(asked.length, 2)
  const j = db.prepare('SELECT status, error, candidates, verified, needs_review, query, icp FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; candidates: number; verified: number; needs_review: number; query: string; icp: string | null }
  assert.deepEqual([j.status, j.error, j.candidates, j.verified, j.needs_review], ['done', null, 3, 2, 1])
  const leads = listLeads(db, 'T', id, 50, false) as (Record<string, unknown> & { id: string; company: string })[]
  const enr = enrichmentsForLeads(db, 'T', leads.map(l => l.id)) as Record<string, { kind: string; value: string; source_url: string }[]>
  const why = (company: string) => { const l = leads.find(x => x.company === company)!; return leadHoldReason(db, 'T', l, enr[l.id] ?? [], timingOptsFor(j), new Date()) }
  // #1238: Home calls a lead ready only when an action is available for it (Approve, or Message on LinkedIn: lib/discover/card.ts discoverState).
  // Both leads are still saved and listed on the Leads page (found in `leads` above); Home used to count both as ready with no action for either.
  assert.equal(why('Northwind Dental'), 'no contact found yet', 'confirmed and dated, with a named person but no address or profile of theirs: not ready yet')
  assert.equal(why('Harbour Smiles'), 'the signal has no date, so its timing is unknown', 'no date: its Approve is off, so Home does not call it ready')
  assert.equal(why('Ghost Dental'), 'needs your review', 'a proof page the run never saw and dazl could not read is not shown as ready')
  const nw = leads.find(l => l.company === 'Northwind Dental')!
  assert.deepEqual([nw.source_kind, nw.company_domain, nw.event_date, nw.event_date_proof, nw.name], ['discover', 'northwind-dental.example', '2026-10-14', 'page_bound', 'Dana Ruiz'])
  assert.deepEqual(enr[nw.id].filter(e => e.kind === 'person').map(e => [e.value, e.source_url]), [['Dana Ruiz, Practice Owner', 'https://northwind-dental.example/team']])
  const spend = db.prepare("SELECT kind, status, actual_usd FROM scan_spend_calls WHERE scan_job_id = ?").all(id) as { kind: string; status: string; actual_usd: number | null }[]
  assert.deepEqual(spend.map(s => [s.kind, s.actual_usd]), [['llm.anthropic.web_search', 0.099]], 'the run is reserved before the call and settled at what both search passes and the people pass cost')
  assert.equal(leads.find(l => l.company === 'Harbour Smiles')!.company_domain, 'harboursmiles.example', 'the second pass filled the empty website')
})

test('a request with its own lower limit gets the smaller search budget and never reserves more than its limit', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor', runBudget: JSON.stringify({ max_usd: 1 }) })
  const job = claimKeyedJob(db, id)
  const asked: Record<string, unknown>[] = []
  const empty: DiscoverResult = { leads: [], seen: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.2 }, stop: 'end_turn', model: 'm', note: 'I ran out of searches before finding a dated expansion.' }
  assert.equal(await runJob(db, job!, { master, discover: true, enrichImpl: null, discoverImpl: async input => { asked.push(input as unknown as Record<string, unknown>); return empty } }), 'done')
  assert.deepEqual([asked[0].maxSearches, asked[0].maxFetches], [10, 8], 'US$1 of room is less than a full run: the smaller budget')
  const spend = db.prepare('SELECT reserve_usd, actual_usd FROM scan_spend_calls WHERE scan_job_id = ?').all(id) as { reserve_usd: number; actual_usd: number }[]
  assert.equal(spend.length, 1)
  assert.ok(spend[0].reserve_usd <= 1 && spend[0].actual_usd === 0.4, JSON.stringify(spend))   // two passes: the first found nothing
  // #1579 (production job 1569fa9c, 2026-11-24): a search that returned nothing saved no reason. The run report now carries the lane's
  // own account: the budget it ran with, how it stopped, what it returned and the engine's note.
  const saved = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(id) as { report: string } | undefined
  assert.ok(saved, 'the run report was written')
  const told = (JSON.parse(saved.report) as { discover?: Record<string, unknown> }).discover
  assert.ok(told, 'the report has the discovery lane\'s account')
  assert.equal(told.budget, 'small')
  assert.equal(told.stop, 'end_turn')
  assert.equal(told.returned, 0)
  assert.equal(told.shown, 0)
  assert.equal(typeof told.searches, 'number')
  assert.match(String(told.note), /ran out of searches/)
})

test('a request limited to US$0.30 gets the smallest budget: five searches, no second pass', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor', runBudget: JSON.stringify({ max_usd: 0.3 }) })
  const job = claimKeyedJob(db, id)
  const asked: Record<string, unknown>[] = []
  const empty: DiscoverResult = { leads: [], seen: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.15 }, stop: 'end_turn', model: 'm', note: null }
  assert.equal(await runJob(db, job!, { master, discover: true, enrichImpl: null, discoverImpl: async input => { asked.push(input as unknown as Record<string, unknown>); return empty } }), 'done')
  assert.deepEqual([asked.length, asked[0].maxSearches, asked[0].maxFetches], [1, 5, 4])
  const spend = db.prepare('SELECT reserve_usd, actual_usd FROM scan_spend_calls WHERE scan_job_id = ?').all(id) as { reserve_usd: number; actual_usd: number }[]
  assert.ok(spend.length === 1 && spend[0].reserve_usd <= 0.3 && spend[0].actual_usd === 0.15, JSON.stringify(spend))
})

// Production, 2026-11-23 (#1579): on the one workspace named by DAZL_COMPANY_FIRST_TENANT_ID, two paid searches found 7 and 5 leads
// through the lane and showed none. The request had been marked company-first when it was accepted, and every reader holds a marked
// scan's leads until that older rollout's own final checks pass, which the lane never runs. A scan the lane answered is the lane's.
test('a scan accepted as company-first and answered by the lane shows its leads: nothing is held by final checks that never run', async () => {
  const { markCompanyFirstBudget, hasCompanyFirstBudget } = await import('../lib/company-first/product-discovery.ts')
  const { listCampaignsNow } = await import('../lib/outreach/campaigns.ts')
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const before = process.env.DAZL_COMPANY_FIRST_TENANT_ID
  process.env.DAZL_COMPANY_FIRST_TENANT_ID = 'T'
  try {
    const db = new Database(':memory:')
    migrateAllSqlite(db)
    saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
    const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor' })
    db.prepare('UPDATE scan_jobs SET run_budget = ? WHERE id = ?').run(markCompanyFirstBudget(null), id)
    const job = claimKeyedJob(db, id)
    assert.ok(job && hasCompanyFirstBudget(job.run_budget), 'the scan starts marked, as /api/scan marks it for this workspace')
    const canned: DiscoverResult = {
      leads: [lead({})],
      seen: [{ url: 'https://news.example/northwind', title: 'Northwind Dental', page_age: null, text: 'On 14 October 2026 Northwind Dental will open its second clinic downtown.' }],
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 }, stop: 'end_turn', model: 'claude-opus-5-5', note: null,
    }
    let n = 0
    const result = await runJob(db, job!, { master, fetchImpl: proofJudgeYes, discover: true,
      discoverImpl: async () => n++ === 0 ? canned : { ...canned, leads: [], seen: [] }, enrichImpl: null })
    assert.equal(result, 'done')
    const j = db.prepare('SELECT status, verified, run_budget FROM scan_jobs WHERE id = ?').get(id) as { status: string; verified: number; run_budget: string | null }
    assert.deepEqual([j.status, j.verified], ['done', 1])
    assert.equal(hasCompanyFirstBudget(j.run_budget), false, 'the finished scan is no longer marked for the older rollout')
    const c = (await listCampaignsNow(db, 'T')).find(x => x.id === id)!
    // #1238: the lead is counted by its one state. It names a person but no address or profile of theirs, so it is "no contact yet" - and still not held by checks
    assert.deepEqual([c.discovery.leads, c.qualification.noContact, c.qualification.heldByChecks, c.qualification.research], [1, 1, 0, 0], 'its lead is counted, not held')
  } finally { if (before === undefined) delete process.env.DAZL_COMPANY_FIRST_TENANT_ID; else process.env.DAZL_COMPANY_FIRST_TENANT_ID = before }
})

// Production 145d2eba, Quest's pass on #1579: a hiring request ("...hiring their first SDR or salesperson") returned 7 leads through the
// lane and every Approve was off: "A required check has not passed. Research only." The old engine's sales-hiring gate denies by default
// (a lead is usable only with a recorded pass of that gate), and the lane never runs that gate: its own proof check decides.
test('a hiring request answered by the lane is not held by the old sales-hiring gate, which never ran on it', async () => {
  const { requiredGateHeld, requiredGateHeldForJob } = await import('../lib/scan/held-state.ts')
  const { sqliteDb } = await import('../lib/db/client.ts')
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'B2B SaaS founders in the US and Canada hiring their first SDR or salesperson', seller: 'Outbound sales agency' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const canned: DiscoverResult = {
    leads: [lead({ company: 'Northwind Software', domain: 'northwind-software.example', signal: 'Hiring its first SDR', evidence_url: 'https://northwind-software.example/careers/sdr', evidence_quote: 'Northwind Software is hiring its first Sales Development Representative' })],
    seen: [{ url: 'https://northwind-software.example/careers/sdr', title: 'SDR', page_age: null, text: 'Posted 14 October 2026. Northwind Software is hiring its first Sales Development Representative.' }],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 }, stop: 'end_turn', model: 'claude-opus-5-5', note: null,
  }
  let n = 0
  const result = await runJob(db, job!, { master, fetchImpl: proofJudgeYes, discover: true,
    discoverImpl: async () => n++ === 0 ? canned : { ...canned, leads: [], seen: [] }, enrichImpl: null })
  assert.equal(result, 'done')
  const rows = db.prepare('SELECT id, source_kind, review_reason, confidence FROM leads WHERE scan_job_id = ?').all(id) as { id: string; source_kind: string; review_reason: string | null; confidence: number | null }[]
  assert.deepEqual(rows.map(r => [r.source_kind, r.review_reason]), [['discover', null]], 'one confirmed lane lead')
  assert.equal(requiredGateHeld(db, 'T', rows[0].id), null, 'the draft guard does not hold it for a gate that never ran')
  assert.deepEqual([...await requiredGateHeldForJob(sqliteDb(db), 'T', id)], [], 'nor does the page reader')
  // the gate still holds a lead of the older engine on the same request: no recorded pass, default deny
  db.prepare("UPDATE leads SET source_kind = NULL WHERE id = ?").run(rows[0].id)
  assert.equal(requiredGateHeld(db, 'T', rows[0].id), 'sales_hiring_check_failed', 'an old-engine lead with no recorded pass stays held')
})

// Quest's lead score on production, 2026-11-24 (job 7e5605365113): 2 of 6 listed leads had a dead proof link (a 404, and a job
// board's "Job not found"). They were labelled, but still listed for the person to review, with a link that proves nothing.
test('a lead whose proof page is gone is dropped and counted, never listed; the others are kept', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const canned: DiscoverResult = {
    leads: [
      lead({}),
      lead({ company: 'Gone Dental', domain: null, signal: 'Hiring a clinic manager', signal_date: null, evidence_url: 'https://jobs.example/gone-dental/1', evidence_quote: 'Gone Dental is hiring a clinic manager', person: null, title: null, person_source_url: null, confidence: 'medium' }),
    ],
    seen: [
      { url: 'https://news.example/northwind', title: 'Northwind Dental', page_age: null, text: 'On 14 October 2026 Northwind Dental will open its second clinic downtown.' },
      { url: 'https://jobs.example/gone-dental/1', title: 'Gone Dental', page_age: null, text: 'Gone Dental. Job not found.' },
    ],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 }, stop: 'end_turn', model: 'claude-opus-5-5', note: null,
  }
  let calls = 0
  const blocked = proofJudgeYes
  assert.equal(await runJob(db, job!, { master, fetchImpl: blocked, discover: true, enrichImpl: null, discoverImpl: async () => (++calls === 1 ? canned : { ...canned, leads: [], seen: [] }) }), 'done')
  const leads = listLeads(db, 'T', id, 50, false) as (Record<string, unknown> & { company: string })[]
  assert.deepEqual(leads.map(l => l.company), ['Northwind Dental'], 'the lead with the dead proof link is not listed, for review or otherwise')
  const j = db.prepare('SELECT status, verified, needs_review, drop_reasons FROM scan_jobs WHERE id = ?').get(id) as { status: string; verified: number; needs_review: number; drop_reasons: string | null }
  assert.deepEqual([j.status, j.verified, j.needs_review], ['done', 1, 0])
  assert.equal((JSON.parse(j.drop_reasons ?? '{}') as Record<string, number>).page_not_found, 1, 'counted as dropped, with the reason the Leads page already words as "page no longer exists"')
})

for (const [alreadyNamed, mailbox] of [[false, 'office'], [false, 'dana.ruiz'], [true, 'dana.ruiz'], [true, 'info'], [true, 'office'], [true, 'reception'], [true, 'alex.lee']] as const) test(
  alreadyNamed ? `Discovery matches a named dentist to the clinic contact (${mailbox})` : mailbox === 'dana.ruiz' ? 'Discovery starts contact enrichment and makes a proven named contact actionable'
    : 'Discovery starts contact enrichment and keeps a shared inbox out of Ready',
  async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-26T12:00:00Z'))
  const crawlSetting = process.env.SITECRAWL_ENABLED
  process.env.SITECRAWL_ENABLED = '1'
  t.after(() => {
    if (crawlSetting === undefined) delete process.env.SITECRAWL_ENABLED
    else process.env.SITECRAWL_ENABLED = crawlSetting
  })
  const master = randomBytes(32)
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const hasPersonalAddress = mailbox === 'dana.ruiz'
  const ownEvidence = alreadyNamed || hasPersonalAddress
  const dentist = mailbox === 'alex.lee' ? 'Alex Lee' : 'Dana Ruiz'
  const title = alreadyNamed ? 'Dentist' : 'Practice Manager'
  const place = ownEvidence ? 'Austin, TX' : 'Mississauga, ON'
  const id = createQueryJob(db, 'T', { query: 'Dentists in ' + place, seller: 'Dental supplies' })
  db.prepare('UPDATE scan_jobs SET icp = ?, icp_inferred = 1 WHERE id = ?').run(JSON.stringify({ who: [title], where: [place] }), id)
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const origin = 'https://ferndental.com'
  const evidence = ownEvidence ? origin + '/careers' : 'https://www.jobbank.gc.ca/jobsearch/jobposting/123456'
  const address = mailbox + '@ferndental.com'
  const company = 'Fern Dental'
  const signal = 'Hiring a Dental Receptionist'
  const quote = 'Fern Dental is hiring a Dental Receptionist in ' + place
  const found: DiscoverResult = {
    leads: [lead({ company, domain: ownEvidence ? 'ferndental.com' : null, evidence_url: evidence, evidence_quote: quote, signal, signal_date: '2026-11-20', person: alreadyNamed ? 'Dana Ruiz' : null, title: alreadyNamed ? title : null, person_source_url: alreadyNamed ? origin + '/team' : null })],
    seen: [{ url: evidence, title: company, page_age: null, text: 'Posted on November 20, 2026. ' + quote }],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 },
    stop: 'end_turn', model: 'claude-opus-5-5', note: null,
  }
  const crawlRequests: string[] = []
  const pages: Record<string, string> = {
    [evidence]: '<html><body>' + quote + ' <a href="' + origin + '/">Fern Dental</a></body></html>',
    [origin + '/robots.txt']: 'User-agent: *\nAllow: /',
    [origin + '/']: '<html><body><h1>Fern Dental</h1><p>100 Example Avenue, ' + place + (ownEvidence ? ' 78702, United States' : ' L5B 1M1, Canada') + '.</p><a href="/team">Our team</a></body></html>',
    [origin + '/team']: '<html><body><p>Our local clinic has served the neighbourhood for many years. We welcome new patients and offer appointments for families throughout the week.</p><article><h2>' + dentist + '</h2><p>' + title + '</p><a href="mailto:' + address + '">' + address + '</a></article></body></html>',
  }
  assert.equal(await runJob(db, job, {
    master, discover: true, discoverImpl: async () => found, enrichImpl: null,
    fetchImpl: proofJudgeYes,
    crawlGet: async url => { crawlRequests.push(url); return { status: pages[url] ? 200 : 404, body: pages[url] ?? '', finalUrl: url } },
  }), 'done')
  const completion = db.prepare('SELECT enrich_started_at, enrich_finished_at FROM scan_jobs WHERE id = ?').get(id) as {
    enrich_started_at: number | null; enrich_finished_at: number | null
  }
  assert.ok(completion.enrich_started_at, 'Discovery starts post-finish contact enrichment')
  assert.ok(completion.enrich_finished_at, 'Discovery finishes post-finish contact enrichment')
  type SavedLead = Parameters<typeof discoverApprove>[0] & { id: string; date_status: string | null }
  const [saved] = listLeads(db, 'T', id, 50, false) as SavedLead[]
  assert.ok(saved)
  assert.equal(saved.date_status, 'verified')
  assert.equal(saved.event_date, '2026-11-20')
  assert.ok(db.prepare('SELECT 1 FROM crawl_pages WHERE scan_job_id = ? AND url = ?').get(id, origin + '/team'), crawlRequests.join(', '))
  assert.equal(saved.company_domain, 'ferndental.com')
  const contacts = enrichmentsForLeads(db, 'T', [saved.id])[saved.id] ?? []
  assert.ok(contacts.some(row => row.kind === 'person' && row.value === 'Dana Ruiz, ' + title && row.source_url === origin + '/team'))
  const contactLead = { ...saved, enrichments: contacts }
  const displayed = discoverContact(contactLead)
  assert.equal(displayed?.person?.name, 'Dana Ruiz')
  assert.equal(displayed?.email?.address ?? null, hasPersonalAddress ? address : null)
  assert.deepEqual(contacts.filter(row => row.connector === 'discover' && row.kind === 'person').map(row => row.value), ['Dana Ruiz, ' + title])
  const adoptedEmail = contacts.find(row => row.connector === 'discover' && row.kind === 'email')
  assert.deepEqual(adoptedEmail && [adoptedEmail.label, adoptedEmail.source_url],
    hasPersonalAddress ? ['published on a public page', origin + '/team'] : undefined)
  assert.equal(discoverApprove(contactLead, new Date(Date.now())).ok, hasPersonalAddress)
})

test('#1726 exhausted judge budget saves the held lead and its reason', async () => {
  const db = new Database(':memory:')
  try {
    const master = randomBytes(32)
    migrateAllSqlite(db)
    saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
    const id = createQueryJob(db, 'T', { query: 'Local clinics opening a second office' })
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const candidate = lead({})
    let providerCalls = 0
    assert.equal(await runJob(db, job, {
      master, discover: true, enrichImpl: null,
      fetchImpl: async (_input, init) => {
        if (String(init?.body).includes('claude-haiku-5-5')) providerCalls++
        return new Response(null, { status: 403 })
      },
      discoverImpl: async () => ({
        leads: [candidate],
        seen: [{ url: candidate.evidence_url, title: candidate.company, page_age: null, text: candidate.evidence_quote! }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.999 },
        stop: 'end_turn', model: 'claude-opus-5-5', note: null,
      }),
    }), 'done')
    assert.equal(providerCalls, 0)
    const row = db.prepare('SELECT review_reason, timing_note FROM leads WHERE scan_job_id = ?').get(id)
    assert.deepEqual(row, { review_reason: 'source_review_required', timing_note: 'Proof not checked (spend cap).' })
  } finally {
    db.close()
  }
})
