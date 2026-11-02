// Inbox and Outcomes conversations, paginated and filtered on the server (lib/outreach/inbox.ts, #369), on both engines.
// Synthetic tenants, plays and addresses only; nothing is fetched or sent.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { inboxPage, markThreadRead, decodeCursor, encodeCursor, InboxQueryError, type InboxThread, type InboxQuery } from '../lib/outreach/inbox.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = 1_800_000_000
const hex = (n: number, k = 24) => n.toString(16).padStart(k, '0')

async function job(db: Db, tenant: string, id: string) {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Biz', 'test', 'test', 'running')", [id, tenant])
}
async function lead(db: Db, jobId: string, id: string, company: string) {
  await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES (?, ?, 'Pat', ?, 'hiring', 'https://x.example/a')", [id, jobId, company])
}
let g = 0
async function reply(db: Db, tenant: string, thread: string, leadId: string | null, cls: string, at: number) {
  await db.run('INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [`g${++g}`, tenant, thread, leadId, 'pat@x.example', `${cls} reply`, cls, at])
}
async function all(db: Db, tenant: string, q: InboxQuery): Promise<InboxThread[]> {
  const out: InboxThread[] = []
  let cursor: string | null = null
  for (let i = 0; i < 100; i++) {
    const p = await inboxPage(db, tenant, { ...q, cursor })
    out.push(...p.threads)
    if (!p.next_cursor) return out
    cursor = p.next_cursor
  }
  throw new Error('pagination did not end')
}

bothEngines('an older unresolved conversation in the selected play stays discoverable behind 150 newer replies in another play', async ({ db }) => {
  const playA = hex(1), playB = hex(2)
  await job(db, 'T', playA); await job(db, 'T', playB)
  await lead(db, playA, 'la', 'Older Co')
  await reply(db, 'T', 'ta', 'la', 'positive', NOW - 30 * 86400)
  for (let i = 0; i < 150; i++) { await lead(db, playB, `lb${i}`, `Busy ${i}`); await reply(db, 'T', `tb${i}`, `lb${i}`, i % 2 ? 'positive' : 'other', NOW - i) }
  const p = await inboxPage(db, 'T', { jobId: playA, status: 'needs_owner', limit: 100 })
  assert.deepEqual(p.threads.map(t => [t.thread_id, t.company, t.job_id]), [['ta', 'Older Co', playA]])
  assert.equal(p.next_cursor, null)
  assert.deepEqual(p.counts, { threads: 1, needs_owner: 1, unread: 1, unread_needs_owner: 1 })
  // The account-wide view is cut at the page size and says so with a cursor; play B's total is exact.
  const b = await inboxPage(db, 'T', { jobId: playB, status: 'needs_owner', limit: 100 })
  assert.equal(b.threads.length, 100); assert.ok(b.next_cursor)
  assert.equal(b.counts.needs_owner, 150)
  const everything = await all(db, 'T', { status: 'needs_owner', limit: 40 })
  assert.equal(everything.length, 151)
  assert.equal(everything.at(-1)?.thread_id, 'ta', 'oldest last, still reachable')
})

bothEngines('pagination is stable: every thread once, newest first, no gaps or duplicates, ties on the same second included', async ({ db }) => {
  const play = hex(3)
  await job(db, 'T', play)
  const want: string[] = []
  for (let i = 0; i < 97; i++) {
    const t = `t${String(i).padStart(3, '0')}`
    await lead(db, play, `l${i}`, `Co ${i}`)
    await reply(db, 'T', t, `l${i}`, 'positive', NOW - Math.floor(i / 5)) // five threads share each second
    await reply(db, 'T', t, `l${i}`, 'auto', NOW + 10) // a later auto-reply never decides, nor moves the thread
    want.push(t)
  }
  for (const size of [1, 7, 50, 100]) {
    const got = await all(db, 'T', { limit: size })
    assert.equal(got.length, 97, `page size ${size}`)
    assert.equal(new Set(got.map(t => t.thread_id)).size, 97, `no duplicates at page size ${size}`)
    const order = [...got].sort((a, b) => b.received_at - a.received_at || (a.thread_id < b.thread_id ? 1 : -1))
    assert.deepEqual(got.map(t => t.thread_id), order.map(t => t.thread_id), `ordered at page size ${size}`)
    assert.ok(got.every(t => t.classification === 'positive' && t.replies === 2))
  }
  assert.deepEqual((await all(db, 'T', { limit: 13 })).map(t => t.thread_id).sort(), want.sort())
})

bothEngines('totals do not depend on the page and reconcile with the rows; reading a thread and a new reply move unread', async ({ db }) => {
  const play = hex(4)
  await job(db, 'T', play)
  const cls = ['positive', 'other', 'negative', 'opt_out', 'auto']
  for (let i = 0; i < 40; i++) { await lead(db, play, `l${i}`, `Co ${i}`); await reply(db, 'T', `t${i}`, `l${i}`, cls[i % 5], NOW - i) }
  await db.run("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, stopped) VALUES ('T', 't0', 'l0', 'pat@x.example', 'r', ?, 'replied')", [NOW])
  for (const t of ['t1', 't5', 't2']) assert.equal(await markThreadRead(db, 'T', t), true)
  const first = await inboxPage(db, 'T', { limit: 3 })
  const c = first.counts
  assert.equal(c.threads, 40)
  assert.equal(c.needs_owner, (await all(db, 'T', { status: 'needs_owner', limit: 6 })).length)
  assert.equal(c.needs_owner, 15, '8 positive + 8 other, minus the stopped t0')
  assert.equal(c.unread, (await all(db, 'T', { status: 'unread', limit: 6 })).length)
  assert.equal(c.unread, 37)
  assert.equal(c.unread_needs_owner, (await all(db, 'T', { status: 'unread', limit: 9 })).filter(t => t.needs_owner).length)
  assert.equal(c.unread_needs_owner, 13, 't1 and t5 are read')
  for (const q of [{ limit: 1 }, { limit: 100 }, { status: 'unread' as const, limit: 2 }]) assert.deepEqual((await inboxPage(db, 'T', q)).counts, c)
  // A new reply in a read thread makes it unread again; reading it clears it.
  await reply(db, 'T', 't1', 'l1', 'positive', NOW + 5)
  assert.equal((await inboxPage(db, 'T')).counts.unread, 38)
  assert.equal(await markThreadRead(db, 'T', 't1'), true)
  assert.equal((await inboxPage(db, 'T')).counts.unread, 37)
  // Filters by thread and classification.
  assert.deepEqual((await inboxPage(db, 'T', { threadId: 't3' })).threads.map(t => t.classification), ['opt_out'])
  assert.equal((await all(db, 'T', { classification: 'negative', limit: 3 })).length, 8)
})

bothEngines('the deciding reply: a person\'s newest message decides; an auto-reply only when nothing else came', async ({ db }) => {
  const play = hex(5)
  await job(db, 'T', play)
  for (const l of ['l1', 'l2', 'l3']) await lead(db, play, l, l)
  await reply(db, 'T', 'yes-then-ooo', 'l1', 'positive', NOW - 10); await reply(db, 'T', 'yes-then-ooo', 'l1', 'auto', NOW)
  await reply(db, 'T', 'yes-then-no', 'l2', 'positive', NOW - 10); await reply(db, 'T', 'yes-then-no', 'l2', 'negative', NOW - 5)
  await reply(db, 'T', 'only-ooo', 'l3', 'auto', NOW - 1)
  // A reply flagged for review stops its thread as 'review' (lib/outreach/replies.ts): it needs the owner; a thread
  // stopped for any other reason does not.
  await lead(db, play, 'l4', 'l4'); await lead(db, play, 'l5', 'l5')
  await reply(db, 'T', 'flagged', 'l4', 'uncertain', NOW - 2)
  await reply(db, 'T', 'stopped-yes', 'l5', 'positive', NOW - 3)
  await lead(db, play, 'l6', 'l6'); await lead(db, play, 'l7', 'l7')
  await reply(db, 'T', 'uncertain-reopened', 'l6', 'uncertain', NOW - 4)
  await reply(db, 'T', 'uncertain-optout', 'l7', 'uncertain', NOW - 5)
  for (const [th, l, why] of [['flagged', 'l4', 'review'], ['stopped-yes', 'l5', 'replied'], ['uncertain-reopened', 'l6', 'reopened'], ['uncertain-optout', 'l7', 'opt_out']]) {
    await db.run("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, stopped) VALUES ('T', ?, ?, 'pat@x.example', 'r', ?, ?)", [th, l, NOW, why])
  }
  const rows = Object.fromEntries((await inboxPage(db, 'T')).threads.map(t => [t.thread_id, t]))
  assert.equal(rows['yes-then-ooo'].classification, 'positive'); assert.equal(rows['yes-then-ooo'].needs_owner, true)
  assert.equal(rows['yes-then-no'].classification, 'negative'); assert.equal(rows['yes-then-no'].needs_owner, false)
  assert.equal(rows['only-ooo'].classification, 'auto')
  assert.equal(rows.flagged.needs_owner, true); assert.equal(rows['stopped-yes'].needs_owner, false)
  // An uncertain reply still needs a person on a thread stopped for a weaker reason; an opt-out settles it (as lib/outcomes.ts).
  assert.equal(rows['uncertain-reopened'].needs_owner, true); assert.equal(rows['uncertain-optout'].needs_owner, false)
  assert.deepEqual((await inboxPage(db, 'T', { jobId: play, status: 'needs_owner' })).threads.map(t => t.thread_id), ['flagged', 'uncertain-reopened', 'yes-then-ooo'], 'newest deciding reply first')
})

bothEngines('tenant scope: another tenant\'s rows, leads, plays and threads never show, filter or get marked', async ({ db }) => {
  const playA = hex(6), playB = hex(7)
  await job(db, 'A', playA); await job(db, 'B', playB)
  await lead(db, playA, 'la', 'A Co'); await lead(db, playB, 'lb', 'B Co')
  await reply(db, 'A', 'ta', 'la', 'positive', NOW)
  await reply(db, 'B', 'tb', 'lb', 'positive', NOW)
  // A row of A's that names B's lead id: it is not labelled with B's company, nor placed in B's play.
  await reply(db, 'A', 'tx', 'lb', 'positive', NOW - 1)
  const a = await inboxPage(db, 'A')
  assert.deepEqual(a.threads.map(t => [t.thread_id, t.company, t.job_id]), [['ta', 'A Co', playA], ['tx', null, null]])
  assert.equal(a.counts.threads, 2)
  assert.deepEqual((await inboxPage(db, 'A', { jobId: playB })).threads, [])
  assert.equal((await inboxPage(db, 'A', { jobId: playB })).counts.threads, 0)
  assert.equal(await markThreadRead(db, 'A', 'tb'), false, 'B\'s thread is unknown to A')
  assert.equal((await db.all("SELECT * FROM inbox_thread_reads WHERE tenant_id = 'B'")).length, 0)
  assert.deepEqual((await inboxPage(db, 'B')).threads.map(t => [t.thread_id, t.unread]), [['tb', true]])
})

bothEngines('a malformed cursor is refused, never guessed', async ({ db }) => {
  for (const c of ['nope', Buffer.from('[1]').toString('base64url'), Buffer.from('["x","t"]').toString('base64url')]) {
    await assert.rejects(inboxPage(db, 'T', { cursor: c }), (e: unknown) => e instanceof InboxQueryError && e.code === 'bad_cursor')
  }
  assert.deepEqual(decodeCursor(encodeCursor(NOW, 't1')), { at: NOW, threadId: 't1' })
})

bothEngines('#415 safe hold: a correlated bounce_review notice surfaces as needs_owner on its own notice thread; unmatched noise never flags', async ({ db }) => {
  const playA = hex(9)
  await job(db, 'T', playA)
  await lead(db, playA, 'la', 'Buyer Co')
  // The DSN arrived on its OWN thread (no followup_threads row): correlated to a send, provenance unverified.
  await reply(db, 'T', 'th-dsn-1', 'la', 'bounce_review', NOW)
  // An unmatched notice carries no addresses and no lead: counted, never an owner flag.
  await db.run('INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
    ['g-unmatched', 'T', 'th-dsn-x', '', '', 'bounce_unmatched', NOW + 1])
  const p = await inboxPage(db, 'T', { status: 'needs_owner', limit: 100 })
  assert.equal(p.counts.needs_owner, 1, 'the review notice waits for the owner exactly once')
  const row = p.threads.find(t => t.classification === 'bounce_review')!
  assert.ok(row, 'the bounce_review row is in the needs_owner page')
  assert.equal(row.company, 'Buyer Co', 'the correlated lead gives the owner the company to act on')
  assert.equal(row.needs_owner, true)
  assert.equal(p.threads.some(t => t.classification === 'bounce_unmatched' && t.needs_owner), false, 'unmatched mail never asks for the owner')
})
