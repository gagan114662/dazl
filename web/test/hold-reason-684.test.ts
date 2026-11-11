// #684 (part of #352): a held lead's saved claim and its shown hold reason never contradict. The live audit case: a
// receptionist-vacancy claim held because the company was "someone else's customer". Root cause: the customer-mention
// check fired on a job board page ("Apply using DentalPost") - any customer word anywhere on the page, plus the board's
// name near the company. Synthetic pages and invented companies only; no network, no provider, no spend.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { counterpartySignal } from '../lib/scan/counterparty.ts'
import { verifyLeads } from '../lib/scan/runner.ts'
import { holdFitsClaim, isJobPostingClaim, MISFIT_LABEL } from '../lib/scan/hold-fit.ts'
import { CAUSE_TEXT, heldState, researchCause, uncheckableCause } from '../lib/lead-state.ts'
import { reviewAction } from '../lib/scan/review-action.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { listCampaigns } from '../lib/outreach/campaigns.ts'
import { currentnessHeld } from '../lib/outreach/currentness.ts'
import { listLeads } from '../lib/scan/store.ts'
import { readyItems } from '../lib/ready-card.ts'
import type { ReadinessInput } from '../lib/readiness.ts'

const NOW = new Date('2026-11-04T12:00:00Z')
const BOARD = 'https://www.dentalpost.net/dental-jobs/front-desk-receptionist/12345/'
const VACANCY = 'Smile Dental Care is hiring a front desk receptionist for its Brooklyn office'
const boardPage = {
  title: 'Front Desk Receptionist - Smile Dental Care | DentalPost',
  text: `${VACANCY}. Full time, Monday to Friday. Apply using DentalPost in two minutes. Thousands of practices use DentalPost to hire their teams.`,
  retrievedAt: 1793750400,
}
const vacancy = { name: '', company: 'Smile Dental Care', contact: null, signal: 'Hiring a front desk receptionist', source_url: BOARD, score: 70, excerpt: VACANCY, event_date: null }

const linearLead = { name: '', company: 'Salesforce', contact: null, signal: 'Salesforce became a Linear customer earlier this year', source_url: 'https://linear.app/now/sharing-growth', score: 80, excerpt: 'Salesforce and Figma, which both became customers earlier this year', event_date: null }
const linearPage = { title: 'Sharing growth with the people building Linear', text: 'Linear grew fast. Salesforce and Figma, which both became customers earlier this year. Many leading AI companies, including OpenAI, also run product development in Linear.', retrievedAt: 1792696500 }

// ---------- the writer: the stored hold reason is one that applies to the claim ----------

test('#684 audit case: a receptionist vacancy on a job board is never held as someone else\'s customer', async () => {
  assert.equal(counterpartySignal(vacancy, boardPage, ''), null)
  const r = await verifyLeads([vacancy], async () => boardPage, NOW)
  for (const l of r.review) assert.notEqual(l.review_reason, 'counterparty_signal')
  // a structured hiring kind with a signal that does not say "hiring" is a job posting too
  assert.equal(counterpartySignal({ ...vacancy, signal: 'Front desk receptionist, Brooklyn', signal_kind: 'hiring' } as typeof vacancy, boardPage, ''), null)
  assert.equal(counterpartySignal({ ...vacancy, signal: 'Front desk receptionist, Brooklyn', source_kind: 'hiring_feed' } as typeof vacancy, boardPage, ''), null)
})

test('#684: a customer word in another sentence does not make the claim a customer mention', () => {
  // Not a hiring claim: the only customer words ("using", "use") are in sentences that do not name the company.
  const office = { ...vacancy, signal: 'Smile Dental Care opened a second Brooklyn office', excerpt: 'Smile Dental Care opened a second office in Brooklyn' }
  const page = { ...boardPage, title: 'Smile Dental Care news | DentalPost', text: 'Smile Dental Care opened a second office in Brooklyn this month. Apply using DentalPost in two minutes. Thousands of practices use DentalPost.' }
  assert.equal(counterpartySignal(office, page, ''), null)
  // the same check on the verified passage (evidence recheck path)
  assert.equal(counterpartySignal(office, page, 'Smile Dental Care opened a second office in Brooklyn this month. Apply using DentalPost.'), null)
})

test('#684: a real customer page still holds the lead as someone else\'s customer (gate not loosened)', async () => {
  assert.equal(counterpartySignal(linearLead, linearPage, ''), 'source_owner:linear')
  const weave = { ...linearLead, company: 'Smile Dental Care', signal: 'Smile Dental Care uses Weave for reminders', source_url: 'https://www.getweave.com/customers/smile-dental', excerpt: 'Smile Dental Care switched to Weave for patient reminders this year' }
  const weavePage = { title: 'Customer story | Weave', text: 'Weave helps practices grow. Smile Dental Care switched to Weave for patient reminders this year. Their front desk saves hours.', retrievedAt: 1 }
  assert.equal(counterpartySignal({ ...weave, source_url: 'https://weave.example/customers/smile-dental' }, weavePage, ''), 'source_owner:weave')
  const r = await verifyLeads([linearLead], async () => linearPage, NOW)
  assert.equal(r.review[0]?.review_reason, 'counterparty_signal')
  // malformed claim fields never count as a job posting, so they never skip the hold
  for (const bad of [{ signal_kind: 42 }, { signal_kind: { hiring: true } }, { source_kind: ['hiring_feed'] }, { signal_kind: 'HIRING ' }, { signal_kind: null }])
    assert.equal(counterpartySignal({ ...linearLead, ...bad } as typeof linearLead, linearPage, ''), 'source_owner:linear', JSON.stringify(bad))
})

test('#684: isJobPostingClaim is positive evidence only; malformed input is not a job posting', () => {
  assert.equal(isJobPostingClaim({ signal: 'Hiring a front desk receptionist' }), true)
  assert.equal(isJobPostingClaim({ signal: 'x', signal_kind: 'hiring' }), true)
  assert.equal(isJobPostingClaim({ signal: 'x', signal_kind: 'hiring_relevant_role' }), true)
  assert.equal(isJobPostingClaim({ signal: 'x', source_kind: 'hiring_feed' }), true)
  for (const c of [{}, { signal: null }, { signal: 42 }, { signal: { hiring: 1 } }, { signal: ['hiring'] }, { signal: 'Salesforce became a Linear customer' }, { signal_kind: 'funding' }, { source_kind: 'news' }, { signal: 'x'.repeat(200_000) }] as Record<string, unknown>[])
    assert.equal(isJobPostingClaim(c), false, JSON.stringify(c).slice(0, 80))
  assert.equal(isJobPostingClaim(null as never), false)
  assert.equal(isJobPostingClaim(undefined as never), false)
})

// ---------- stored rows from before the fix: shown reason fits the claim, gates unchanged ----------

const stored = { id: 'l1', company: 'Smile Dental Care', signal: 'Hiring a front desk receptionist', source_url: BOARD, evidence_excerpt: VACANCY, event_date: null, date_status: 'undated', review_reason: 'counterparty_signal', fit: 4, intent: null, why: null, icp_match: null, company_domain: null, contact: null }

test('#684: a stored customer-mention hold on a job-posting claim is not shown as a customer reason anywhere', () => {
  assert.equal(holdFitsClaim('counterparty_signal', stored), false)
  // Home journey: still research (no check can make it ready), but the shown cause is not "someone else's customer"
  const h = heldState(stored)
  assert.equal(h?.state, 'research')
  assert.notEqual(h?.cause, 'customer')
  assert.equal(researchCause(stored), 'unsupported')
  assert.ok(!/customer/i.test(CAUSE_TEXT[h!.cause!]), CAUSE_TEXT[h!.cause!])
  // Leads card action: still Keep as research, hint names no customer relationship
  const a = reviewAction(stored, NOW)
  assert.equal(a.label, 'Keep as research')
  assert.ok(!/customer/i.test(a.hint), a.hint)
  // Leads label: the misfit text, never the customer label
  assert.ok(!/someone else.s customer/i.test(MISFIT_LABEL))
  assert.match(MISFIT_LABEL, /not verified/i)
  assert.match(MISFIT_LABEL, /out of drafting/i)
})

test('#684: where the customer reason fits the claim, it is still shown as such', () => {
  const fit = { ...stored, signal: 'Smile Dental Care became a Weave customer', evidence_excerpt: 'Smile Dental Care switched to Weave' }
  assert.equal(holdFitsClaim('counterparty_signal', fit), true)
  assert.equal(heldState(fit)?.cause, 'customer')
  assert.match(reviewAction(fit, NOW).hint, /customer/)
  // every other stored reason is shown as stored, whatever the claim
  for (const r of ['quote_unconfirmed', 'job_closed', 'location_mismatch', 'no_event_evidence', 'event_timing_unconfirmed', 'outside_window_undated'])
    assert.equal(holdFitsClaim(r, stored), true, r)
  // malformed reason / claim: the stored reason is shown (never silently replaced), and the research state is unchanged
  for (const r of [null, undefined, 42, {}, ['counterparty_signal'], 'constructor', '__proto__', ''] as unknown[]) assert.equal(holdFitsClaim(r, stored), true, String(r))
  for (const c of [null, undefined, 42, 'x', { signal: 42 }] as unknown[]) assert.equal(holdFitsClaim('counterparty_signal', c as never), true, String(c))
})

test('#684: the gates on a stored misfit row are exactly as before (fail closed)', () => {
  // The reason code is untouched, so every gate that reads it still holds the lead.
  assert.equal(uncheckableCause('counterparty_signal'), 'customer')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES ('j1','A','x','(from request)','-','NYC dental practices hiring','running',1)").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason) VALUES ('l1','j1','Smile Dental Care','Hiring a front desk receptionist',?,NULL,?,'counterparty_signal')").run(BOARD, VACANCY)
  db.prepare("UPDATE leads SET human_confirmed_at = 5, human_confirmed_from = review_reason, review_reason = NULL WHERE id = 'l1'").run()
  assert.equal(currentnessHeld(db, 'A', 'l1'), true, 'confirming a stored customer hold still never makes it draftable')
  const row = (listLeads(db, 'A', 'j1') as { review_reason: string | null; human_confirmed_from: string | null }[])[0]
  assert.equal(row.human_confirmed_from, 'counterparty_signal', 'the read path does not rewrite the stored reason')
})

test('#684: the Leads view uses the claim-aware label for review rows and confirmed rows', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  // every place that turns a stored hold reason into text goes through the claim check
  const uses = src.match(/reviewLabel\(/g)?.length ?? 0
  const guarded = src.match(/holdText\(/g)?.length ?? 0
  assert.ok(guarded >= 2, `holdText used ${guarded} times`)
  assert.equal(uses, 1, 'reviewLabel is called only from inside holdText')
  assert.match(src, /const holdText = [^\n]*holdFitsClaim\(/)
})

// ---------- Home: the count, its wording and its Review link describe the same leads (live supplement, 2026-11-04) ----------

test('#684 live supplement: Home\'s count and wording match the run its Review link opens, across several runs', () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  let t = 100
  const job = (id: string, q: string) => db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, 'A', 'x', '(from request)', '-', ?, 'running', ?)").run(id, q, t++)
  const lead = (j: string, id: string, review: string | null, conf: number | null) => db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason) VALUES (?, ?, ?, 'opened an office', 'https://news.example/x', ?, 'Co opened an office in Brooklyn', ?)").run(id, j, `Co ${id}`, conf, review)
  // older run: 6 hiring-feed rows in review (a claimed event day unconfirmed)
  job('feed', 'Hiring feed intake')
  for (let i = 0; i < 6; i++) lead('feed', `f${i}`, 'event_timing_unconfirmed', null)
  // newest run: 1 source-checked lead held (no timing proof), 7 saved quotes unconfirmed, 2 dropped elsewhere
  job('dental', 'NYC dental practices')
  lead('dental', 'd0', null, 80)
  for (let i = 1; i <= 7; i++) lead('dental', `d${i}`, 'quote_unconfirmed', null)
  db.prepare("UPDATE scan_jobs SET status = 'done'").run()
  const campaigns = listCampaigns(db, 'A')
  const input = { profile: { website: 'https://brightsmile.example', buyer: { summary: 's', who: ['Owner'] } }, usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null,
    outreach: { gmail: null, sender: null, daily_cap: 20 }, sources: { web_index: false, news: true, websites: true }, advanced: { available: true, platforms: [] },
    jobs: [], totals: { searches: 2, finished: 2 }, campaigns, messages: [] } as unknown as ReadinessInput
  const q = readyItems(input).find(x => x.id === 'qualified')!
  assert.ok(q.fix, q.detail)
  const opened = /job_id=([a-z0-9]+)/.exec(q.fix!.href)?.[1]
  assert.equal(opened, 'dental', 'the link opens the newest run with leads to look at')
  const shown = (listLeads(db, 'A', opened!) as { id: string; review_reason: string | null }[])
  const counted = Number(q.detail.split(' ')[0])
  const destHeldOrReview = shown.filter(l => l.review_reason || currentnessHeld(db, 'A', l.id)).length
  assert.equal(counted, destHeldOrReview, `${q.detail} vs ${destHeldOrReview} on the opened run`)
  assert.equal(counted, 8)
  // the wording claims no hold reason the counted leads do not carry (they are quote / timing-proof holds, not event dates)
  assert.ok(!/event date|wait for/i.test(q.detail), q.detail)
})
