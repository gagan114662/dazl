import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bothEngines } from './helpers/engines.ts'
import { homeResults } from '../lib/outreach/home-results.ts'

bothEngines('#1772: Home signal rows and the Leads row total use the same count', async ({ db }) => {
  const now = 1_800_000_000
  const job = 'a'.repeat(24)
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'A', 'Fixture', 'services', 'region', 'running', ?)", [job, now])
  for (const [id, company, kind, source] of [
    ['a1', 'Repeated company', 'hiring', 'discover'],
    ['a2', 'Repeated company', null, 'discover'],
    ['a3', 'Other company', 'hiring', 'watch'],
  ]) {
    await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, signal_kind, source_kind, created_at) VALUES (?, ?, ?, 'Fixture signal', 'https://example.test/proof', ?, ?, ?)", [id, job, company, kind, source, now])
  }

  const results = await homeResults(db, 'A', now)
  assert.equal(results.companies, 2, 'two distinct companies')
  assert.deepEqual(results.by_signal.map(row => [row.signal, row.leads]), [['hiring', 2], ['source:discover', 1]])
  const displayedLeadsTotal = results.tiles.leads
  assert.equal(displayedLeadsTotal, 3, 'all three lead rows count once')
  assert.equal(results.by_signal.reduce((total, row) => total + row.leads, 0), displayedLeadsTotal)

  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  assert.match(read('../app/app/home-results.tsx'), /fetch\('\/api\/home\/results'\)/)
  const leads = read('../app/app/leads/leads-client.tsx')
  assert.ok(leads.includes("fetch('/api/home/results'"), 'Leads reads the same result as Home')
  assert.ok(leads.includes('count: result.tiles.leads'), 'Leads uses the same lead-row count, not checked companies')
  assert.ok(/data-testid="leads-overall-row-total"[\s\S]*?leadRowTotal\.count/.test(leads))
})
