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
    const trace = db.prepare("SELECT lookup, status FROM connector_audit WHERE connector='sitecrawl'").all() as { lookup: string; status: string }[]
    return { rows, trace, routed: publishedEmail({ contact: null, enrichments: rows }) }
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
test('PM #1540 (no warning labels): the fallback buyer is shown plainly - no hedge copy on the card or lead JSON; its basis lives in the trace only', async () => {
  const { leadCardSummary } = await import('../lib/scan/lead-card.ts')
  const { opportunityCard } = await import('../lib/scan/opportunity.ts')
  const { rows, trace } = await run()
  const lead = { company: 'Simple AI', signal: 'Simple AI raised a seed round', source_url: 'https://news.example/2026/11/10/simple-ai-raises', evidence_excerpt: 'Simple AI raised a seed round',
    event_date: '2026-11-10', date_status: null, review_reason: null, fit: 5, intent: 1, why: null, icp_match: null, company_domain: 'usesimple.ai', contact: null, enrichments: rows }
  const card = leadCardSummary(lead, 'Founder, CEO, Head of Sales')
  const shown = JSON.stringify([card, opportunityCard(lead, 'Founder, CEO, Head of Sales'), rows.filter(r => r.kind === 'person')])
  for (const w of [/not verified as current staff/i, /role not verified/i, /role as listed/i, /site linked from the source/i, /name search/i]) assert.doesNotMatch(shown, w)
  assert.ok(trace.some(a => a.lookup === 'usesimple.ai' && /^buyer_fallback basis=evidence_link_text/.test(a.status)), JSON.stringify(trace))
})
test('PM #1540: the fallback buyer from the identity-checked team page is shown plainly on the card and opportunity card', async () => {
  const { leadCardSummary } = await import('../lib/scan/lead-card.ts')
  const { opportunityCard } = await import('../lib/scan/opportunity.ts')
  const { rows } = await run()
  const lead = { company: 'Simple AI', signal: 'Simple AI raised a seed round', source_url: 'https://news.example/2026/11/10/simple-ai-raises', evidence_excerpt: 'Simple AI raised a seed round',
    event_date: '2026-11-10', date_status: null, review_reason: null, fit: 5, intent: 1, why: null, icp_match: null, company_domain: 'usesimple.ai', contact: null, enrichments: rows }
  const opp = opportunityCard(lead, 'Founder, CEO, Head of Sales')
  assert.equal(opp.who?.name, 'Catheryn Li'); assert.equal(opp.who?.title, 'Chief Executive Officer')
  const card = leadCardSummary(lead, 'Founder, CEO, Head of Sales')
  assert.match(card.contact ?? '', /^Catheryn Li, Chief Executive Officer$/)
  assert.doesNotMatch(JSON.stringify([card, opp]), /not verified as current|role not verified|role as listed|site linked from the source|name search|basis/i)
})
