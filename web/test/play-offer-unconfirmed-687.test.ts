// #687 (part of #349): a play created before plays recorded what they sell (scan_jobs.offer and seller NULL, a request
// that states no offer) never silently uses the tenant's CURRENT profile as if it were its offer. Contract:
// https://github.com/gagan114662/dazl/issues/349#issuecomment-6636172985 . Synthetic data only: no network, no provider
// call (a recording fake), no send, no live DB.
//   - the play reads as unconfirmed (readPlayOffer / storedPlayOffer), naming the current offer it would use;
//   - drafting, the AI rewrite, approval (manual, sequence, autopilot) and the paid fit check refuse until the tenant
//     chooses through setPlayOffer, and the autopilot fingerprints fail closed;
//   - precedence: reviewed offer > creation snapshot > explicit-unknown fallback;
//   - tenant isolation, no write on read, unreadable -> offer_unreadable, malformed rows fail closed;
//   - scheduled runs (watch, monitor) record the profile snapshot, as a manual run does, so they are not left unconfirmed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createQueryJob } from '../lib/scan/store-db.ts'
import { readPlayOffer, setPlayOffer, scheduledPlayOffer, storedPlayOffer } from '../lib/scan/play-offer.ts'
import { draftOffer } from '../lib/scan/play-offer-text.ts'
import { approve, approveBlockReason, createDraft, draftBlockReason, saveSettings, OutreachError } from '../lib/outreach/service.ts'
import { polishDraft } from '../lib/outreach/draft-llm.ts'
import { memoryForLead } from '../lib/outreach/play-memory.ts'
import { draftAuthority, offerHashFor } from '../lib/outreach/autopilot.ts'
import { offerBlockFor, playOfferUnresolved } from '../lib/scan/runner.ts'
import { qualifyPreview } from '../lib/scan/qualify-preview.ts'
import { savePlayResearch } from '../lib/scan/play-research.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { saveMemory } from '../lib/memory.ts'
import { createWatch, runDueWatches } from '../lib/watch.ts'
import { createMonitor, runDueMonitors } from '../lib/monitors.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { bothEngines } from './helpers/engines.ts'

const DENTAL = 'Appointment booking and reminder software for dental practices'
const CRM = 'CRM setup and outbound consulting'
const BOOKS = 'Bookkeeping for design agencies'
const Q = 'Independent dental practices in New York City hiring a front-desk coordinator'
const master = randomBytes(32)

const tenant = (raw: Database.Database, id: string, sells: string, website = 'https://seller.example') =>
  raw.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells, website) VALUES (?, ?, 'n', 'Acme', 'x', 'y', ?, ?)").run(id, `${id}@example.test`, sells, website)
// a play as stored: offer/seller as given (NULL = never recorded), with one reviewed, dated, emailable lead
function play(raw: Database.Database, owner: string, id: string, cols: { query: string | null; seller?: string | null; offer?: string | null }) {
  raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller, offer, offer_set_at) VALUES (?, ?, 'Request', 'test', 'test', 'running', ?, ?, ?, ?)")
    .run(id, owner, cols.query, cols.seller ?? null, cols.offer ?? null, cols.offer ? 1 : null)
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  raw.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from, event_date) VALUES (?, ?, 'Pat', 'Buyer', 'sales@buyer.invalid', 'Buyer is hiring an SDR', 'https://buyer.invalid/careers', 'Buyer is hiring an SDR', 70, 1800000000, 'test_review', ?)")
    .run(`lead-${id}`, id, recent)
  raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
}
function setup() {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  tenant(raw, 'A', DENTAL); tenant(raw, 'B', BOOKS)
  saveKey(raw, 'A', 'anthropic', 'sk-ant-api03-synthetic-0000000000000000AAAA', master)
  saveSettings(raw, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  raw.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status) VALUES ('A', 'me@sender.example', 'x', 'active')").run()
  play(raw, 'A', 'old', { query: Q })                                                    // pre-snapshot
  play(raw, 'A', 'recorded', { query: Q, seller: `${DENTAL} - https://seller.example` })  // creation snapshot
  play(raw, 'A', 'reviewed', { query: Q, seller: `${DENTAL} - https://seller.example`, offer: CRM })
  play(raw, 'A', 'intake', { query: null })                                               // an import/intake job: not a play
  return raw
}
const code = (f: () => unknown) => { try { f(); return null } catch (e) { if (e instanceof OutreachError) return e.code; throw e } }
const draftRow = (raw: Database.Database, lead: string, id = randomBytes(12).toString('hex')) => {
  raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'A', ?, 'sales@buyer.invalid', 'Hello', 'A draft body that is long enough to keep.', 'draft')").run(id, lead)
  return id
}
const recording = () => {
  const prompts: string[] = []
  const providers = { anthropic: { completeDetailed: async (_k: string, prompt: string) => { prompts.push(prompt); return { text: 'x', model: 'm' } } } } as unknown as Record<string, Provider>
  return { prompts, providers }
}
const snapshot = (raw: Database.Database) => JSON.stringify([raw.prepare('SELECT * FROM scan_jobs ORDER BY id').all(), raw.prepare('SELECT id, sells, website FROM users ORDER BY id').all()])

test('#687 pure: precedence reviewed > snapshot > explicit-unknown fallback; only a play with a request is unconfirmed', () => {
  assert.deepEqual(storedPlayOffer({ offer: CRM, seller: DENTAL, query: Q }, BOOKS), { offer: CRM, source: 'play', conflict: null })
  assert.deepEqual(storedPlayOffer({ offer: null, seller: `${DENTAL} - s.example`, query: Q }, BOOKS), { offer: DENTAL, source: 'recorded', conflict: null })
  assert.deepEqual(storedPlayOffer({ offer: null, seller: null, query: Q }, BOOKS), { offer: BOOKS, source: 'profile', conflict: null, unconfirmed: true })
  // no request: an import/intake job keeps the tenant context, not a play
  for (const query of [null, undefined, ''])
    assert.deepEqual(storedPlayOffer({ offer: null, seller: null, query }, BOOKS), { offer: BOOKS, source: 'profile', conflict: null }, String(query))
  // nothing to fall back to: nothing to confirm, and nothing is stated
  assert.deepEqual(storedPlayOffer({ offer: null, seller: null, query: Q }, ''), { offer: null, source: 'none', conflict: null })
  // the request states the offer itself: the same as the current context -> its own record; a different one -> conflict
  const SAME = 'We sell bookkeeping to design agencies.'
  assert.deepEqual(storedPlayOffer({ offer: null, seller: null, query: SAME }, SAME), { offer: SAME, source: 'profile', conflict: null })
  assert.equal(storedPlayOffer({ offer: null, seller: null, query: `Selling ${CRM} to London SaaS founders` }, BOOKS).source, 'conflict')
  // draftOffer: unconfirmed refuses (offer kept only for the run's own scoring); no play -> tenant context
  assert.deepEqual(draftOffer({ offer: null, seller: null, query: Q }, BOOKS), { offer: BOOKS, refuse: 'offer_unconfirmed' })
  assert.deepEqual(draftOffer(null, BOOKS), { offer: BOOKS, refuse: null })
  assert.deepEqual(draftOffer({ offer: null, seller: null, query: null }, BOOKS), { offer: BOOKS, refuse: null })
  assert.deepEqual(draftOffer({ offer: null, seller: DENTAL, query: Q }, BOOKS), { offer: DENTAL, refuse: null })
})

test('#687 pure: malformed rows fail closed (unconfirmed or contested, never pinned) and never throw', () => {
  const un = (row: Record<string, unknown>) => (storedPlayOffer(row, BOOKS) as { unconfirmed?: true }).unconfirmed === true
  assert.ok(un({ offer: null, seller: '   ', query: Q }), 'whitespace seller')
  assert.ok(un({ offer: '  ', seller: null, query: Q }), 'whitespace offer')
  assert.ok(un({ offer: null, seller: null, query: '   ' }), 'whitespace request is still a request (Home/Campaigns list it as a play)')
  for (const bad of [42, true, {}, [], ['x']]) {
    assert.ok(un({ offer: bad, seller: null, query: Q }), `offer ${JSON.stringify(bad)}`)
    assert.ok(un({ offer: null, seller: bad, query: Q }), `seller ${JSON.stringify(bad)}`)
    assert.ok(un({ offer: null, seller: null, query: bad }), `query ${JSON.stringify(bad)}`)
  }
  assert.ok(un({ offer: null, seller: null, query: 'dental \uD800 practices' }), 'lone surrogate')
  assert.ok(un({ seller: undefined, query: Q }), 'missing keys')
  assert.ok(un({ offer: null, seller: null, query: Q, extra: 'x', user_id: 'B' }), 'extra keys are ignored')
  const t = Date.now()
  assert.ok(un({ offer: null, seller: null, query: `${'dental practices in New York '.repeat(8000)}` }), 'huge request')
  assert.ok(Date.now() - t < 5000, 'a huge request is read in bounded time')
  assert.deepEqual(draftOffer({ offer: 7, seller: 7, query: 7 } as never, BOOKS), { offer: BOOKS, refuse: 'offer_unconfirmed' })
})

test('#687 a pre-snapshot play across a profile change: shown unconfirmed, every outreach action refused until chosen, then pinned', async () => {
  const raw = setup(); const db = sqliteDb(raw)
  try {
    // the profile changes after the play ran
    raw.prepare('UPDATE users SET sells = ? WHERE id = ?').run(BOOKS, 'A')
    assert.deepEqual(await readPlayOffer(db, 'A', 'old'), { offer: BOOKS, source: 'profile', conflict: null, unconfirmed: true })
    const before = snapshot(raw)
    // drafting (template; autopilot drafts through it too)
    assert.equal(code(() => createDraft(raw, 'A', 'lead-old', 'Acme')), 'offer_unconfirmed')
    assert.equal(draftBlockReason(raw, 'A', 'lead-old'), 'offer_unconfirmed', 'views never recommend a refused draft')
    assert.equal((raw.prepare("SELECT count(*) n FROM outreach_messages WHERE lead_id = 'lead-old'").get() as { n: number }).n, 0)
    // a draft that already exists (written before this change): approval refused, manual or not
    const m = draftRow(raw, 'lead-old')
    assert.equal(approveBlockReason(raw, 'A', m), 'offer_unconfirmed')
    assert.equal(approveBlockReason(raw, 'A', m, { skipAccount: true }), 'offer_unconfirmed', 'a hold on the play, not a setup step')
    assert.equal(code(() => approve(raw, 'A', m)), 'offer_unconfirmed')
    assert.equal(code(() => approve(raw, 'A', m, true)), 'offer_unconfirmed', 'sequence step 1 approves through the same gate')
    assert.equal((raw.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(m) as { status: string }).status, 'draft')
    // the paid AI rewrite: refused with no provider call
    const r = recording()
    assert.deepEqual(await polishDraft(raw, 'A', m, 'Acme', { master, providers: r.providers }), { rewritten: false, reason: 'offer_unconfirmed' })
    assert.equal(r.prompts.length, 0)
    // autopilot: its held-draft fingerprints fail closed, so nothing drains on the current profile's offer
    assert.equal(offerHashFor(raw, 'A', 'lead-old'), null)
    assert.equal(draftAuthority(raw, 'A', m), null)
    // follow-ups state no offer
    assert.equal(memoryForLead(raw, 'A', 'lead-old'), null)
    // the paid fit check: refused before any page read
    let fetched = 0
    const p = await qualifyPreview(raw, 'A', 'lead-old', `${BOOKS} - https://seller.example`, async () => { fetched++; return { text: 'Buyer is hiring', title: 't', retrievedAt: 1 } }, 'anthropic', 'claude-sonnet-4-5')
    assert.equal(p?.ready, false); assert.equal(p?.input, null); assert.equal(fetched, 0)
    assert.ok(p?.notes.some(n => /Confirm what this play sells/.test(n)))
    // supplemental research is not snapshotted with the current profile's offer, and nothing is fetched
    const research = { company: 'Buyer', signal: 'Hiring', source_url: 'https://buyer.invalid/careers', excerpt: 'Buyer is hiring an SDR for the team.', event_date: null, contact: null, person_name: '', person_role: '', professional_url: '', person_excerpt: '' }
    await assert.rejects(savePlayResearch(raw, 'A', 'old', research, async () => { fetched++; return { fail: 'error' } }), /Choose what this play sells/)
    assert.equal(fetched, 0)
    // the run's own research is unchanged: scoring still reads the context, the play is not "contested"
    assert.match(offerBlockFor(raw, 'A', 'old'), new RegExp(BOOKS)); assert.equal(playOfferUnresolved(raw, 'A', 'old'), false)
    // none of the above wrote a play or profile row
    assert.equal(snapshot(raw), before, 'no write on read or on refusal')

    // the tenant chooses (here: the dental offer the play was really for), through the per-play path only
    assert.equal(await setPlayOffer(db, 'A', 'old', DENTAL), true)
    assert.deepEqual(await readPlayOffer(db, 'A', 'old'), { offer: DENTAL, source: 'play', conflict: null })
    assert.equal(approveBlockReason(raw, 'A', m), null)
    assert.notEqual(offerHashFor(raw, 'A', 'lead-old'), null); assert.notEqual(draftAuthority(raw, 'A', m), null)
    assert.match(memoryForLead(raw, 'A', 'lead-old')!.positioning, new RegExp(DENTAL))
    approve(raw, 'A', m)
    assert.equal((raw.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(m) as { status: string }).status, 'approved')
    // a later profile change no longer moves it, and the other plays kept theirs throughout
    raw.prepare('UPDATE users SET sells = ? WHERE id = ?').run('Something else entirely', 'A')
    assert.equal((await readPlayOffer(db, 'A', 'old'))!.offer, DENTAL)
    assert.deepEqual(await readPlayOffer(db, 'A', 'recorded'), { offer: DENTAL, source: 'recorded', conflict: null })
    assert.deepEqual(await readPlayOffer(db, 'A', 'reviewed'), { offer: CRM, source: 'play', conflict: null })
  } finally { raw.close() }
})

test('#687 recorded, reviewed and request-less jobs are unaffected: drafts and approvals go through as before', () => {
  const raw = setup()
  try {
    for (const [lead, offer] of [['lead-recorded', DENTAL], ['lead-reviewed', CRM], ['lead-intake', DENTAL]] as const) {
      assert.equal(draftBlockReason(raw, 'A', lead), null, lead)
      const id = createDraft(raw, 'A', lead, 'Acme')
      assert.match((raw.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(id) as { body: string }).body, new RegExp(offer), lead)
      assert.equal(approveBlockReason(raw, 'A', id), null, lead)
    }
  } finally { raw.close() }
})

test('#687 tenant isolation: the fallback is the play owner\'s own context; another tenant can neither read, resolve nor draft it', async () => {
  const raw = setup(); const db = sqliteDb(raw)
  try {
    saveMemory(raw, 'B', { positioning: 'Tenant B positioning that must never appear' })
    const a = await readPlayOffer(db, 'A', 'old')
    assert.equal(a?.offer, DENTAL); assert.doesNotMatch(JSON.stringify(a), /Tenant B|Bookkeeping/)
    assert.equal(await readPlayOffer(db, 'B', 'old'), null)
    assert.equal(await setPlayOffer(db, 'B', 'old', BOOKS), false)
    assert.equal(code(() => createDraft(raw, 'B', 'lead-old', 'Other')), 'not_found')
    const m = draftRow(raw, 'lead-old')
    assert.equal(approveBlockReason(raw, 'B', m), 'not_found')
    assert.deepEqual(await readPlayOffer(db, 'A', 'old'), { offer: DENTAL, source: 'profile', conflict: null, unconfirmed: true }, 'still unconfirmed for its owner')
    // B reading A's lead is not A's play: B gets only B's own context, never A's offer
    assert.doesNotMatch(JSON.stringify(memoryForLead(raw, 'B', 'lead-old')), /Appointment booking/)
  } finally { raw.close() }
})

test('#687 an unreadable play or tenant offer is offer_unreadable for approval and the draft views, never "no refusal"', () => {
  const raw = setup()
  try {
    const m = draftRow(raw, 'lead-recorded')
    assert.equal(approveBlockReason(raw, 'A', m), null, 'control: approvable when readable')
    const failing = (match: RegExp) => new Proxy(raw, { get(target, key) {
      if (key === 'prepare') return (sql: string) => { if (match.test(sql)) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); return target.prepare(sql) }
      const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v
    } }) as Database.Database
    for (const re of [/^SELECT j\.offer, j\.seller, j\.query FROM leads/, /FROM tenant_memory|positioning/i]) {
      const d = failing(re)
      assert.equal(approveBlockReason(d, 'A', m), 'offer_unreadable', String(re))
      assert.equal(code(() => approve(d, 'A', m)), 'offer_unreadable', String(re))
      assert.equal(draftBlockReason(d, 'A', 'lead-recorded'), 'offer_unreadable', String(re))
    }
    assert.equal((raw.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(m) as { status: string }).status, 'draft')
  } finally { raw.close() }
})

// Scheduled runs on both engines: the job records the profile snapshot as POST /api/scan does, so it is not left
// unconfirmed; a website alone (no profile offer) is not a snapshot of an offer; a confirmed offer still wins.
const pgTenant = (db: Db, id: string, sells: string, website: string) =>
  db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells, website) VALUES (?, ?, 'n', 'Acme', 'x', 'y', ?, ?)", [id, `${id}@example.test`, sells, website])
const giveKey = (db: Db, id: string) => db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)", [id])
const ICP = JSON.stringify({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })

bothEngines('#687 a watch or monitor run records the profile snapshot (no unconfirmed weekly play); a website alone records none; a confirmed offer wins', async ({ db }) => {
  const P = 'p'.repeat(24), W = 'w'.repeat(24), M = 'm'.repeat(24)
  await pgTenant(db, P, DENTAL, 'https://seller.example'); await pgTenant(db, W, '', 'https://web-only.example'); await pgTenant(db, M, DENTAL, 'https://seller.example')
  for (const t of [P, W]) await giveKey(db, t)
  assert.deepEqual(await scheduledPlayOffer(db, P, Q), { offer: null, seller: `${DENTAL} - https://seller.example` })
  assert.deepEqual(await scheduledPlayOffer(db, W, Q), { offer: null, seller: null })
  for (const t of [P, W]) {
    const w = (await createWatch(db, t, Q, ICP)).watch!
    await db.run('UPDATE watches SET next_run_at = 1 WHERE id = ?', [w.id])
  }
  assert.deepEqual(await runDueWatches(db), { ran: 2, paused: 0 })
  const jobOf = async (t: string) => (await db.get<{ id: string; seller: string | null; offer: string | null }>('SELECT id, seller, offer FROM scan_jobs WHERE user_id = ? ORDER BY created_at DESC, insert_seq DESC LIMIT 1', [t]))!
  const pj = await jobOf(P)
  assert.equal(pj.seller, `${DENTAL} - https://seller.example`); assert.equal(pj.offer, null)
  assert.deepEqual(await readPlayOffer(db, P, pj.id), { offer: DENTAL, source: 'recorded', conflict: null })
  const wj = await jobOf(W)
  assert.equal(wj.seller, null, 'a website alone is not an offer snapshot')
  assert.equal((await readPlayOffer(db, W, wj.id) as { unconfirmed?: true } | null)?.unconfirmed ?? false, false, 'nothing to fall back to: nothing to confirm')
  // a monitor run records the same snapshot
  const mon = await createMonitor(db, M, { query: Q })
  assert.ok('id' in mon)
  const [mj] = await runDueMonitors(db)
  assert.deepEqual(await readPlayOffer(db, M, mj), { offer: DENTAL, source: 'recorded', conflict: null })
  // a confirmed offer for this request and snapshot still wins
  const chosen = await createQueryJob(db, P, { query: Q, icp: null, seller: `${DENTAL} - https://seller.example` })
  assert.ok(await setPlayOffer(db, P, chosen, CRM))
  assert.deepEqual(await scheduledPlayOffer(db, P, Q), { offer: CRM, seller: `${DENTAL} - https://seller.example` })
})
