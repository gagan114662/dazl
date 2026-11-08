// #389: technographics as a discovery filter and a dated change signal. Invented companies and synthetic pages only: no network, no model,
// no provider. Pure observation/change rules, a fixture measurement of false positives, the targeting compiler, per-lead proof, and the
// whole path through the site crawl (four dated crawls of one domain) into the actionable-yield gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { observability, detectTech } from '../lib/connectors/techstack.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { encodeScan, decodeScan, techChanges, changeRow, techQueries, type TechScan } from '../lib/signals/tech-observations.ts'
import { compileTargeting, describePlan, planConditions } from '../lib/scan/targeting.ts'
import { conditionProof, type ProofLead, type ProofRow } from '../lib/scan/targeting-proof.ts'
import { classifyLeads } from '../lib/scan/actionable.ts'
import { seedNeedVerified, NEED_GATE } from './helpers/need.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'

const FILLER = '<p>Brightloop is a design and web agency in Leeds. We build marketing sites, run brand workshops and help growing teams publish faster. Talk to us about your next launch, your content plan or your site migration.</p>'
const page = (scripts: string, body = FILLER) => `<!doctype html><html><head><title>Brightloop</title>${scripts}</head><body>${body}</body></html>`
const WP = '<link href="https://brightloop.com/wp-content/themes/x/style.css">'
const WF = '<script src="https://brightloop.com/js/webflow.js"></script>'
const GA = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>'
const at = (d: string) => Date.parse(`${d}T12:00:00Z`) / 1000
const scan = (d: string, present: string[], obs: TechScan['obs'] = 'ok', extra: Partial<TechScan> = {}): TechScan => ({ domain: 'brightloop.com', at: at(d), version: 1, path: '/', obs, present, url: 'https://brightloop.com/', ...extra })

test('observability: only a full readable page can say anything about absence', () => {
  assert.equal(observability(200, page(GA)), 'ok')
  assert.equal(observability(503, page(GA)), 'http_error')
  assert.equal(observability(200, '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'), 'blocked')
  assert.equal(observability(200, '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'), 'thin_page')
  assert.equal(observability(200, '{"ok":true}'), 'not_html')
  // presence is still read from any page that loaded: the signature itself is the evidence
  assert.deepEqual(detectTech('<html><body><div id="root"></div><script src="https://cdn.shopify.com/s/x.js"></script></body></html>').map(t => t.name), ['Shopify'])
})

test('a stored observation round-trips; malformed rows are dropped, never trusted', () => {
  const s = scan('2026-09-01', ['WordPress', 'Google Analytics'])
  const e = encodeScan(s)!
  assert.equal(e.value, `brightloop.com|${at('2026-09-01')}`)
  assert.equal(e.label, 'tech-scan-v1|1|/|ok|ga,wordpress')
  assert.ok(e.label.length <= 200)
  assert.deepEqual(decodeScan(e.value, e.label, s.url), { ...s, present: ['Google Analytics', 'WordPress'] })
  assert.equal(decodeScan(e.value, 'tech-scan-v1|1|/|maybe|ga', s.url), null)
  assert.equal(decodeScan('brightloop.com|x', e.label, s.url), null)
  assert.equal(decodeScan(e.value, null, s.url), null)
  assert.equal(encodeScan({ ...s, domain: 'not a domain' }), null)
  // every detectable technology at once still fits the 200-char label column
  assert.ok(encodeScan({ ...s, present: detectTech(page([WP, WF, GA, '<script src="https://cdn.shopify.com/a.js"></script>'].join(''))).map(t => t.name).concat(['Shopify', 'Webflow', 'Wix', 'Squarespace', 'Framer', 'Next.js', 'Ghost', 'Drupal', 'HubSpot', 'Intercom', 'Stripe', 'Segment', 'Mailchimp', 'Calendly', 'Zendesk', 'jQuery', 'Bootstrap', 'Cloudflare Turnstile']) })!.label.length <= 200)
})

// Fixture measurement (#389 acceptance: "measure false positives"): labelled histories, including every outage shape the issue names.
// Expected changes are the ground truth; the rule must claim exactly those.
const FIXTURES: { name: string; scans: TechScan[]; expect: string[] }[] = [
  { name: 'real migration, confirmed', scans: [scan('2026-09-01', ['WordPress', 'Google Analytics']), scan('2026-10-01', ['Webflow', 'Google Analytics']), scan('2026-11-01', ['Webflow', 'Google Analytics'])], expect: ['Webflow adopted', 'WordPress removed'] },
  { name: 'real migration, one check after it: adoption only, removal not yet confirmed', scans: [scan('2026-09-01', ['WordPress']), scan('2026-10-01', ['Webflow'])], expect: ['Webflow adopted'] },
  { name: 'analytics outage: blocked + thin + failed pages', scans: [scan('2026-09-01', ['Google Analytics']), scan('2026-10-01', [], 'blocked'), scan('2026-10-08', [], 'thin_page'), scan('2026-10-15', [], 'http_error')], expect: [] },
  { name: 'one bad deploy drops the script once, then it is back', scans: [scan('2026-09-01', ['Google Analytics']), scan('2026-10-01', []), scan('2026-10-15', ['Google Analytics'])], expect: [] },
  { name: 'a single readable absence is never a removal', scans: [scan('2026-09-01', ['HubSpot']), scan('2026-10-01', [])], expect: [] },
  { name: 'detector version changed: not comparable', scans: [scan('2026-09-01', [], 'ok', { version: 0 }), scan('2026-10-01', ['Intercom'])], expect: [] },
  { name: 'different page: not comparable', scans: [scan('2026-09-01', [], 'ok', { path: '/blog' }), scan('2026-10-01', ['Intercom'])], expect: [] },
  { name: 'first ever observation is not an adoption', scans: [scan('2026-10-01', ['Shopify'])], expect: [] },
  { name: 'another domain is never mixed in', scans: [scan('2026-09-01', ['Shopify'], 'ok', { domain: 'other.com' }), scan('2026-10-01', []), scan('2026-10-02', [])], expect: [] },
  { name: 'removal confirmed through an outage in between', scans: [scan('2026-09-01', ['Intercom']), scan('2026-09-15', [], 'blocked'), scan('2026-10-01', []), scan('2026-11-01', [])], expect: ['Intercom removed'] },
]
test('change rule on labelled fixtures: every true change found, zero false positives from outages, single absences or incomparable pages', () => {
  let tp = 0, fp = 0, fn = 0
  for (const f of FIXTURES) {
    const got = techChanges(f.scans, 'brightloop.com').map(c => `${c.tech} ${c.kind}`).sort()
    const want = [...f.expect].sort()
    tp += got.filter(g => want.includes(g)).length; fp += got.filter(g => !want.includes(g)).length; fn += want.filter(w => !got.includes(w)).length
    assert.deepEqual(got, want, f.name)
  }
  assert.deepEqual({ tp, fp, fn }, { tp: 4, fp: 0, fn: 0 })
  // the stored change is dated at both ends and names its scope
  const [c] = techChanges(FIXTURES[0].scans, 'brightloop.com').filter(x => x.kind === 'removed')
  assert.deepEqual(changeRow(c), { value: 'WordPress removed', label: 'seen 2026-09-01, not seen 2026-10-01 and 2026-11-01; same page, detector v1, homepage HTML only (static signatures)', source_url: 'https://brightloop.com/', source_date: '2026-10-01' })
})

test('the request compiles into technology conditions only for detectable technologies after a technology cue', () => {
  const tech = (q: string) => planConditions(compileTargeting(q).root).filter(x => x.cond.kind === 'tech').map(x => `${x.negated ? '!' : ''}${x.cond.change}:${x.cond.tech}`)
  assert.deepEqual(tech('Shopify stores in Toronto that raised a seed round'), ['uses:Shopify'])
  assert.deepEqual(tech('agencies that migrated from WordPress to Webflow in the last 90 days'), ['removed:WordPress', 'adopted:Webflow'])
  assert.deepEqual(tech('brands that moved off Squarespace'), ['removed:Squarespace'])
  assert.deepEqual(tech('startups that switched to HubSpot'), ['adopted:HubSpot'])
  assert.deepEqual(tech('SaaS companies not using Intercom'), ['!uses:Intercom'])
  assert.deepEqual(tech('companies without HubSpot hiring SDRs'), ['!uses:HubSpot'])
  assert.deepEqual(tech('excluding Shopify stores, DTC brands that raised a seed round'), ['!uses:Shopify'])
  // plain English that only looks like a technology never becomes a filter
  assert.deepEqual(tech('ghost kitchens in NYC that opened a new location'), [])
  assert.deepEqual(tech('companies with segment growth'), [])
  assert.deepEqual(tech('bootstrapped startups using Salesforce'), [])
  assert.deepEqual(tech('startups using Stripe'), ['uses:Stripe'])
  // a technology condition is always an explicit (gating) plan, and the plan reads in the request's own words
  const p = compileTargeting('companies without HubSpot hiring SDRs')
  assert.equal(p.explicit, true)
  assert.equal(describePlan(p.root), '(NOT C1 HubSpot AND C2 hiring SDRs (within 90 days))')
  assert.equal(compileTargeting('Shopify stores').explicit, true)
})

test('discovery beyond the found set: announcement-style queries for a technology filter, at most two, none for a negated one', () => {
  const q = (s: string) => techQueries(planConditions(compileTargeting(s).root).filter(x => x.cond.kind === 'tech').map(x => ({ tech: x.cond.tech!, change: x.cond.change!, negated: x.negated })))
  assert.deepEqual(q('agencies that migrated from WordPress to Webflow'), ['("migrated from WordPress to Webflow" OR "moved from WordPress to Webflow" OR "switched from WordPress to Webflow")'])
  assert.deepEqual(q('Shopify stores that raised a seed round'), ['("built on Shopify" OR "powered by Shopify")'])
  assert.deepEqual(q('SaaS companies not using Intercom'), [])
  assert.ok(q('startups that switched to HubSpot using Shopify and Stripe').length <= 2)
})

const NOW = Date.parse('2026-11-02T12:00:00Z')
const LEAD: ProofLead = { company: 'Brightloop', company_domain: 'brightloop.com', evidence_excerpt: 'Brightloop raised a seed round.', signal: 'raised a seed round', source_url: 'https://news.example/a', event_date: '2026-10-20' }
const scanRow = (s: TechScan): ProofRow => { const e = encodeScan(s)!; return { connector: 'sitecrawl', kind: 'tech_scan', value: e.value, label: e.label, source_url: s.url, source_date: new Date(s.at * 1000).toISOString().slice(0, 10) } }
const changeRows = (scans: TechScan[]): ProofRow[] => techChanges(scans, 'brightloop.com').map(c => ({ connector: 'sitecrawl', kind: 'tech_change', ...changeRow(c) }))
const cond = (q: string, i = 0) => planConditions(compileTargeting(q).root).filter(x => x.cond.kind === 'tech')[i].cond
const proof = (q: string, rows: ProofRow[], i = 0) => conditionProof(cond(q, i), LEAD, rows, { query: q, icp: null, salesGatePassed: false, competitors: null, now: NOW })

test('per-lead proof: presence passes with the page and date; a missing signature or unreadable page is unknown, never fail', () => {
  const uses = 'Shopify stores that raised a seed round'
  const p = proof(uses, [scanRow(scan('2026-11-01', ['Shopify']))])
  assert.equal(p.truth, 'pass'); assert.equal(p.source_url, 'https://brightloop.com/'); assert.equal(p.date, '2026-11-01')
  assert.match(p.reason, /Shopify signature seen on https:\/\/brightloop\.com\/ on 2026-11-01 \(homepage HTML only/)
  const absent = proof(uses, [scanRow(scan('2026-11-01', []))])
  assert.equal(absent.truth, 'unknown'); assert.match(absent.reason, /not proof the company does not use it/)
  const blocked = proof(uses, [scanRow(scan('2026-11-01', [], 'blocked'))])
  assert.equal(blocked.truth, 'unknown'); assert.match(blocked.reason, /could not be read in full/)
  assert.equal(proof(uses, []).truth, 'unknown')
  // "not using X" can only be satisfied by a CONFIRMED removal on comparable pages, never by a page that just lacks the script
  const notUsing = 'SaaS companies not using Intercom'
  assert.equal(proof(notUsing, [scanRow(scan('2026-11-01', []))]).truth, 'unknown')
  const gone = [scan('2026-09-01', ['Intercom']), scan('2026-10-01', []), scan('2026-11-01', [])]
  const r = proof(notUsing, [scanRow(gone[2]), ...changeRows(gone)])
  assert.equal(r.truth, 'fail'); assert.match(r.reason, /removal confirmed/)
})

test('per-lead proof for a change: dated on both ends, inside the condition clock; a later readable check can contradict it', () => {
  const q = 'agencies that migrated from WordPress to Webflow in the last 60 days'
  const hist = [scan('2026-09-01', ['WordPress']), scan('2026-10-01', ['Webflow']), scan('2026-11-01', ['Webflow'])]
  const rows = [scanRow(hist[2]), ...changeRows(hist)]
  const removed = proof(q, rows, 0), adopted = proof(q, rows, 1)
  assert.equal(removed.truth, 'pass'); assert.equal(removed.date, '2026-10-01'); assert.match(removed.reason, /seen 2026-09-01, not seen 2026-10-01 and 2026-11-01/)
  assert.equal(adopted.truth, 'pass'); assert.equal(adopted.date, '2026-10-01'); assert.match(adopted.reason, /not seen 2026-09-01, seen 2026-10-01/)
  // the same change outside a 14-day clock is unknown, not pass
  assert.equal(proof('agencies that migrated from WordPress to Webflow in the last 14 days', rows, 0).truth, 'unknown')
  // only one check after the move: the adoption is dated, the removal is not confirmed yet
  const early = [scan('2026-09-01', ['WordPress']), scan('2026-10-01', ['Webflow'])]
  assert.deepEqual([proof(q, [scanRow(early[1]), ...changeRows(early)], 0).truth, proof(q, [scanRow(early[1]), ...changeRows(early)], 1).truth], ['unknown', 'pass'])
  // still on WordPress: the removal condition fails on the page that shows it
  assert.equal(proof(q, [scanRow(scan('2026-11-01', ['WordPress']))], 0).truth, 'fail')
  // a later readable page without Webflow contradicts the stored adoption
  assert.equal(proof(q, [scanRow(hist[1]), ...changeRows(hist.slice(0, 2)), scanRow(scan('2026-11-01', ['WordPress']))], 1).truth, 'unknown')
})

test('through the crawl: four dated crawls of one domain; an unreadable crawl changes nothing; the gate passes only with confirmed dated change', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db)
  let home = ''
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'news.example') return { status: 200, body: '<html><body><a href="https://brightloop.com">Brightloop</a> raised a seed round.</body></html>', finalUrl: url }
    if (u.hostname === 'brightloop.com' && u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }
    if (u.hostname === 'brightloop.com' && u.pathname === '/') return { status: 200, body: home, finalUrl: url }
    return { status: 404, body: '', finalUrl: url }
  }
  const query = 'Find agencies that migrated from WordPress to Webflow'
  const icp = JSON.stringify({ summary: 's', who: ['Founder'], signals: [], exclude: [] })
  const crawl = async (id: string, d: string, html: string) => {
    const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
    db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, query = ? WHERE id = ?").run(icp, query, jobId)
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, evidence_excerpt, event_date, confidence, score, fit) VALUES (?, ?, '', 'Brightloop', 'raised a seed round', 'https://news.example/a', 'Brightloop raised a seed round.', ?, 80, 80, 5)").run(id, jobId, d)
    home = html
    await crawlJob(db, 'u1', jobId, { get, gapMs: 0, env: {}, now: Date.parse(`${d}T12:00:00Z`) })
    return { id: jobId, user_id: 'u1', query, icp }
  }
  const kinds = (id: string) => (db.prepare("SELECT kind, value, source_date FROM lead_enrichments WHERE lead_id = ? AND kind IN ('tech_scan', 'tech_change') ORDER BY kind, value").all(id) as { kind: string; value: string; source_date: string }[]).map(r => `${r.kind}:${r.kind === 'tech_scan' ? 'scan' : r.value}@${r.source_date}`)
  await crawl('l1', '2026-09-01', page(WP + GA))
  assert.deepEqual(kinds('l1'), ['tech_scan:scan@2026-09-01'])
  const j2 = await crawl('l2', '2026-10-01', page(WF + GA))
  assert.deepEqual(kinds('l2'), ['tech_change:Webflow added@2026-10-01', 'tech_scan:scan@2026-10-01'])
  // a maintenance page that still names the company: recorded as thin, compared with nothing, so no WordPress or Analytics removal
  const j3 = await crawl('l3', '2026-10-15', '<html><head><title>Brightloop</title></head><body>Brightloop: back soon.</body></html>')
  assert.deepEqual(kinds('l3'), ['tech_change:Webflow added@2026-10-01', 'tech_scan:scan@2026-10-15'])
  const j4 = await crawl('l4', '2026-11-01', page(WF + GA))
  assert.deepEqual(kinds('l4'), ['tech_change:Webflow added@2026-10-01', 'tech_change:WordPress removed@2026-10-01', 'tech_scan:scan@2026-11-01'])
  // Google Analytics was on every readable page: never reported as a change
  assert.equal((db.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE kind = 'tech_change' AND value LIKE 'Google Analytics%'").get() as { n: number }).n, 0)
  // the targeting gate reads the per-lead proof: removal not yet confirmed at crawl 2 / 3 (held), confirmed at crawl 4
  const truths = (job: { id: string; user_id: string; query: string; icp: string }) => classifyLeads(db, job)[0].targeting!.map(c => `${c.id}:${c.truth}`)
  assert.deepEqual(truths(j2), ['C1:unknown', 'C2:pass'])
  assert.deepEqual(classifyLeads(db, j2)[0].missing, ['targeting_not_proven'])
  assert.deepEqual(truths(j3), ['C1:unknown', 'C2:pass'])
  assert.deepEqual(truths(j4), ['C1:pass', 'C2:pass'])
  const c1 = classifyLeads(db, j4)[0].targeting![0]
  assert.equal(c1.source_url, 'https://brightloop.com/'); assert.equal(c1.date, '2026-10-01')
  // technology fit is not the buying reason: the lead still needs its own contact proof (no person / published route
  // here). The buying-need verdict itself is recorded and valid, so the need gate passes and the contact gaps show.
  seedNeedVerified(db, 'u1', j4.id, 'l4', 'Brightloop', j4)
  assert.deepEqual(classifyLeads(db, j4, new Map(), NEED_GATE)[0].missing, ['no_contact_person', 'no_published_contact'])
})
