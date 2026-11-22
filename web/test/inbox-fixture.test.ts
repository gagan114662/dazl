// The test-only, NO-SEND Inbox fixture (#369, lib/outreach/inbox-fixture.ts) on both engines: the gate, a seeded set
// that spans more than one Inbox page plus one bounce_review notice judged by the reply sync's own notice judgement,
// idempotent and concurrent seeds, and a cleanup that removes the fixture's rows and nothing else. fetch is replaced
// by a counting stub that throws: nothing here may touch the network, a provider or a model.
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { inboxPage, PAGE_MAX, type InboxThread } from '../lib/outreach/inbox.ts'
import { cleanupInboxFixture, fixtureIds, fixtureNotice, inboxFixtureRefusal, InboxFixtureError, INBOX_FIXTURE_FLAG, INBOX_FIXTURE_PLAY, INBOX_FIXTURE_THREADS, seedInboxFixture } from '../lib/outreach/inbox-fixture.ts'
import { judgeDeliveryNotice } from '../lib/outreach/replies.ts'
import { createDraft, draftBlockReason, INBOX_FIXTURE_DOMAIN, isInboxFixtureAddress, OutreachError, recipientAllowed, sendBlockReason, sendMessage } from '../lib/outreach/service.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('Unexpected network call') }) as typeof fetch

const T = 'fixture-test-tenant', OTHER = 'other-tenant'
const ON = { [INBOX_FIXTURE_FLAG]: '1', OUTREACH_TEST_TENANT_ID: T }
const NOW = 1_800_000_000
const ids = fixtureIds(T)

async function pages(db: Db, tenant: string, q: { status?: 'all' | 'needs_owner'; jobId?: string; limit: number }): Promise<{ rows: InboxThread[]; pages: number }> {
  const rows: InboxThread[] = []
  let cursor: string | null = null, n = 0
  for (;;) {
    const p = await inboxPage(db, tenant, { ...q, cursor })
    rows.push(...p.threads); n++
    if (!p.next_cursor) return { rows, pages: n }
    cursor = p.next_cursor
    if (n > 200) throw new Error('pagination did not end')
  }
}
const count = async (db: Db, sql: string, p: (string | number)[]) => Number((await db.get<{ n: number }>(sql, p))?.n ?? 0)

// Real rows next to the fixture: the same tenant's own play, reply and send, plus another tenant holding rows under the
// very ids the fixture derives for T. Cleanup must leave every one of them.
async function seedReal(db: Db) {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, ?, 'x', 'x', 'running')", ['r'.repeat(24), T, INBOX_FIXTURE_PLAY])
  await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('real-lead', ?, 'Pat', 'Real Co', 'hiring', 'https://real.example/a')", ['r'.repeat(24)])
  await db.run("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('dazl-inbox-fixture-999', ?, 'real-thread', 'real-lead', 'pat@real.example', 'real reply', 'other', ?)", [T, NOW])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('realsend', ?, 'real-lead', 'pat@real.example', 'Hello', 'A real outreach message body.', 'sent', ?)", [T, NOW])
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Other', 'x', 'x', 'running')", ['o'.repeat(24), OTHER])
  await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('other-lead', ?, 'Sam', 'Other Co', 'hiring', 'https://other.example/a')", ['o'.repeat(24)])
  for (let i = 0; i < 3; i++) await db.run('INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [ids.gmailIds[i], OTHER, ids.threadIds[i], ids.leadIds[i], 'sam@other.example', 'other tenant reply', 'other', NOW])
  await db.run("INSERT INTO inbox_thread_reads (tenant_id, thread_id, read_upto) VALUES (?, ?, ?)", [OTHER, ids.threadIds[0], NOW])
}
const realCounts = async (db: Db) => [
  await count(db, "SELECT count(*) AS n FROM inbound_messages WHERE tenant_id = ? AND gmail_id = 'dazl-inbox-fixture-999'", [T]),
  await count(db, "SELECT count(*) AS n FROM outreach_messages WHERE id = 'realsend'", []),
  await count(db, 'SELECT count(*) AS n FROM scan_jobs WHERE id IN (?, ?)', ['r'.repeat(24), 'o'.repeat(24)]),
  await count(db, "SELECT count(*) AS n FROM leads WHERE id IN ('real-lead', 'other-lead')", []),
  await count(db, 'SELECT count(*) AS n FROM inbound_messages WHERE tenant_id = ?', [OTHER]),
  await count(db, 'SELECT count(*) AS n FROM inbox_thread_reads WHERE tenant_id = ?', [OTHER]),
]

test('gate: off unless the flag is exactly 1, and only for the designated test tenant; unset or blank designates nobody', () => {
  for (const flag of [undefined, '', '0', 'true', 'TRUE', 'yes', ' 1', '1 ', '01', '1\n', 'on'])
    assert.equal(inboxFixtureRefusal(T, { [INBOX_FIXTURE_FLAG]: flag, OUTREACH_TEST_TENANT_ID: T }), 'fixture_disabled', JSON.stringify(flag))
  for (const designated of [undefined, '', ' ', '\t\n'])
    assert.equal(inboxFixtureRefusal(T, { [INBOX_FIXTURE_FLAG]: '1', OUTREACH_TEST_TENANT_ID: designated }), 'test_tenant_unset', JSON.stringify(designated))
  for (const tenant of [OTHER, '', ` ${T}`, `${T} `, T.toUpperCase(), null, undefined, 1, [T], { id: T }])
    assert.equal(inboxFixtureRefusal(tenant, ON), 'test_tenant_only', JSON.stringify(tenant))
  // an empty tenant id never matches an empty designation: unset is checked first
  assert.equal(inboxFixtureRefusal('', { [INBOX_FIXTURE_FLAG]: '1', OUTREACH_TEST_TENANT_ID: '' }), 'test_tenant_unset')
  assert.equal(inboxFixtureRefusal(T, ON), null)
  // the process env is the default, and it is off here
  assert.equal(process.env[INBOX_FIXTURE_FLAG], undefined)
  assert.equal(inboxFixtureRefusal(T), 'fixture_disabled')
})

bothEngines('seed and cleanup refuse every caller the gate refuses, and write or delete nothing', async ({ db }) => {
  await seedReal(db)
  const before = await realCounts(db)
  const cases: [string, Record<string, string | undefined>][] = [
    [T, {}], [T, { [INBOX_FIXTURE_FLAG]: 'true', OUTREACH_TEST_TENANT_ID: T }], [T, { [INBOX_FIXTURE_FLAG]: '1' }], [OTHER, ON], ['', ON],
  ]
  for (const [tenant, env] of cases) {
    await assert.rejects(seedInboxFixture(db, tenant, { env, now: NOW }), InboxFixtureError)
    await assert.rejects(cleanupInboxFixture(db, tenant, { env }), InboxFixtureError)
  }
  assert.equal(await count(db, 'SELECT count(*) AS n FROM scan_jobs WHERE business_name = ? AND id = ?', [INBOX_FIXTURE_PLAY, ids.jobId]), 0)
  assert.deepEqual(await realCounts(db), before)
  // the designated tenant seeds; another tenant still cannot clean it up
  await seedInboxFixture(db, T, { env: ON, now: NOW })
  await assert.rejects(cleanupInboxFixture(db, OTHER, { env: { ...ON, OUTREACH_TEST_TENANT_ID: T } }), (e: InboxFixtureError) => e.code === 'test_tenant_only')
  assert.equal(await count(db, 'SELECT count(*) AS n FROM inbound_messages WHERE tenant_id = ? AND gmail_id LIKE ?', [T, 'dazl-inbox-fixture-%']), INBOX_FIXTURE_THREADS + 2)
  assert.equal(fetches, 0)
})

bothEngines('a seeded set spans more than one Inbox page, pages without gaps or duplicates, and holds one bounce_review notice', async ({ db }) => {
  assert.ok(INBOX_FIXTURE_THREADS > PAGE_MAX, 'more threads than the largest page')
  const r = await seedInboxFixture(db, T, { env: ON, now: NOW })
  assert.deepEqual(r, { created: true, job_id: ids.jobId, threads: INBOX_FIXTURE_THREADS + 1, bounce_review_thread: ids.bounceThreadId, page_max: PAGE_MAX })
  const first = await inboxPage(db, T, { limit: 50 })
  assert.equal(first.threads.length, 50); assert.ok(first.next_cursor)
  assert.deepEqual(first.counts, { threads: 121, needs_owner: 61, unread: 121, unread_needs_owner: 61 })
  for (const [limit, want] of [[50, 3], [PAGE_MAX, 2], [7, 18], [1, 121]] as const) {
    const all = await pages(db, T, { limit })
    assert.equal(all.pages, want, `pages at size ${limit}`)
    assert.equal(all.rows.length, 121); assert.equal(new Set(all.rows.map(t => t.thread_id)).size, 121, `no duplicates at size ${limit}`)
    const sorted = [...all.rows].sort((a, b) => b.received_at - a.received_at || (a.thread_id < b.thread_id ? 1 : -1))
    assert.deepEqual(all.rows.map(t => t.thread_id), sorted.map(t => t.thread_id), `newest first at size ${limit}`)
  }
  // Needs-you: the server filter pages too, and its rows reconcile with the total.
  const needs = await pages(db, T, { status: 'needs_owner', jobId: ids.jobId, limit: 50 })
  assert.equal(needs.pages, 2); assert.equal(needs.rows.length, 61)
  assert.ok(needs.rows.every(t => t.needs_owner && t.job_id === ids.jobId))
  const bounce = needs.rows.filter(t => t.classification === 'bounce_review')
  assert.equal(bounce.length, 1)
  assert.equal(bounce[0].thread_id, ids.bounceThreadId)
  assert.equal(bounce[0].excerpt, 'dsn status 5.1.1')
  assert.equal(bounce[0].lead_id, ids.bounceLeadId)
  // The stored notice row is exactly what the reply sync's judgement makes of that notice for that send.
  const stored = await db.get<Record<string, unknown>>("SELECT gmail_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id FROM inbound_messages WHERE tenant_id = ? AND classification = 'bounce_review'", [T])
  const send = { id: ids.messageId, lead_id: ids.bounceLeadId, to_email: ids.bounceAddress }
  const v = judgeDeliveryNotice(ids.bounceGmailId, fixtureNotice(ids, NOW - 30 * 86400 + 60), NOW - 30 * 86400, ref => ref === send.id ? send : undefined)
  assert.deepEqual({ ...stored, received_at: Number(stored?.received_at) }, v.row)
  // ...and without the correlated send the same notice is unmatched: the fixture cannot make a review row from nothing.
  assert.equal(judgeDeliveryNotice(ids.bounceGmailId, fixtureNotice(ids, NOW), NOW, () => undefined).row.classification, 'bounce_unmatched')
  // Labelled and unsendable: every fixture address is on the .invalid fixture domain; no positive reply is planted.
  const rows = await db.all<{ from_email: string; excerpt: string; classification: string }>("SELECT from_email, excerpt, classification FROM inbound_messages WHERE tenant_id = ?", [T])
  assert.ok(rows.every(x => isInboxFixtureAddress(x.from_email)))
  assert.ok(rows.every(x => x.classification !== 'positive'))
  assert.ok(rows.filter(x => x.classification !== 'bounce_review').every(x => x.excerpt.startsWith('[test-only fixture ') && x.excerpt.length <= 200))
  const leads = await db.all<{ contact: string; company: string; source_kind: string }>('SELECT contact, company, source_kind FROM leads WHERE scan_job_id = ?', [ids.jobId])
  assert.equal(leads.length, 121)
  assert.ok(leads.every(l => isInboxFixtureAddress(l.contact) && l.company.endsWith('(test only)') && l.source_kind === 'test'))
  const om = await db.get<{ test: number; gmail_id: string | null; thread_id: string | null; claimed_at: number | null; to_email: string }>('SELECT test, gmail_id, thread_id, claimed_at, to_email FROM outreach_messages WHERE id = ?', [ids.messageId])
  assert.deepEqual({ ...om, test: Number(om?.test) }, { test: 1, gmail_id: null, thread_id: null, claimed_at: null, to_email: `bounce@${INBOX_FIXTURE_DOMAIN}` })
  assert.equal(fetches, 0)
})

bothEngines('seeding is idempotent, repeated and concurrent: one set, created once', async ({ db }) => {
  const runs = await Promise.all([1, 2, 3, 4].map(() => seedInboxFixture(db, T, { env: ON, now: NOW })))
  assert.equal(runs.filter(r => r.created).length, 1)
  const again = await seedInboxFixture(db, T, { env: ON, now: NOW + 999 })
  assert.equal(again.created, false)
  assert.equal(await count(db, 'SELECT count(*) AS n FROM inbound_messages WHERE tenant_id = ?', [T]), INBOX_FIXTURE_THREADS + 1)
  assert.equal(await count(db, 'SELECT count(*) AS n FROM leads WHERE scan_job_id = ?', [ids.jobId]), INBOX_FIXTURE_THREADS + 1)
  assert.equal(await count(db, 'SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ?', [T]), 1)
  assert.equal((await inboxPage(db, T, { limit: 1 })).counts.threads, 121)
}, { pgMax: 4 })

bothEngines('cleanup removes the fixture rows of that tenant only; repeated and concurrent cleanups delete nothing more; reseed works', async ({ db }) => {
  await seedReal(db)
  const before = await realCounts(db)
  await seedInboxFixture(db, T, { env: ON, now: NOW })
  // the owner opened a fixture thread: its read row is the fixture's too
  await db.run('INSERT INTO inbox_thread_reads (tenant_id, thread_id, read_upto) VALUES (?, ?, ?)', [T, ids.threadIds[5], NOW])
  const [a, b] = await Promise.all([cleanupInboxFixture(db, T, { env: ON }), cleanupInboxFixture(db, T, { env: ON })])
  const total = (k: keyof typeof a.deleted) => a.deleted[k] + b.deleted[k]
  assert.deepEqual({ threads: total('threads'), sends: total('sends'), leads: total('leads'), plays: total('plays'), reads: total('reads') },
    { threads: INBOX_FIXTURE_THREADS + 1, sends: 1, leads: INBOX_FIXTURE_THREADS + 1, plays: 1, reads: 1 })
  assert.deepEqual((await cleanupInboxFixture(db, T, { env: ON })).deleted, { threads: 0, sends: 0, leads: 0, plays: 0, reads: 0 })
  assert.deepEqual(await realCounts(db), before, 'every real row, and the other tenant\'s rows under the same ids, are untouched')
  const left = await inboxPage(db, T, { limit: 50 })
  assert.deepEqual(left.threads.map(t => t.thread_id), ['real-thread'])
  // a cleanup with nothing seeded is a no-op, and the set can be seeded again
  assert.equal((await seedInboxFixture(db, T, { env: ON, now: NOW })).created, true)
  assert.equal((await inboxPage(db, T, { limit: 1 })).counts.threads, 122)
  assert.equal(fetches, 0)
}, { pgMax: 4 })

test('draft, send, follow-up and sequence paths refuse fixture recipients; nothing reaches Gmail', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  await seedInboxFixture(raw, T, { env: ON, now: NOW })
  for (const leadId of [...ids.leadIds, ids.bounceLeadId]) {
    assert.throws(() => createDraft(raw, T, leadId, 'Biz'), (e: OutreachError) => e instanceof OutreachError && e.code === 'fixture_recipient')
    assert.equal(draftBlockReason(raw, T, leadId), 'fixture_recipient')
  }
  assert.equal((raw.prepare('SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ?').get(T) as { n: number }).n, 1, 'no draft was written')
  // the follow-up and sequence send paths all check recipientAllowed
  for (const a of [...ids.addresses, ids.bounceAddress, `X@${INBOX_FIXTURE_DOMAIN.toUpperCase()}`, ` a@sub.${INBOX_FIXTURE_DOMAIN} `]) assert.equal(recipientAllowed(raw, T, a), false, a)
  for (const a of ['pat@real.example', `a@${INBOX_FIXTURE_DOMAIN}.evil.example`, 'a@dazl.invalid', 'a@xinbox-fixture.dazl.invalid']) assert.equal(isInboxFixtureAddress(a), false, a)
  let sends = 0
  const sendFn = (async () => { sends++; throw new Error('must not send') }) as never
  // the fixture's own recorded send is final: re-sending it is a no-op, and it has no send reason
  assert.equal(await sendMessage(raw, T, ids.messageId, { sendFn }), 'sent')
  assert.equal(sendBlockReason(raw, T, ids.messageId), 'fixture_recipient')
  // an approved message to a fixture address (planted directly) is refused before any claim
  raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('planted', ?, ?, ?, 'Hi', 'A planted approved message body.', 'approved')").run(T, ids.leadIds[0], ids.addresses[0])
  await assert.rejects(sendMessage(raw, T, 'planted', { sendFn }), (e: OutreachError) => e.code === 'fixture_recipient')
  assert.equal((raw.prepare("SELECT status, claimed_at FROM outreach_messages WHERE id = 'planted'").get() as { status: string }).status, 'approved')
  assert.equal(sends, 0)
  assert.equal(fetches, 0)
})
