import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'

// Run af02437c: Uare.ai still no_company_domain with #1549 live. The real record (2026-11-22) and the real www.uare.ai homepage.
const F = (n: string) => readFileSync(new URL(`./fixtures/gh-site/${n}`, import.meta.url), 'utf8')
async function run(company: string, source: string) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  try {
    const job = createJob(db, 'T', { business_name: 'dazl', industry: 'software', location: 'United States' })
    db.prepare("UPDATE scan_jobs SET status='running',icp=?,run_budget=? WHERE id=?").run(JSON.stringify({ who: ['Founder', 'CEO', 'Head of Sales'] }), markCompanyFirstBudget(null), job)
    const lead = 'u'.repeat(24)
    db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(lead, job, company, null, 'Uare.ai is hiring an Account Executive', source, 'Account Executive', 90, 80)
    const pages: Record<string, string> = {
      'https://boards-api.greenhouse.io/v1/boards/uareai/jobs/4459513009': F('uareai-4459513009.json'),
      'https://uare.ai/robots.txt': 'User-agent: *\nAllow: /', 'https://www.uare.ai/robots.txt': 'User-agent: *\nAllow: /',
      'https://uare.ai/': F('uare.ai-home.html'), 'https://www.uare.ai/': F('uare.ai-home.html'),
    }
    const asked: string[] = []
    const get: Get = async url => { asked.push(url); return { status: pages[url] ? 200 : 404, body: pages[url] ?? '', finalUrl: url } }
    await crawlJob(db, 'T', job, { get, gapMs: 0, now: Date.parse('2026-11-22T14:00:00Z'), env: {} } as never)
    const rows = enrichmentsForLeads(db, 'T', [lead])[lead] ?? []
    const audits = db.prepare("SELECT lookup,status FROM connector_audit WHERE connector='sitecrawl'").all()
    return { rows, asked, audits, domain: (db.prepare('SELECT company_domain FROM leads WHERE id=?').get(lead) as { company_domain: string | null }).company_domain }
  } finally { db.close() }
}
test('Uare.ai from its own Greenhouse posting: the record name binds uare.ai and the real homepage passes the identity check', async () => {
  const r = await run('Uare.ai', 'https://job-boards.greenhouse.io/uareai/jobs/4459513009')
  assert.ok(r.rows.some(x => x.kind === 'domain' && x.value.startsWith('uare.ai|')), JSON.stringify({ rows: r.rows.map(x => [x.kind, x.value]), audits: r.audits, asked: r.asked }))
})
