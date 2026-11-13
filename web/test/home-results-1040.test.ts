// #1040: Home's last-30-days results from stored rows, tenant-scoped, on SQLite and Postgres.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { homeResults, signalLabel } from '../lib/outreach/home-results.ts'
import { inboxPage } from '../lib/outreach/inbox.ts'
import { test } from 'node:test'

const NOW = 1_800_000_000, DAY = 86400
const OLD = NOW - 40 * DAY, IN = NOW - 5 * DAY

async function seed(db: Db) {
  for (const [id, user] of [['j'.repeat(24), 'A'], ['k'.repeat(24), 'B']]) await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, ?, 'x', 'test', 'test', 'running', ?)", [id, user, IN])
  const lead = (id: string, job: string, kind: string | null, created: number, quarantined = false) => db.run(
    "INSERT INTO leads (id, scan_job_id, company, signal, source_url, signal_kind, created_at, quarantined_at) VALUES (?, ?, ?, 'hiring an SDR', 'https://news.example/a', ?, ?, ?)",
    [id, job, `Co ${id}`, kind, created, quarantined ? IN : null])
  const J = 'j'.repeat(24), K = 'k'.repeat(24)
  await lead('a1', J, 'hiring', IN); await lead('a2', J, 'hiring', IN); await lead('a3', J, 'raised_funding', IN)
  await lead('a4', J, 'raised_funding', OLD)            // found before the window: not a new lead (its email still counts if sent in the window)
  await lead('a5', J, 'hiring', IN, true)               // rejected: never counted
  await lead('a6', J, null, IN)                         // no type
  await lead('b1', K, 'hiring', IN)                     // another tenant
  await lead('a7', J, 'hiring', OLD); await lead('a8', J, 'hiring', OLD); await lead('a9', J, 'hiring', OLD)   // older leads for the edge cases below
  const msg = (id: string, tenant: string, leadId: string, status: string, sentAt: number | null, isTest = 0) => db.run(
    "INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, created_at, sent_at, test) VALUES (?, ?, ?, 'x@co.example', 'Hello there', 'A short first email body for the test.', ?, ?, ?, ?)",
    [id, tenant, leadId, status, sentAt ?? IN, sentAt, isTest])
  await msg('m1', 'A', 'a1', 'sent', IN); await msg('m2', 'A', 'a2', 'sent', IN); await msg('m3', 'A', 'a3', 'sent', IN)
  await msg('m4', 'A', 'a4', 'sent', IN)                // sent in the window to an older lead
  await msg('m5', 'A', 'a6', 'sent', OLD)               // sent before the window: not contacted
  await msg('m6', 'A', 'a5', 'draft', null)             // not sent
  await msg('m7', 'B', 'b1', 'sent', IN)                // another tenant
  await msg('m8', 'A', 'a9', 'sent', IN, 1)             // a test send: never contacted, its reply never counted
  await msg('m10', 'A', 'a7', 'sent', NOW - 30 * DAY)   // exactly 30 days ago: inside the window
  await msg('m11', 'A', 'a8', 'sent', NOW - 30 * DAY - 1) // one second earlier: outside
  const reply = (gid: string, tenant: string, msgId: string, cls: string, at = IN + DAY) => db.run(
    "INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, NULL, 'p@co.example', 'hi', ?, ?, ?)",
    [gid, tenant, `t-${msgId}`, cls, at, msgId])
  await reply('g1', 'A', 'm1', 'positive'); await reply('g2', 'A', 'm1', 'other', IN + 2 * DAY)   // two replies, one message: counted once
  await reply('g3', 'A', 'm3', 'negative')
  await reply('g4', 'A', 'm2', 'auto'); await reply('g5', 'A', 'm4', 'bounce_review'); await reply('g9', 'A', 'm4', 'soft_bounce')   // not person-written (the classifier's real bounce values)
  await reply('g7', 'A', 'm8', 'positive')                                                        // to a test send
  await reply('g8', 'A', 'm5', 'positive')                                                        // received in the window, to a message sent before it
  await reply('g6', 'B', 'm7', 'positive')                                                        // another tenant
}

bothEngines('#1040: the last 30 days - new leads, contacted, replied, interested - from stored rows, tenant-scoped; by signal adds up', async ({ db }) => {
  await seed(db)
  const r = await homeResults(db, 'A', NOW)
  // m1 said yes, then wrote again ('other'): its deciding reply is not positive, so it is not interested (the Inbox agrees)
  assert.deepEqual(r.tiles, { leads: 4, contacted: 5, replied: 2, interested: 0 })
  assert.deepEqual(r.by_signal.map(s => [s.signal, s.leads, s.contacted, s.replied]),
    [['hiring', 2, 3, 1], ['raised_funding', 1, 2, 1], ['unknown', 1, 0, 0]])
  for (const k of ['leads', 'contacted', 'replied'] as const) assert.equal(r.by_signal.reduce((n, s) => n + (s[k] ?? 0), 0), r.tiles[k], `by signal adds up to the ${k} tile`)
  assert.equal(r.latest_leads.length, 4); assert.ok(r.latest_leads.every(l => l.company.startsWith('Co a')), 'only this tenant\'s leads')
  assert.deepEqual(r.latest_replies.map(x => [x.company, x.classification]), [['Co a1', 'other'], ['Co a3', 'negative'], ['Co a1', 'positive']], 'person-written replies to messages sent in the window only, newest first (same time: the newest gmail id first)')
  // another tenant sees only its own
  assert.deepEqual((await homeResults(db, 'B', NOW)).tiles, { leads: 1, contacted: 1, replied: 1, interested: 1 })
  // a new workspace: zeros, empty lists
  const z = await homeResults(db, 'nobody', NOW)
  assert.deepEqual(z.tiles, { leads: 0, contacted: 0, replied: 0, interested: 0 }); assert.deepEqual([z.by_signal, z.latest_leads, z.latest_replies], [[], [], []])
})

bothEngines('#1040 round 2: Leads-page leads only (no poor fit, no test fixture); Interested is the Inbox deciding-reply rule', async ({ db }) => {
  await seed(db)
  const J = 'j'.repeat(24)
  const add = (id: string, kind: string, created: number, fit: number | null, source: string | null) => db.run(
    "INSERT INTO leads (id, scan_job_id, company, signal, source_url, signal_kind, created_at, fit, source_kind) VALUES (?, ?, ?, 'x', 'https://news.example/a', ?, ?, ?, ?)", [id, J, `Co ${id}`, kind, created, fit, source])
  await add('a10', 'hiring', IN, 1, null)          // hidden on Leads as a poor fit
  await add('a11', 'hiring', IN, null, 'test')     // a test fixture
  await add('a14', 'hiring', IN, 2, 'news')        // shown: counted
  await add('a18', 'fixture_kind', OLD, null, 'test')   // the verification fixture's lead: its 'sent' message (test flag 0) is not contacted
  await add('a12', 'hiring', OLD, null, null); await add('a13', 'hiring', OLD, null, null)
  const msg = (id: string, leadId: string) => db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, created_at, sent_at, test) VALUES (?, 'A', ?, 'x@co.example', 'Hello there', 'A short first email body for the test.', 'sent', ?, ?, 0)", [id, leadId, IN, IN])
  const reply = (gid: string, msgId: string, cls: string, at: number) => db.run("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, 'A', ?, NULL, 'p@co.example', 'hi', ?, ?, ?)", [gid, `t-${msgId}`, cls, at, msgId])
  await msg('m12', 'a12'); await reply('g12a', 'm12', 'positive', IN + DAY); await reply('g12b', 'm12', 'opt_out', IN + 2 * DAY)   // yes, then opt out
  await msg('m13', 'a13'); await reply('g13a', 'm13', 'positive', IN + DAY); await reply('g13b', 'm13', 'auto', IN + 2 * DAY)      // yes, then an out-of-office
  await msg('m18', 'a18'); await reply('g18', 'm18', 'positive', IN + DAY)
  await msg('m14', 'a14'); await reply('g14', 'm14', 'uncertain', IN + DAY)                                                       // "not really interested": a person, replied
  const r = await homeResults(db, 'A', NOW)
  assert.deepEqual(r.tiles, { leads: 5, contacted: 8, replied: 5, interested: 1 })
  assert.ok(!r.latest_leads.some(l => l.id === 'a10' || l.id === 'a11'), 'the latest leads are leads the Leads page shows')
  assert.ok(!r.by_signal.some(s => s.signal === 'fixture_kind'), 'a test-fixture lead\'s send is never contacted'); assert.ok(!r.latest_replies.some(x => x.company === 'Co a18'))
  // the Interested tile opens /app/inbox?status=all&class=positive: the same deciding reply decides both
  const inbox = (await inboxPage(db, 'A', { status: 'all', classification: 'positive' })).threads.map(t => t.thread_id).sort()
  assert.deepEqual(inbox, ['t-m13', 't-m18', 't-m5', 't-m8'], 'm13 (the yes stands over the out-of-office); m18 to a test-fixture lead, m5 sent before the window and m8 a test send are Inbox-only')
  assert.ok(!inbox.includes('t-m12') && !inbox.includes('t-m1'), 'm12 opted out after yes, m1 wrote again: neither is interested on either page')
})

bothEngines('#1040 round 3: Interested decides per Gmail thread like the Inbox; another tenant\'s lead never labels a message; reading off is unknown', async ({ db }) => {
  await seed(db)
  const J = 'j'.repeat(24)
  for (const id of ['a15', 'a16']) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, signal_kind, created_at) VALUES (?, ?, ?, 'x', 'https://news.example/a', 'hiring', ?)", [id, J, `Co ${id}`, OLD])
  const msg = (id: string, tenant: string, leadId: string) => db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, created_at, sent_at, test) VALUES (?, ?, ?, 'x@co.example', 'Hello there', 'A short first email body for the test.', 'sent', ?, ?, 0)", [id, tenant, leadId, IN, IN])
  const reply = (gid: string, tenant: string, thread: string, msgId: string | null, cls: string, at: number) => db.run("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, NULL, 'p@co.example', 'hi', ?, ?, ?)", [gid, tenant, thread, cls, at, msgId])
  // a yes, then a delivery notice for the same send in a thread of its own: the Inbox lists the yes thread as interested
  await msg('m15', 'A', 'a15'); await reply('g15a', 'A', 't-m15', 'm15', 'positive', IN + DAY); await reply('g15b', 'A', 'tb-m15', 'm15', 'bounce_review', IN + 2 * DAY)
  // a yes, then an unmatched notice (no send id) in the same thread: that thread's deciding row is the notice
  await msg('m16', 'A', 'a16'); await reply('g16a', 'A', 't-m16', 'm16', 'positive', IN + DAY); await reply('g16b', 'A', 't-m16', null, 'bounce_unmatched', IN + 2 * DAY)
  // another tenant's newer 'no' with the same thread id: never A's deciding reply
  await reply('g15x', 'B', 't-m15', null, 'negative', IN + 3 * DAY)
  // tenant B's message pointing at tenant A's lead a1 (no tenant-binding key on lead_id)
  await msg('m17', 'B', 'a1'); await reply('g17', 'B', 't-m17', 'm17', 'other', IN + DAY)
  const r = await homeResults(db, 'A', NOW)
  assert.equal(r.tiles.interested, 1, 'm15 only')
  const inbox = (await inboxPage(db, 'A', { status: 'all', classification: 'positive' })).threads.map(t => t.thread_id)
  assert.ok(inbox.includes('t-m15') && !inbox.includes('t-m16'), `the Inbox agrees: ${inbox}`)
  const b = await homeResults(db, 'B', NOW)
  assert.deepEqual(b.by_signal.map(s => [s.signal, s.contacted]), [['hiring', 1], ['unknown', 1]], 'B\'s own lead keeps its type; the message to A\'s lead counts under no type')
  assert.ok(!b.latest_replies.some(x => x.company === 'Co a1'), 'A\'s company name never shows in B\'s replies')
  // reply reading off: replies to what was sent are unknown, not zero; a workspace that sent nothing still reads zero
  const off = await homeResults(db, 'A', NOW, false)
  assert.equal(off.reply_reading, false); assert.equal(off.tiles.replied, null); assert.equal(off.tiles.interested, null)
  assert.equal(off.tiles.contacted, r.tiles.contacted)
  assert.ok(off.latest_replies.length > 0, 'the replies already stored stay listed as what was seen')
  assert.ok(off.by_signal.every(s => s.contacted > 0 ? s.replied === null : s.replied === 0))
  assert.deepEqual((await homeResults(db, 'nobody', NOW, false)).tiles, { leads: 0, contacted: 0, replied: 0, interested: 0 })
})

bothEngines('#1040 round 3: reply reading is on only with the current consent and an active account that granted read', async ({ db }) => {
  const { replyReadingOn } = await import('../lib/outreach/reply-reading.ts')
  const { READ_CONSENT_VERSION } = await import('../lib/outreach/read-consent.ts')
  assert.equal(await replyReadingOn(db, 'A'), false, 'nothing connected')
  await db.run("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, read_granted, status) VALUES ('A', 'me@a.example', 'ct', 1, 'active')")
  assert.equal(await replyReadingOn(db, 'A'), false, 'no consent')
  await db.run('INSERT INTO mail_read_consent (tenant_id, version) VALUES (?, ?)', ['A', 'an-older-version'])
  assert.equal(await replyReadingOn(db, 'A'), false, 'an older consent')
  await db.run('UPDATE mail_read_consent SET version = ? WHERE tenant_id = ?', [READ_CONSENT_VERSION, 'A'])
  assert.equal(await replyReadingOn(db, 'A'), true)
  await db.run("UPDATE gmail_accounts SET status = 'needs_reconnect' WHERE tenant_id = 'A'")
  assert.equal(await replyReadingOn(db, 'A'), false, 'the account needs reconnecting')
  await db.run("UPDATE gmail_accounts SET status = 'active', read_granted = 0 WHERE tenant_id = 'A'")
  assert.equal(await replyReadingOn(db, 'A'), false, 'read access not granted')
  assert.equal(await replyReadingOn(db, 'B'), false, 'another tenant')
})

test('#1040: signal types read as words', () => {
  assert.equal(signalLabel('raised_funding'), 'Raised funding'); assert.equal(signalLabel('unknown'), 'No signal type')
})

test('#1040: the 30-day reads use indexes (messages and replies by tenant and date; leads through their scans)', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const plan = (sql: string, ...p: unknown[]) => (raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...p) as { detail: string }[]).map(r => r.detail).join(' | ')
  const sent = plan("SELECT COUNT(*) FROM outreach_messages m JOIN leads l ON l.id = m.lead_id WHERE m.tenant_id = ? AND m.status = 'sent' AND m.sent_at >= ? AND COALESCE(m.test, 0) = 0", 'A', 0)
  const replies = plan("SELECT r.thread_id FROM inbound_messages r WHERE r.tenant_id = ? AND r.received_at >= ? ORDER BY r.received_at DESC LIMIT 5", 'A', 0)
  const matched = plan("SELECT 1 FROM inbound_messages r WHERE r.tenant_id = ? AND r.outreach_message_id = ? AND r.classification = 'positive'", 'A', 'm')
  const leads = plan("SELECT l.signal_kind, COUNT(*) FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.created_at >= ? AND l.quarantined_at IS NULL AND (l.fit IS NULL OR l.fit > 1) AND (l.source_kind IS NULL OR l.source_kind <> 'test') GROUP BY l.signal_kind", 'A', 0)
  for (const [name, p] of [['sent', sent], ['replies', replies], ['matched', matched], ['leads', leads]] as const) {
    assert.doesNotMatch(p, /\bSCAN (m|r|l|outreach_messages|inbound_messages|leads)\b(?! USING)/, `${name}: ${p}`)
    assert.match(p, /USING (COVERING )?INDEX/, `${name}: ${p}`)
  }
  assert.match(replies, /inbound_messages_tenant_received/, replies)
  assert.match(matched, /inbound_messages_outreach/, matched)
  assert.match(leads, /leads_job_created \(scan_job_id=\? AND created_at>\?\)/, `a scan's leads since the date are a range seek: ${leads}`)
})

test('#1040 route: the real handler answers 401 / 503 / 200 no-store (child process, its own session and Db)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/home-results-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/); assert.match(r.stdout, /# fail 0/)
})

// The SHAPE of a real prod account (2026-11-13, read-only ops-door SQL, counts only; the wording here is neutral, never a
// customer's own text): most search leads were never graded (signal_kind and signals NULL), plus hiring-feed, CSV and manual
// leads; the only sends in 30 days were a test send and a verification-fixture send (test flag 0, to a source_kind 'test' lead);
// two replies with no matched send. Plus one real send to an ungraded search lead, with a reply, for the sends path.
bothEngines('#1040 real-data shape: ungraded leads count under the channel that found them; fixture and test sends are not contacted', async ({ db }) => {
  const J = 'r'.repeat(24), F = 'f'.repeat(24)
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, 'R', 'x', '(from request)', '-', 'companies looking for a new sales tool', 'running', ?)", [J, IN])
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'R', 'x', 'test only', 'test only', 'running', ?)", [F, IN])
  const lead = (id: string, job: string, signal: string, kind: string | null, src: string) => db.run(
    'INSERT INTO leads (id, scan_job_id, company, signal, source_url, signal_kind, source_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, job, `Co ${id}`, signal, 'https://jobs.example/p', kind, src, IN])
  for (let i = 0; i < 6; i++) await lead(`q${i}`, J, 'Hiring a sales operations manager', null, 'query')
  await lead('g1', J, 'Hiring a head of sales enablement', 'hiring_relevant_role', 'query')
  for (let i = 0; i < 2; i++) await lead(`h${i}`, J, 'Hiring a sales analyst', null, 'hiring_feed')
  await lead('c1', J, 'Imported from your CSV', null, 'csv'); await lead('m1', J, 'Posted a review of their current tool', null, 'manual_source')
  await lead('t1', F, 'verification fixture lead', null, 'test'); await lead('t2', F, 'verification fixture lead', null, 'test')
  const msg = (id: string, leadId: string, isTest: number) => db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, created_at, sent_at, test) VALUES (?, 'R', ?, 'x@co.example', 'Hello there', 'A short first email body for the test.', 'sent', ?, ?, ?)", [id, leadId, IN, IN, isTest])
  await msg('s1', 't1', 0); await msg('s2', 't2', 1)
  await msg('s3', 'q0', 0)   // a real send to an ungraded search lead
  await db.run("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES ('u3', 'R', 't-s3', NULL, 'p@co.example', 'hi', 'other', ?, 's3')", [IN + DAY])
  for (const [g, cls] of [['u1', 'positive'], ['u2', 'other']]) await db.run("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, 'R', ?, NULL, 'p@co.example', 'hi', ?, ?, NULL)", [g, `t-${g}`, cls, IN + DAY])
  const r = await homeResults(db, 'R', NOW)
  assert.deepEqual(r.tiles, { leads: 11, contacted: 1, replied: 1, interested: 0 })
  assert.deepEqual(r.by_signal.map(s => [signalLabel(s.signal), s.leads, s.contacted, s.replied]),
    [['Search (signal type not graded)', 6, 1, 1], ['Hiring feed (signal type not graded)', 2, 0, 0], ['Hiring relevant role', 1, 0, 0], ['CSV import (signal type not graded)', 1, 0, 0], ['Added by you (signal type not graded)', 1, 0, 0]],
    'the send to an ungraded search lead counts in that lead\'s row, not a separate one')
  for (const k of ['leads', 'contacted', 'replied'] as const) assert.equal(r.by_signal.reduce((n, x) => n + (x[k] ?? 0), 0), r.tiles[k], `adds up to the ${k} tile`)
  assert.ok(!r.by_signal.some(s => s.signal === 'unknown'), 'no lead of this account reads "No signal type": each has the channel that found it')
  assert.deepEqual(r.latest_replies.map(x => x.classification), ['other'], 'replies matched to no send are not results of a play; the matched one is')
})

// #1040 follow-up (acceptance 2): Replied and Interested open the Inbox filtered to the threads they count (?sent_since)
bothEngines('#1040: the Inbox filtered by sent_since lists exactly the threads the Replied and Interested tiles count', async ({ db }) => {
  await seed(db)
  const r = await homeResults(db, 'A', NOW)
  const threads = async (q: Record<string, unknown>) => (await inboxPage(db, 'A', { status: 'all', sentSince: r.since, ...q })).threads.map(t => t.thread_id).sort()
  assert.deepEqual(await threads({}), ['t-m1', 't-m3'], 'm1 and m3 got person replies; m2 only an auto-reply, m4 bounces, m8 a test send, m5 was sent before the window')
  assert.equal((await threads({})).length, r.tiles.replied)
  assert.deepEqual(await threads({ classification: 'positive' }), [], 'Interested 0: m1 wrote again after the yes')
  assert.equal(r.tiles.interested, 0)
  // unfiltered, the Inbox still lists every thread (the filter only applies when asked)
  assert.ok((await inboxPage(db, 'A', { status: 'all' })).threads.length > 2)
  // another tenant's threads never come back through the filter
  assert.deepEqual((await inboxPage(db, 'B', { status: 'all', sentSince: r.since })).threads.map(t => t.thread_id), ['t-m7'])
})

test('#1040: ?sent_since must be a whole number of seconds, or the Inbox refuses it', async () => {
  const { parseInboxQuery, InboxQueryError } = await import('../lib/outreach/inbox.ts')
  assert.equal(parseInboxQuery(new URLSearchParams('sent_since=1797408000')).sentSince, 1797408000)
  assert.equal(parseInboxQuery(new URLSearchParams('')).sentSince, null)
  for (const bad of ['x', '-5', '1.5', '']) assert.throws(() => parseInboxQuery(new URLSearchParams(`sent_since=${bad}`)), InboxQueryError, bad)
})

bothEngines('#1040 review: Interested = the filtered positive list; the window edge, a fixture lead, another tenant\'s lead and the totals agree too', async ({ db }) => {
  await seed(db)
  const J = 'j'.repeat(24), K = 'k'.repeat(24)
  const addLead = (id: string, job: string, src: string | null) => db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, signal_kind, source_kind, created_at) VALUES (?, ?, ?, 'x', 'https://news.example/a', 'hiring', ?, ?)", [id, job, `Co ${id}`, src, OLD])
  const msg = (id: string, leadId: string, at: number) => db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, created_at, sent_at, test) VALUES (?, 'A', ?, 'x@co.example', 'Hello there', 'A short first email body for the test.', 'sent', ?, ?, 0)", [id, leadId, at, at])
  const reply = (gid: string, msgId: string, cls: string, at = IN + DAY) => db.run("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, 'A', ?, NULL, 'p@co.example', 'hi', ?, ?, ?)", [gid, `t-${msgId}`, cls, at, msgId])
  // the window edge (m10 sent exactly 30 days ago, m11 one second earlier: seeded without replies) gets replies
  await reply('g10', 'm10', 'other'); await reply('g11', 'm11', 'other')
  // a positive reply to a send whose lead is a test fixture: neither the tile nor the list
  await addLead('a20', J, 'test'); await msg('m20', 'a20', IN); await reply('g20', 'm20', 'positive')
  // a send whose lead_id points at ANOTHER tenant's test-fixture lead: that lead never decides anything for tenant A
  await addLead('b20', K, 'test'); await msg('m21', 'b20', IN); await reply('g21', 'm21', 'positive')
  const r = await homeResults(db, 'A', NOW)
  const page = (q: Record<string, unknown>) => inboxPage(db, 'A', { status: 'all', sentSince: r.since, ...q })
  const ids = async (q: Record<string, unknown>) => (await page(q)).threads.map(t => t.thread_id).sort()
  assert.deepEqual(await ids({}), ['t-m1', 't-m10', 't-m21', 't-m3'], 'the edge is inside, one second earlier is not; the fixture-lead send is out; the other tenant\'s lead does not hide m21')
  assert.equal(r.tiles.replied, 4); assert.equal((await ids({})).length, r.tiles.replied)
  assert.deepEqual(await ids({ classification: 'positive' }), ['t-m21']); assert.equal(r.tiles.interested, 1)
  // the totals the tabs show count the same threads as the list
  assert.equal((await page({})).counts.threads, 4)
})
