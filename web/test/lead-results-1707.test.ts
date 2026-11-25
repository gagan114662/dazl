import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const leads = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
const checked = readFileSync(new URL('../app/app/leads/checked/checked-client.tsx', import.meta.url), 'utf8')

test('the result approval hold includes the reason in visible text', () => {
  assert.match(leads, /data-testid="approve-hold"[^>]*>[\s\S]*?<span[^>]*>\{c\.approve\.reason\}<\/span>/)
  assert.match(leads, /data-testid="linkedin-ready"[^>]*>[\s\S]*?<span[^>]*>\{c\.approve\.reason\}<\/span>/)
})

test('campaign and CSV links wait for results or a resolved scan', () => {
  const gate = leads.match(/^\s*const showResultActions = (.+)$/m)?.[1]
  assert.ok(gate)
  assert.match(leads, /\{showResultActions && <div[^>]*>[\s\S]*?Campaign page[\s\S]*?Download CSV[\s\S]*?<\/div>\}/)
  const visible = (status: string, overrides = {}) => runInNewContext(gate, {
    jobId: 'scan', currentView: null, statusError: null, leads: [], status, ...overrides,
  })
  for (const status of ['loading', 'pending', 'running', 'enriching']) assert.equal(visible(status), false)
  assert.equal(visible('loading', { statusError: 'unavailable' }), false)
  assert.equal(visible('loading', { leads: [{}] }), false, 'results from the prior scan do not count')
  assert.equal(visible('running', { currentView: {}, leads: [{}] }), true)
  assert.equal(visible('done'), true)
  assert.equal(visible('failed'), true)
  assert.equal(visible('', { jobId: null }), true)
})

test('hold copy states the reason and LinkedIn guidance is visible', () => {
  assert.match(leads, /data-testid="approve-hold"[^>]*>Can&apos;t approve yet\. <span>\{c\.approve\.reason\}/)
  assert.match(leads, /data-testid="linkedin-ready"[^>]*>[^<]*\{c\.linkedin\.name\}&apos;s profile and send the first message yourself\./)
})

test('ready rows show the returned signal, date, contact and email', () => {
  assert.match(checked, /\{c\.ready && <ReadyLeadDetails detail=\{c\.details\} \/>\}/)
  assert.match(checked, /<dt[^>]*>Signal<\/dt>[\s\S]*?<dt[^>]*>Date<\/dt>[\s\S]*?<dt[^>]*>Contact<\/dt>[\s\S]*?<dt[^>]*>Email<\/dt>/)
  assert.doesNotMatch(checked, /fetch\(`\/api\/leads/)
})

test('the ready response attaches details from the winning lead without crossing tenants', () => {
  const fixture = `
    import assert from 'node:assert/strict'
    import { randomUUID } from 'node:crypto'
    import Database from 'better-sqlite3'
    import { setScanDb } from './test/helpers/tenant-route-db.ts'
    import { migrateAllSqlite } from './lib/db/sqlite-migrations.ts'
    import { addEnrichment } from './lib/connectors/store.ts'
    import { homeReady } from './lib/outreach/home-ready.ts'
    import { ownSiteBuyerRows } from './test/helpers/own-site-buyer.ts'

    const db = new Database(':memory:')
    migrateAllSqlite(db)
    setScanDb(db)
    const at = Math.floor(Date.now() / 1000)
    const date = new Date((at - 86400) * 1000).toISOString().slice(0, 10)
    const company = randomUUID(), domain = company + '.example'
    const name = 'Sample Buyer', title = 'Director', email = 'sample.buyer@' + domain
    const job = db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, ?, ?, '-', '-', 'running', ?)")
    const lead = db.prepare("INSERT INTO leads (id, scan_job_id, company, company_domain, signal, source_url, event_date, date_status, event_date_proof, source_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', 'page_bound', 'discover', ?)")
    for (const [id, owner, age, signal] of [['ready', 'tenant', 2, 'A dated event'], ['held', 'tenant', 1, 'Unrelated detail'], ['other', 'private', 1, 'Private detail']]) {
      job.run(id, owner, company, at - age)
      lead.run(id, id, company, domain, signal, 'https://' + domain + '/signal', date, at - age)
    }
    for (const [kind, value] of [['person', name + ', ' + title], ['email', email]]) {
      addEnrichment(db, 'tenant', 'ready', { connector: 'discover', kind, value, label: null, confidence: null, source_url: 'https://' + domain + '/' + kind, source_date: date, retrieved_at: at })
    }
    db.prepare("UPDATE scan_jobs SET status = 'done'").run()
    const result = await homeReady('tenant', at)
    assert.equal(result.ready, 1)
    assert.equal(result.companies.length, 1)
    const [row] = result.companies
    assert.equal(row.lead_id, 'ready')
    assert.equal(row.job_id, 'ready')
    assert.equal(row.reason, '')
    assert.deepEqual(row.details, { signal: 'A dated event', event_date: date, day_verified: true, contact_name: name, contact_title: title, email })
    assert.doesNotMatch(JSON.stringify(result), /Private detail|Unrelated detail/)

    addEnrichment(db, 'tenant', 'ready', { connector: 'discover', kind: 'linkedin', value: 'https://www.linkedin.com/in/sample-buyer', label: null, confidence: null, source_url: 'https://' + domain + '/person', source_date: date, retrieved_at: at })
    db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES (?, ?, 'manual')").run('tenant', email)
    const suppressed = (await homeReady('tenant', at)).companies.find(row => row.lead_id === 'ready')
    assert.equal(suppressed?.ready, true)
    assert.equal(suppressed?.details?.email, null, 'a suppressed address stays hidden on a LinkedIn-ready row')
    db.prepare("UPDATE lead_enrichments SET value = ? WHERE tenant_id = ? AND lead_id = ? AND kind = 'email'")
      .run('sample.buyer@gmail.com', 'tenant', 'ready')
    const personal = (await homeReady('tenant', at)).companies.find(row => row.lead_id === 'ready')
    assert.equal(personal?.ready, true)
    assert.equal(personal?.details?.email, null, 'a personal mailbox stays hidden even if published on the company site')

    const legacy = randomUUID(), site = legacy + '.example', legacyEmail = 'inquiries@' + site
    job.run(legacy, 'tenant', legacy, at - 3)
    lead.run(legacy, legacy, legacy, site, 'A dated event', 'https://' + site + '/signal', date, at - 3)
    db.prepare("UPDATE scan_jobs SET status = 'done', icp = ? WHERE id = ?").run(JSON.stringify({ who: ['Head of Sales'] }), legacy)
    db.prepare("UPDATE leads SET source_kind = NULL, confidence = 80, human_confirmed_at = ?, evidence_excerpt = ?, contact = ? WHERE id = ?")
      .run(at - 3, 'A dated event', legacyEmail, legacy)
    for (const row of [
      ...ownSiteBuyerRows(site, { name: 'First Buyer', title: 'Founder', at }),
      ...ownSiteBuyerRows(site, { name: 'Relevant Buyer', title: 'Head of Sales', at }).filter(row => row.kind === 'person'),
    ]) addEnrichment(db, 'tenant', legacy, row)
    const legacyDetails = async () => (await homeReady('tenant', at)).companies.find(row => row.lead_id === legacy)?.details
    assert.equal((await legacyDetails())?.contact_name, 'Relevant Buyer')
    assert.equal((await legacyDetails())?.email, legacyEmail)
    db.prepare("INSERT INTO source_reviews VALUES (?, ?, ?, ?, ?, 'ok', 1, 1, 1, ?)").run(
      randomUUID(), 'tenant', legacy, legacy,
      JSON.stringify({ contact_context: { excerpt: 'Send your application to ' + legacyEmail, source_url: 'https://' + site + '/careers' } }), at)
    assert.equal((await legacyDetails())?.email, null, 'the saved source context restricts the address')
  `
  const child = spawnSync(process.execPath, [
    '--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', '--input-type=module', '--eval', fixture,
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 30_000 })
  assert.equal(child.status, 0, child.stdout + child.stderr)
})
