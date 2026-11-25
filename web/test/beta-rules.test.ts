// The beta rules the owner fixed on 2026-11-23, as the signed-in app must obey them:
//   A. autopilot is not available: with the switch off, an account whose stored setting says "enabled" sends nothing;
//   B. no automatic function drafts to a shared inbox (info@, sales@, hello@ ...);
//   C. the next step names Approve when a draft is possible by hand and LinkedIn when only the profile is known (#1583).
// The routes (enable refused, checkout refused) are in test/beta-rules-routes.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { createDraft, draftBlockReason, manualDraftBlockReason, saveSettings, OutreachError, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, autopilotAvailable, CONSENT_VERSION, drainFirstTouch, enable, getState, migrateAutopilot, runAutopilot } from '../lib/outreach/autopilot.ts'
import { runFollowups } from '../lib/outreach/followups.ts'
import { listCampaigns, nextAction } from '../lib/outreach/campaigns.ts'
import { readyItems } from '../lib/ready-card.ts'
import { AUTOPILOT_BETA_TEXT, BILLING_BETA_TEXT, autopilotInBeta, billingAvailable } from '../lib/beta.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import type { ReadinessInput } from '../lib/readiness.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at' }) : json({}, 404))) as unknown as typeof fetch
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// An account as test/autopilot.test.ts sets one up: Gmail connected, sender details saved, autopilot schema present.
async function account() {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); seedOffers(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  return db
}
function oldLead(db: Database.Database, contact: string | null) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, 'Co ' + id.slice(0, 4), contact, 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id = ?").run(id)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return id
}
const sender = (flags: Record<string, string>) => { const sent: string[] = []; const d: Deps & { flags: Record<string, string> } = { flags, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never }; return { sent, d } }
const code = (fn: () => unknown) => { try { fn(); return 'created' } catch (e) { if (e instanceof OutreachError) return e.code; throw e } }

// ---- A ----
test('A: the switch is off unless AUTOPILOT_AVAILABLE is exactly 1, whatever the older operator flag says', () => {
  assert.equal(autopilotInBeta({}), false)
  assert.equal(autopilotAvailable({}), false)
  assert.equal(autopilotAvailable({ AUTOPILOT_ENABLED: '1' }), false, 'the older operator flag alone no longer makes autopilot available')
  assert.equal(autopilotAvailable({ AUTOPILOT_AVAILABLE: 'true', AUTOPILOT_ENABLED: '1' }), false)
  assert.equal(autopilotAvailable({ AUTOPILOT_AVAILABLE: '1' }), false, 'both are needed')
  assert.equal(autopilotAvailable({ AUTOPILOT_AVAILABLE: '1', AUTOPILOT_ENABLED: '1' }), true)
  assert.equal(autopilotAvailable({ AUTOPILOT_AVAILABLE: '1', AUTOPILOT_ENABLED: '1', AUTOPILOT_KILL: '1' }), false, 'the kill switch still wins')
})

test('A: an account that already has autopilot enabled in the database sends nothing while the switch is off', async () => {
  const db = await account()
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
  db.prepare('UPDATE autopilot_settings SET followups_enabled = 1 WHERE tenant_id = ?').run('A')
  assert.equal(getState(db, 'A').enabled, true, 'the stored setting says on')
  for (let i = 0; i < 4; i++) oldLead(db, `pat${i}@one${i}.example`)
  // the older operator flag is on, as on a server configured before the beta rule
  const off = sender({ AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' })
  assert.equal((await runAutopilot(db, 'A', 'Acme', off.d)).stopped, 'not_available')
  assert.equal((await drainFirstTouch(db, 'A', { ...off.d, businessName: 'Acme' })).stopped, 'not_available')
  assert.equal((await runFollowups(db, 'A', 'Acme', off.d as never)).stopped, 'not_available')
  assert.equal(off.sent.length, 0, 'nothing was sent')
  assert.equal((db.prepare('SELECT count(*) AS n FROM outreach_messages').get() as { n: number }).n, 0, 'and nothing was drafted')
  // the same account, the same leads, with the switch on: autopilot runs (the code is kept, only gated)
  // (it drafts them and holds them as its warm-up drafts for the user's approval)
  const on = sender({ AUTOPILOT_AVAILABLE: '1', AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' })
  const r = await runAutopilot(db, 'A', 'Acme', on.d)
  assert.notEqual(r.stopped, 'not_available')
  assert.equal(r.held, 4, 'with the switch on the same leads are picked up')
  assert.equal((db.prepare('SELECT count(*) AS n FROM outreach_messages').get() as { n: number }).n, 4)
})

test('A: Settings says autopilot is not available and offers nothing to turn on', () => {
  assert.equal(AUTOPILOT_BETA_TEXT, 'Autopilot is not available during the beta. Every message is reviewed and sent by you.')
  const panel = src('app/app/settings/autopilot-panel.tsx')
  const unavailable = panel.slice(panel.indexOf('if (!i.available) return ('), panel.indexOf('return (', panel.indexOf('if (!i.available) return (') + 30))
  assert.match(unavailable, /unavailable_text \?\? AUTOPILOT_BETA_TEXT/)
  assert.doesNotMatch(unavailable, /Turn on autopilot|action: 'enable'|action: 'resume'/, 'no way to turn it on or resume it while unavailable')
  assert.match(unavailable, /action: 'disable'/, 'an account that had it on can clear its stored setting')
  const route = src('app/api/outreach/autopilot/route.ts')
  assert.match(route, /else if \(!autopilotAvailable\(\)\) return NextResponse\.json\(\{ error: AUTOPILOT_BETA_TEXT/)
  // every action that turns sending on comes after that refusal; pause, turn off and withdraw come before it
  const gate = route.indexOf('else if (!autopilotAvailable())')
  for (const a of ['enable', 'resume', 'accept_launch_policy', 'reaccept_product_truth', 'launch_calibrated']) assert.ok(route.indexOf(`body?.action === '${a}'`) > gate, a)
  for (const a of ['pause', 'disable', 'withdraw_launch_policy']) assert.ok(route.indexOf(`body?.action === '${a}'`) < gate, a)
  // pages that used to invite the user to turn autopilot on only say so when it is available
  for (const p of ['app/app/outreach/send-readiness.tsx', 'app/app/settings/gmail-panel.tsx', 'app/app/outreach/outreach-client.tsx']) {
    for (const line of src(p).split('\n').filter(l => /if you turn it on/.test(l))) assert.match(line, /autopilot \?|autopilotOn \?|autopilot_available/, `${p}: the invitation is conditional`)
  }
})

// ---- B ----
test('B: no automatic draft goes to a shared inbox; a named address still drafts; the manual path is unchanged', async () => {
  const db = await account()
  for (const shared of ['info@co.example', 'sales@co.example', 'hello@co.example', 'reception@co.example', 'founders@co.example', 'Contact.Us@co.example']) {
    const id = oldLead(db, shared)
    assert.equal(code(() => createDraft(db, 'A', id, 'Acme')), 'no_email_contact', `${shared}: an automatic draft is refused`)
    assert.equal(draftBlockReason(db, 'A', id), 'no_email_contact')
  }
  const named = oldLead(db, 'dana.ruiz@co.example')
  assert.equal(draftBlockReason(db, 'A', named), null)
  assert.equal(code(() => createDraft(db, 'A', named, 'Acme')), 'created', 'a person\'s own address is drafted to as before')
  // an older-engine lead a person approves by hand keeps today's behaviour (this rule is about automatic functions)
  const byHand = oldLead(db, 'info@hand.example')
  assert.equal(manualDraftBlockReason(db, 'A', byHand), null)
})

test('B: autopilot, with the switch on, skips a lead whose only address is a shared inbox and drafts only for the named one', async () => {
  const db = await account()
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  oldLead(db, 'sales@shared.example'); oldLead(db, 'pat.lee@named.example')
  const { sent, d } = sender({ AUTOPILOT_AVAILABLE: '1', AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' })
  const r = await runAutopilot(db, 'A', 'Acme', d)
  const to = (db.prepare('SELECT to_email FROM outreach_messages ORDER BY to_email').all() as { to_email: string }[]).map(m => m.to_email)
  assert.deepEqual(to, ['pat.lee@named.example'], 'autopilot drafted to the named person; no draft exists for the shared inbox')
  assert.deepEqual([r.held, r.skipped], [1, 1])
  const skipped = db.prepare("SELECT detail FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'skipped'").all() as { detail: string }[]
  assert.deepEqual(skipped.map(a => a.detail), ['no_email_contact'], 'recorded as a lead with no contact, so it is not retried every pass')
  assert.doesNotMatch(sent.join('\n'), /sales@shared\.example/)
})

test('B: the reason a user reads is a plain sentence', () => {
  const route = src('app/api/outreach/route.ts')
  const m = /no_email_contact: \[422, '([^']+)'\]/.exec(route)
  assert.ok(m)
  assert.match(m![1], /shared inbox such as info@ or sales@/)
  assert.doesNotMatch(m![1], /_/)
})

// ---- C (#1583) ----
const person = { connector: 'discover', kind: 'person', value: 'Dana Ruiz, Practice Owner', label: 'named on a public page', source_url: 'https://northwind-dental.example/team' }
const email = { connector: 'discover', kind: 'email', value: 'dana@northwind-dental.example', label: 'published on a public page', source_url: 'https://northwind-dental.example/contact' }
const linkedin = { connector: 'discover', kind: 'linkedin', value: 'https://www.linkedin.com/in/dana-ruiz/', label: 'linked from a public page', source_url: 'https://northwind-dental.example/team' }
function discoverDb() {
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  return db
}
let seq = 0
function discoverLead(db: Database.Database, jobId: string, rows: (typeof person)[], o: { date?: string | null } = {}) {
  if (!db.prepare('SELECT 1 FROM scan_jobs WHERE id = ?').get(jobId)) db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller, created_at) VALUES (?, 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor', ?)").run(jobId, 1000 + ++seq)
  const id = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain) VALUES (?, ?, 'Dana Ruiz', 'Northwind Dental', 'Opening a second clinic', 'https://news.example/northwind', 85, 'Northwind Dental will open its second clinic', ?, 'verified', 85, 4, 4, 'expanding', 'discover', 'northwind-dental.example')").run(id, jobId, o.date === undefined ? '2026-10-14' : o.date)
  for (const r of rows) addEnrichment(db, 'T', id, { ...r, confidence: null, source_date: '2026-11-22', retrieved_at: Math.floor(Date.now() / 1000) })
  return id
}
// finished: the next step is read from a finished search
const finish = (db: Database.Database, jobId: string) => { db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId) }
// Home's checklist as the page builds it: the campaigns read is what /api/campaigns returns
const home = (db: Database.Database): ReadinessInput => ({
  profile: { website: 'https://seller.example', sells: 'Fit-outs', business_name: 'Seller', buyer: { summary: 'Dental clinics', who: ['Owner'] } },
  usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null,
  outreach: { gmail: { email: 'me@seller.example', status: 'active' }, sender: { sender_name: 'Pat', postal_address: '1 Main St' }, daily_cap: 20 },
  sources: { web_index: false, news: true, websites: true }, advanced: { available: true, platforms: [] },
  jobs: [{ id: 'j', status: 'done', error: null, query: 'q', csv_domain: null, created_at: 1, lead_count: 1 }], totals: { searches: 1, finished: 1 },
  campaigns: listCampaigns(db, 'T') as never, messages: [],
})

test('C: a dated discovery lead with the person\'s own address on the company site: Campaigns and Home both name Approve', () => {
  const db = discoverDb()
  const id = discoverLead(db, 'je', [person, email]); finish(db, 'je')
  assert.notEqual(draftBlockReason(db, 'T', id), null, 'the automatic gate does not read the published address (why the hint was wrong)')
  assert.equal(manualDraftBlockReason(db, 'T', id), null, 'the Approve button would create the draft')
  const c = listCampaigns(db, 'T').find(x => x.id === 'je')!
  assert.equal(c.contact.draftable, 1)
  assert.equal(c.contact.linkedinOnly ?? 0, 0)
  assert.deepEqual(c.next, { label: 'Approve 1 lead to draft emails', href: '/app/leads?job_id=je' })
  const draft = readyItems(home(db)).find(x => x.id === 'draft')!
  assert.match(draft.detail, /^approve a qualified lead with a contact and dazl drafts the email$/)
  assert.deepEqual(draft.fix, { href: '/app/leads?job_id=je', label: 'Review leads' })
  assert.doesNotMatch(draft.detail, /draft check is holding/)
  // once the person approves it, the step moves on: nothing is offered twice
  createDraft(db, 'T', id, 'Seller', { manual: true })
  assert.equal(listCampaigns(db, 'T').find(x => x.id === 'je')!.contact.draftable, 0)
})

test('C: only the person\'s LinkedIn profile is known: Campaigns and Home both name LinkedIn, never "a draft check" or "Nothing waiting"', () => {
  const db = discoverDb()
  discoverLead(db, 'jl', [person, linkedin]); finish(db, 'jl')
  const c = listCampaigns(db, 'T').find(x => x.id === 'jl')!
  assert.equal(c.contact.draftable, 0)
  assert.equal(c.contact.linkedinOnly, 1)
  assert.deepEqual(c.next, { label: 'Message 1 lead on LinkedIn: open the lead and use "Message on LinkedIn"', href: '/app/leads?job_id=jl' })
  const draft = readyItems(home(db)).find(x => x.id === 'draft')!
  assert.match(draft.detail, /use "Message on LinkedIn" to reach the person/)
  assert.doesNotMatch(draft.detail, /draft check is holding/)
  assert.deepEqual(draft.fix, { href: '/app/leads?job_id=jl', label: 'Message on LinkedIn' })
  // a shared inbox beside the profile changes nothing: still LinkedIn, never a draft to info@
  const db2 = discoverDb()
  discoverLead(db2, 'js', [person, linkedin, { ...email, value: 'info@northwind-dental.example' }]); finish(db2, 'js')
  const s = listCampaigns(db2, 'T').find(x => x.id === 'js')!
  assert.deepEqual([s.contact.draftable, s.contact.linkedinOnly], [0, 1])
  assert.match(s.next.label, /^Message 1 lead on LinkedIn/)
})

test('C: LinkedIn is not offered when the proof does not hold or the link is a company page; Approve comes first when both exist', () => {
  const db = discoverDb()
  discoverLead(db, 'jn', [person, linkedin], { date: null })                                               // undated: the card offers no LinkedIn button
  discoverLead(db, 'jn', [person, { ...linkedin, value: 'https://www.linkedin.com/company/northwind/' }])  // a company page is not a person
  finish(db, 'jn')
  const n = listCampaigns(db, 'T').find(x => x.id === 'jn')!
  assert.equal(n.contact.linkedinOnly ?? 0, 0)
  assert.doesNotMatch(n.next.label, /LinkedIn/)
  discoverLead(db, 'jb', [person, linkedin, email]); discoverLead(db, 'jb', [person, linkedin]); finish(db, 'jb')
  const b = listCampaigns(db, 'T').find(x => x.id === 'jb')!
  assert.deepEqual([b.contact.draftable, b.contact.linkedinOnly], [1, 1])
  assert.equal(b.next.label, 'Approve 1 lead to draft emails')
  // the wording, on its own: plural, and LinkedIn only after Approve
  const base = { ...b, contact: { ...b.contact, draftable: 0, linkedinOnly: 2 } }
  assert.equal(nextAction(base, 0).label, 'Message 2 leads on LinkedIn: open each lead and use "Message on LinkedIn"')
})

// ---- D / E: the switches and sentences the pages read ----
test('D: billing is off unless BILLING_AVAILABLE is exactly 1; the sentence is the terms\' own', () => {
  assert.equal(billingAvailable({}), false)
  assert.equal(billingAvailable({ BILLING_AVAILABLE: 'yes' }), false)
  assert.equal(billingAvailable({ BILLING_AVAILABLE: '1' }), true)
  assert.equal(BILLING_BETA_TEXT, 'dazl is free during the beta. We don\'t charge you anything.')
  const panel = src('app/app/settings/plan-panel.tsx')
  assert.match(panel, /: billingAvailable \? <button[^\n]*Upgrade to Pro/, 'the upgrade button is shown only when the server says billing is available')
  assert.match(panel, /PlanPanel\(\{ billingAvailable = false \}/, 'off unless the server page says otherwise')
  assert.match(src('app/app/settings/page.tsx'), /<PlanPanel billingAvailable=\{billingAvailable\(\)\} \/>/, 'the server page reads the one switch')
  assert.match(panel, /BILLING_BETA_TEXT/)
})

test('E: a new AI key is Anthropic (Claude) only; Settings has no key panel at all (#1703)', () => {
  // #1703 removed the Settings key panel (its OpenAI and Anthropic key boxes): no key of any provider is asked for there.
  assert.equal(existsSync(new URL('../app/app/settings/llm-key-panel.tsx', import.meta.url)), false)
  assert.doesNotMatch(src('app/app/settings/page.tsx'), /LlmKeyPanel|llm-key-panel/)
  const inline = src('app/app/key-inline.tsx')
  assert.doesNotMatch(inline.replace(/^\s*\/\/.*$/gm, ''), /platform\.openai\.com|OpenAI/, 'nothing the user sees offers an OpenAI key')
  assert.match(inline, /return null/, 'the retired editor displays no provider instructions')
  assert.match(src('app/app/first-run.tsx'), /Describe your business yourself below\./, 'a blocked website read offers the manual profile instead')
  for (const p of ['app/app/first-run.tsx', 'app/app/readiness.tsx']) assert.doesNotMatch(src(p), /Anthropic or OpenAI key/, p)
})

test('A (#1620): Outreach offers no automatic sequences and Settings shows no Autopilot link or card while autopilot is not available', () => {
  const seq = src('app/app/outreach/sequences-client.tsx')
  const offer = seq.slice(seq.indexOf('turn on automatic sequences') - 1500, seq.indexOf('turn on automatic sequences'))
  assert.match(offer, /data\.auto_policy\.available!==false&&\(data\.auto_policy\.accepted/, 'the offer sits behind the availability the server reports')
  assert.match(seq, /scheduler==='configured_on'&&data\.sequences\.some\(s=>s\.status==='approved'\|\|s\.status==='active'\)/, 'the scheduler line shows only beside a sequence that is scheduled')
  const page = src('app/app/settings/page.tsx')
  assert.match(page, /SECTIONS\.filter\(\(\[id\]\) => id !== 'autopilot' \|\| autopilotAvailable\(\)\)/)
  const panel = src('app/app/settings/autopilot-panel.tsx')
  assert.ok(panel.indexOf('if (!i.available && !s.enabled) return null') > 0 && panel.indexOf('if (!i.available && !s.enabled) return null') < panel.indexOf('if (!i.available) return ('))
})
