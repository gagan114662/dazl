import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { crawlJob } from '../lib/connectors/sitecrawl.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { PAGE_PROVEN_EMAIL_LABEL } from '../lib/discover/card.ts'
import { discoverStatesForDb } from '../lib/discover/state-db.ts'
import { createJob, listLeads } from '../lib/scan/store.ts'

const company = 'Aspen Dental'
const site = 'https://cedarfield.example/'
const posting = 'https://www.jobbank.gc.ca/jobsearch/jobposting/50715766'

async function crawl(t: TestContext, source: string, finalUrl: string, city: string, website: string, replay = false) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'supplies', location: 'Toronto, ON' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?")
    .run(JSON.stringify({ where: ['Toronto, ON'] }), job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('L', job, company, 'Hiring in Toronto', source, 90, 90)
  if (replay) {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    db.prepare("UPDATE leads SET source_kind = 'discover', event_date = ?, fit = 4, intent = 4 WHERE id = 'L'").run(day)
    db.prepare(`INSERT INTO leads (id, scan_job_id, company, company_domain, signal, source_url,
      confidence, score, event_date, fit, intent, source_kind) VALUES ('ready', ?, 'Existing Buyer', 'buyer.example',
      'Hiring', 'https://buyer.example/careers', 90, 89, ?, 4, 4, 'discover')`).run(job, day)
    for (const [kind, value] of [['person', 'Casey Olsen, Owner'], ['email', 'casey.olsen@buyer.example']]) {
      addEnrichment(db, 'T', 'ready', { connector: 'discover', kind, value, label: kind === 'email' ? PAGE_PROVEN_EMAIL_LABEL : 'fixture',
        source_url: 'https://buyer.example/team', source_date: day, retrieved_at: Date.parse(day) / 1000, confidence: null })
    }
  }
  const reads: string[] = []
  await crawlJob(db, 'T', job, {
    gapMs: 0,
    env: {},
    companyFirstContacts: true,
    redirectOf: async () => null,
    get: async url => {
      reads.push(url)
      if (url === source) return { status: 200, finalUrl, body: `<p>${company} is hiring in Toronto.</p><p>Website: ${website}</p>` }
      if (url === site + 'robots.txt') return { status: 200, finalUrl: url, body: 'User-agent: *\nAllow: /' }
      if (url === site) return {
        status: 200, finalUrl: url,
        body: `<html><body><h1>${company}</h1><p>Visit us at 200 Bloor Street West, ${city}.</p>
          <p>We have cared for local families for many years and welcome new patients at our dental practice.</p></body></html>`,
      }
      return null
    },
  })
  const domain = db.prepare('SELECT company_domain FROM leads WHERE id = ?').pluck().get('L')
  const visible = replay ? (listLeads(db, 'T', job) as { id: string }[]).map(row => row.id).sort() : []
  const states = replay ? (await discoverStatesForDb(sqliteDb(db), 'T', [job])).get(job) : undefined
  return { domain, reads, visible, states: Object.fromEntries(states ?? []) }
}

test('the contact crawl uses a printed Job Bank website after checking its company and city', async t => {
  const result = await crawl(t, posting, posting, 'Toronto, ON M5S 1T8', site)
  assert.equal(result.domain, 'cedarfield.example')
  assert.ok(result.reads.includes(site))
})

test('the contact crawl reads but rejects a Job Bank website for a namesake in another city', async t => {
  const result = await crawl(t, posting, posting, 'Vancouver, BC V6B 1A1', site)
  assert.equal(result.domain, null)
  assert.ok(result.reads.includes(site), 'the city check should run on the fetched candidate')
})

test('the Job Bank website parser is scoped to an exact posting read', async t => {
  const other = 'https://board.example/jobs/123'
  const wrongHost = new URL(new URL(posting).pathname, 'https://board.example').href
  for (const [source, finalUrl] of [[other, other], [posting, other], [wrongHost, wrongHost]]) {
    const result = await crawl(t, source, finalUrl, 'Toronto, ON M5S 1T8', site)
    assert.equal(result.domain, null)
    assert.ok(!result.reads.includes(site))
  }
})

test('an ATS URL printed as the Job Bank website is not an employer candidate', async t => {
  const result = await crawl(t, posting, posting, 'Toronto, ON M5S 1T8', 'https://boards.greenhouse.io/aspen')
  assert.equal(result.domain, null)
  assert.ok(!result.reads.some(url => url.includes('greenhouse.io')))
})

test('the frozen printed-site replay preserves shown leads and the Ready control', async t => {
  const result = await crawl(t, posting, posting, 'Toronto, ON M5S 1T8', site, true)
  assert.deepEqual(result.visible, ['L', 'ready'])
  assert.deepEqual(result.states, { L: 'no_contact', ready: 'ready_email' })
  t.diagnostic(JSON.stringify({ visible: result.visible, states: result.states, domain: result.domain }))
})
