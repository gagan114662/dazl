// #1238 / #684: a new-engine lead has ONE status on every page. A read-only map of lead status (2026-11-24) found pages that disagreed
// about the same lead: the Leads header, Campaigns and Home's tile counted a lead "ready by email" whose card said "Can't approve yet"
// (its address was on the do-not-contact list, a free-webmail address, or had a failed mailbox check), because only the card was
// given the verdict on the address.
//
// This test stores EVERY combination of the facts a status is read from in a real database, then asks each page's own code about each
// lead. All of them must give the state this file's own short rule expects, and the server's draft check must accept a lead exactly
// when that state is "ready by email". Nothing here reads source text: every surface is called.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { addEnrichment, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { getJob, listLeads } from '../lib/scan/store.ts'
import { DISCOVER_STATE_LABEL, discoverCounts, discoverReady, discoverState, type DiscoverState } from '../lib/discover/card.ts'
import { discoverJobCounts, discoverReadForDb } from '../lib/discover/state-db.ts'
import { discoverExportFields } from '../lib/discover/export.ts'
import { previewSplit, type PreviewLead } from '../lib/journey.ts'
import { heldState } from '../lib/lead-state.ts'
import { leadHoldReason, timingOptsFor } from '../lib/outreach/lead-hold.ts'
import { historyCampaigns, listCampaigns } from '../lib/outreach/campaigns.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { campaignStatus, currentQual } from '../lib/run-status.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { opportunityCard } from '../lib/scan/opportunity.ts'
import { eventDayVerified, surfaceStoredIntent } from '../lib/scan/scoreboard.ts'
import { createDraft, discoverRecipientRefusal, OutreachError } from '../lib/outreach/service.ts'

const T = 'A', J = 'a'.repeat(24)

// The stored facts, and every value each can take.
//   address: none; a shared inbox; a colleague's; a privacy inbox; the named person's own at the company's domain; their own at another
//            domain, printed on the company's site or only on a directory; their own at a free-webmail provider, printed on the company's site
//   check:   what is recorded about that address: nothing, the workspace's do-not-contact list, or a failed mailbox check
const DIM = {
  rejected: [false, true],
  review: [null, 'source_review_required'],
  date: ['none', 'recent', 'old'],
  grade: ['fit', 'unfit'],
  person: ['none', 'title', 'name'],
  address: ['none', 'shared', 'colleague', 'privacy', 'own', 'own_other_onsite', 'own_other_offsite', 'own_webmail'],
  linkedin: ['none', 'company', 'profile'],
  check: ['clear', 'suppressed', 'bounced'],
} as const
type Combo = { [K in keyof typeof DIM]: (typeof DIM)[K][number] }
const combos = (Object.keys(DIM) as (keyof typeof DIM)[]).reduce<Record<string, unknown>[]>((all, k) => all.flatMap(c => (DIM[k] as readonly unknown[]).map(v => ({ ...c, [k]: v }))), [{}]) as Combo[]

// The rule, written out once more here and deliberately not imported: the state each combination must have on every page.
const OWN: readonly string[] = ['own', 'own_other_onsite', 'own_other_offsite', 'own_webmail']
const proofFine = (c: Combo) => !c.rejected && !c.review && c.date === 'recent' && c.grade === 'fit'
const hasOwnAddress = (c: Combo) => c.person === 'name' && OWN.includes(c.address)
function expected(c: Combo): DiscoverState {
  if (c.rejected) return 'rejected'
  if (c.review) return 'review'
  if (c.date !== 'recent' || c.grade === 'unfit') return 'research'
  // by email: the named person's own address, the company's (its domain, or printed on its site), with nothing recorded against it
  if (c.person === 'name' && (c.address === 'own' || c.address === 'own_other_onsite') && c.check === 'clear') return 'ready_email'
  // on LinkedIn: the named person's own profile, unless their own address is on the do-not-contact list
  if (c.person === 'name' && c.linkedin === 'profile' && !(hasOwnAddress(c) && c.check === 'suppressed')) return 'ready_linkedin'
  return 'no_contact'
}
// The card's reason where this file pins it word for word (null: not pinned for this combination).
const SAYS = {
  dnc: 'This address is on your do-not-contact list.',
  webmail: 'The published address is a personal mailbox (free webmail), not a company address.',
  bounced: 'This address cannot receive mail (invalid domain or a failed mailbox check).',
  privacy: 'The published address is a press, support or privacy inbox, not a sales contact.',
  offsite: 'The address is not at the company\'s own domain and was not found on the company\'s own website, only on another site.',
}
function cardReason(c: Combo): string | null {
  if (!proofFine(c)) return null
  if (c.address === 'privacy') return SAYS.privacy
  if (!hasOwnAddress(c)) return null
  if (c.address === 'own_other_offsite') return SAYS.offsite
  if (c.check === 'suppressed') return SAYS.dnc
  if (c.address === 'own_webmail') return SAYS.webmail
  return c.check === 'bounced' ? SAYS.bounced : null
}

const idOf = (i: number) => i.toString(16).padStart(24, '0')
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10)
function addressOf(c: Combo, i: number, site: string): { value: string; page: string } | null {
  switch (c.address) {
    case 'none': return null
    case 'shared': return { value: `info@${site}`, page: `https://${site}/contact` }
    case 'colleague': return { value: `sam.patel@${site}`, page: `https://${site}/team` }
    case 'privacy': return { value: `privacy@${site}`, page: `https://${site}/privacy` }
    case 'own': return { value: `dana.ruiz@${site}`, page: `https://jobs.example/posting-${i}` }
    case 'own_other_onsite': return { value: `dana.ruiz@mail-${i}.example`, page: `https://${site}/team` }
    case 'own_other_offsite': return { value: `dana.ruiz@mail-${i}.example`, page: `https://directory.example/entry-${i}` }
    case 'own_webmail': return { value: `dana.ruiz+${i}@gmail.com`, page: `https://${site}/team` }
  }
}

function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES (?, ?, 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run(J, T)
  const lead = db.prepare(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain, review_reason, quarantined_at)
    VALUES (?, ?, ?, ?, 'Opening a second clinic', ?, 85, 'will open its second clinic', ?, ?, 85, ?, ?, 'expanding', 'discover', ?, ?, ?)`)
  const suppress = db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES (?, ?, 'manual')")
  db.transaction(() => combos.forEach((c, i) => {
    const id = idOf(i), site = `company-${i}.example`
    const date = c.date === 'none' ? null : day(c.date === 'recent' ? 30 : 400)
    lead.run(id, J, c.person === 'name' ? 'Dana Ruiz' : c.person === 'title' ? 'Managing Partner' : '', `Company ${i}`, `https://news.example/story-${i}`, date, date ? 'unverified' : 'undated',
      c.grade === 'fit' ? 4 : 0, c.grade === 'fit' ? 4 : null, site, c.review, c.rejected ? 5 : null)
    const row = (connector: string, kind: string, value: string, page: string, at = 1) => addEnrichment(db, T, id, { connector, kind, value, label: 'x', confidence: null, source_url: page, source_date: day(2), retrieved_at: at })
    if (c.person !== 'none') row('discover', 'person', c.person === 'name' ? 'Dana Ruiz, Founder' : 'Managing Partner, Practice Owner', `https://${site}/team`)
    const mail = addressOf(c, i, site)
    if (mail) row('discover', 'email', mail.value, mail.page)
    if (c.linkedin !== 'none') row('discover', 'linkedin', c.linkedin === 'profile' ? 'https://www.linkedin.com/in/dana-ruiz/' : `https://www.linkedin.com/company/company-${i}/`, `https://${site}/team`)
    if (mail && c.check === 'suppressed') suppress.run(T, mail.value)
    if (mail && c.check === 'bounced') row('checker', 'deliverability', `${mail.value}|rejected`, `https://${site}/team`, 2)
  }))()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(J)
  return db
}

test('every combination of the stored facts: every page gives a new-engine lead the same status, and a draft is accepted exactly when it is ready by email', async () => {
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  assert.equal(combos.length, 2 * 2 * 3 * 2 * 3 * 8 * 3 * 3)
  const db = build(), adb = sqliteDb(db)
  const want = combos.map(expected)
  const counts = discoverCounts(want)
  for (const s of Object.keys(DISCOVER_STATE_LABEL) as DiscoverState[]) assert.ok(counts[s] > 0, `the combinations include a ${s} lead`)

  // --- the pages that count -------------------------------------------------------------------------------------------------------
  // The Leads header (GET /api/leads discover_counts).
  assert.deepEqual(await discoverJobCounts(adb, T, J), counts, 'Leads header')
  // One campaign's page (GET /api/campaigns/<id>).
  const detail = (await campaignDetail(adb, T, J))!
  assert.deepEqual(currentQual(detail.leads).discover, counts, 'campaign page')
  // The Campaigns list and Leads > Past scans.
  const recorded = { id: J, status: 'done', error: null, query: 'q', candidates: combos.length, verified: combos.length, needs_review: 0, dropped: 0, lead_count: combos.length }
  assert.deepEqual(campaignStatus(listCampaigns(db, T)[0], recorded as never).qualification.discover, counts, 'Campaigns list')
  assert.deepEqual(campaignStatus((await historyCampaigns(db, adb, T, [J]))[0], recorded as never).qualification.discover, counts, 'Past scans')

  // --- the leads as GET /api/leads sends them (app/api/leads/route.ts): the row, the saved grade beside the shown one, the proof of the
  // day, the stored rows, and the verdict on the address from the same read the header's counts come from ---------------------------------
  const job = getJob(db, T, J) as { id: string; query: string | null; icp: string | null }
  const timing = timingOptsFor(job)
  const stored = listLeads(db, T, J, 100_000, true) as (PreviewLead & { intent: number | null; name: string | null })[]
  assert.equal(stored.length, combos.length)
  const enr: Record<string, unknown[]> = {}
  for (let i = 0; i < stored.length; i += 400) Object.assign(enr, enrichmentsForLeads(db, T, stored.slice(i, i + 400).map(l => l.id)))
  const read = await discoverReadForDb(adb, T, [J])
  const raw = new Map(stored.map(l => [l.id, l]))
  const sent = new Map(stored.map(l => [l.id, { ...l, stored_intent: l.intent, intent: surfaceStoredIntent(l as never, timing).intent, day_verified: eventDayVerified(l as never), gate_held: false,
    enrichments: enr[l.id] ?? [], recipient_refused: read.refused.get(l.id) ?? null } as unknown as PreviewLead]))

  // Home's play card (lib/journey.ts previewSplit).
  const split = previewSplit([...sent.values()])
  assert.deepEqual({ ready: split.opportunities.length, review: split.review.length, research: split.research.length, no_contact: split.noContact.length, rejected: split.rejected.length },
    { ready: counts.ready, review: counts.review, research: counts.research, no_contact: counts.no_contact, rejected: counts.rejected }, 'Home play card')

  // The spreadsheet's status column (GET /api/leads/export).
  const csv = await discoverExportFields(adb, T, stored.map(l => ({ lead_id: l.id, job_id: J, source_kind: 'discover', name: l.name, contact: null, event_date: l.event_date, event_date_proof: null })))

  // --- lead by lead ---------------------------------------------------------------------------------------------------------------
  const onPage = new Map(detail.leads.map(l => [l.id, l.discover_state]))
  const now = new Date()
  combos.forEach((c, i) => {
    const id = idOf(i), s = want[i], l = sent.get(id)!, at = `${JSON.stringify(c)} -> ${s}`
    // the server's state (the header, Campaigns, the campaign page) and the browser's, from the row it was sent
    assert.equal(read.states.get(J)!.get(id), s, `server: ${at}`)
    assert.equal(onPage.get(id), s, `campaign page: ${at}`)
    assert.equal(discoverState(l as never), s, `browser: ${at}`)
    // the verdict on the address: the Db-layer reader and the synchronous one (Home's tile) agree
    assert.equal(discoverRecipientRefusal(db, T, id), read.refused.get(id) ?? null, `both readers of the address verdict: ${at}`)
    // Home's "Ready leads" tile and the checked list (lib/outreach/home-ready.ts judges each lead with leadHoldReason)
    const why = leadHoldReason(db, T, raw.get(id) as never, enr[id] ?? [], timing, now)
    assert.equal(why === null, discoverReady(s), `Home tile (${why}): ${at}`)
    if (!c.rejected && !c.review && c.date === 'old') assert.equal(why, 'the signal is more than a year old', at)
    if (!c.rejected && !c.review && c.date === 'none') assert.equal(why, 'the signal has no date, so its timing is unknown', at)
    if (!c.rejected && !c.review && c.date === 'recent' && c.grade === 'unfit') assert.equal(why, 'graded as not a fit for your profile', at)
    // Home's play card, one lead: the state and the cause its words come from
    const h = heldState(l)
    assert.deepEqual(h, discoverReady(s) ? null : s === 'rejected' || s === 'review' ? { state: s, cause: null }
      : s === 'no_contact' ? { state: 'research', cause: 'contact' } : { state: 'research', cause: c.date === 'none' ? 'undated' : c.date === 'old' ? 'stale' : 'unfit' }, `Home play card: ${at}`)
    // the card: Approve is on exactly when it is ready by email; Message on LinkedIn is the action exactly when it is ready on LinkedIn
    const card = leadCardSummary(l as never)
    assert.equal(card.approve.ok, s === 'ready_email', `Approve (${card.approve.ok ? 'on' : card.approve.reason}): ${at}`)
    assert.equal(!!card.linkedin && !card.approve.ok, s === 'ready_linkedin', `Message on LinkedIn: ${at}`)
    const reason = cardReason(c)
    if (reason) assert.deepEqual(card.approve, { ok: false, reason }, `the card's reason: ${at}`)
    // the opportunity card's next step
    const next = opportunityCard(l as never).next
    const step: Record<DiscoverState, RegExp> = { rejected: /^None: quarantined\.$/, review: /^Check the source yourself before using this lead\.$/, research: /^(The signal |Graded as not a fit)/,
      ready_email: /^Draft a first message to Dana Ruiz /, ready_linkedin: /^Message Dana Ruiz on LinkedIn yourself/, no_contact: /^Find / }
    assert.match(next, step[s], `next step: ${at}`)
    // the spreadsheet
    assert.equal(csv.get(id)?.lead_status, DISCOVER_STATE_LABEL[s], `spreadsheet: ${at}`)
  })

  // --- the server's draft check (the Approve button: POST /api/outreach -> createDraft, manual) -------------------------------------
  // Last, because it writes. It accepts a lead exactly when every page above called it ready by email, so the card and the server cannot
  // drift apart. Every lead here has machine evidence (an excerpt and a confidence) and no address is a test fixture: the draft check also
  // refuses a lead with neither machine nor human evidence, and an inbox-fixture address, and no page's rule mirrors those two refusals.
  combos.forEach((c, i) => {
    let code = 'created'
    try { createDraft(db, T, idOf(i), 'Fit-out Co', { manual: true }) } catch (e) { if (!(e instanceof OutreachError)) throw e; code = e.code }
    assert.equal(code === 'created', want[i] === 'ready_email', `draft (${code}): ${JSON.stringify(c)} -> ${want[i]}`)
  })
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM outreach_messages WHERE tenant_id = ?').get(T) as { n: number }).n, counts.ready_email)
})
