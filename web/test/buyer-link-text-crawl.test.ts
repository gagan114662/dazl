import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { publishedEmail } from '../lib/outreach/published-email.ts'

// Refs #1122 (run e1334435, PM ruling 2026-11-22): usesimple.ai was found by a third-party page's link (evidence_link_text) and its
// homepage passed the identity check, yet no buyer was stored - the no-route fallback sat behind "established". The ruling: a person
// only (never an email or route) may be stored on a confirmed domain, from pages of that site only.
const F = (n: string) => readFileSync(new URL(`./fixtures/buyer-pages/${n}`, import.meta.url), 'utf8')
const now = Date.parse('2026-11-22T09:00:00Z')
async function run(opt: { foreignTeam?: boolean } = {}) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  try {
    const job = createJob(db, 'T', { business_name: 'dazl', industry: 'software', location: 'San Francisco, CA' })
    db.prepare("UPDATE scan_jobs SET status='running',icp=?,run_budget=? WHERE id=?").run(JSON.stringify({ who: ['Founder', 'CEO', 'Head of Sales'] }), markCompanyFirstBudget(null), job)
    const lead = 'e'.repeat(24), source = 'https://news.example/2026/11/10/simple-ai-raises'
    db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(lead, job, 'Simple AI', null, 'Simple AI raised a seed round', source, 'Simple AI raised a seed round', 90, 80)
    const o = 'https://usesimple.ai'
    const pages: Record<string, string> = {
      [source]: '<html><body><p>Simple AI raised a seed round this month, the company said in a statement about its voice agents.</p><a href="https://usesimple.ai/">Simple AI</a></body></html>',
      [o + '/robots.txt']: 'User-agent: *\nAllow: /', [o + '/']: F('usesimple.ai-home.html'), [o + '/team/']: F('usesimple.ai-team.html'), [o + '/about-us/']: F('usesimple.ai-about-us.html'),
    }
    const get: Get = async url => ({ status: pages[url] ? 200 : 404, body: pages[url] ?? '', finalUrl: opt.foreignTeam && url === o + '/team/' ? 'https://elsewhere.example/team/' : url })
    await crawlJob(db, 'T', job, { get, gapMs: 0, now, env: {} } as never)
    const rows = enrichmentsForLeads(db, 'T', [lead])[lead] ?? []
    return { rows, routed: publishedEmail({ contact: null, enrichments: rows }) }
  } finally { db.close() }
}
test('a confirmed (link-text, identity-checked) site stores its named buyer as a person only - no email, no route', async () => {
  const { rows, routed } = await run()
  assert.ok(rows.some(r => r.kind === 'domain' && r.value === 'usesimple.ai|evidence_link_text'), JSON.stringify(rows.map(r => [r.kind, r.value])))
  assert.deepEqual(rows.filter(r => r.kind === 'person').map(r => r.value), ['Catheryn Li, Chief Executive Officer'])
  assert.deepEqual(rows.filter(r => r.kind === 'email' || r.kind === 'phone'), [])
  assert.equal(routed, null)
})
test('the person-only fallback never reads a page that redirected off the confirmed site', async () => {
  const { rows } = await run({ foreignTeam: true })
  assert.ok(!rows.some(r => r.kind === 'person' && !r.source_url?.startsWith('https://usesimple.ai/')))
})
test('Qodo #1540: a fallback buyer keeps its source warning - never shown as verified; a name-searched site says so too', async () => {
  const { fallbackBuyerLabel } = await import('../lib/connectors/sitecrawl.ts')
  const { rows } = await run()
  const label = rows.find(r => r.kind === 'person')?.label ?? ''
  assert.match(label, /not verified as current staff/); assert.match(label, /linked from the source, not the page the source is on/)
  const probe = fallbackBuyerLabel('listed with this title on this company page, not verified as current staff', 'name_probe')
  assert.match(probe, /site found by name search and location match, not linked from the source/)
  assert.match(fallbackBuyerLabel('anything', 'evidence_own_domain'), /not verified as current staff/)
})
