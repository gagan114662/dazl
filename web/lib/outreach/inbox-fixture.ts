// Test-only, NO-SEND Inbox fixture for the designated test tenant (#369). The deployed Inbox has two criteria that real
// data cannot reach on the test account: more than one page of conversations, and a correlated delivery notice held
// for review (bounce_review). Replies only enter through the consent-gated Gmail reply scan, and sending mail or
// editing the database by hand is not allowed, so this writes a clearly labelled synthetic set instead:
//   - INBOX_FIXTURE_THREADS reply threads in one labelled play, more than the Inbox's largest page (PAGE_MAX), with a
//     mix of classes so the Needs-you filter has fewer rows than the full list;
//   - one bounce_review thread, made by passing a synthetic delivery-status notice through judgeDeliveryNotice, the
//     same judgement the reply sync stores real notices with (lib/outreach/replies.ts).
// Nothing is fetched, sent or asked of a model: no Gmail, no provider, no network. Every address is on
// INBOX_FIXTURE_DOMAIN (.invalid: cannot resolve), which recipientAllowed and the draft and send checks refuse
// (lib/outreach/service.ts). Every text is fixed here and says it is a test-only fixture.
//
// Gate (inboxFixtureRefusal): OFF unless OUTREACH_INBOX_FIXTURE is exactly '1', and only for the tenant named by
// OUTREACH_TEST_TENANT_ID (unset or blank refuses everyone). The route adds the session, the owner role and the audit.
// Seed and cleanup both re-check the gate themselves, so no caller can skip it.
//
// Every row id is derived from the tenant (fixtureIds), so seeding is idempotent and two concurrent seeds create one
// set: the play row is the claim (INSERT ... ON CONFLICT DO NOTHING, inside the same transaction as the rest). Cleanup
// deletes exactly those ids for that tenant, each further pinned to its fixture marker (play name, fixture address,
// owning play), and nothing else. On the Db layer: SQLite and Postgres.
import { createHash } from 'node:crypto'
import { asDb, type DbLike, type Param } from '../db/client.ts'
import { PAGE_MAX } from './inbox.ts'
import { judgeDeliveryNotice, NOTICE_INSERT, NOTICE_SEND_SQL, noticeParams, type NoticeMsg, type NoticeSend } from './replies.ts'
import { INBOX_FIXTURE_DOMAIN } from './service.ts'

export const INBOX_FIXTURE_FLAG = 'OUTREACH_INBOX_FIXTURE'
export const INBOX_FIXTURE_PLAY = 'dazl inbox pagination fixture (test only)'
export const INBOX_FIXTURE_THREADS = 120
// Classes cycle over the threads. None is 'positive': lookalike seeding and play analytics read positive replies as
// real interest, and a fixture must never count as that. other and uncertain need the owner; negative and auto do not.
const CLASSES = ['other', 'uncertain', 'negative', 'auto'] as const
const SIGNAL = 'Test-only inbox fixture (#369). Not a real company or person. dazl found, verified and sent nothing.'
const SOURCE_URL = 'https://dazl.ai/test-only-inbox-fixture'
const AGE_S = 30 * 86400 // placed a month back: outside every recent-reply and 24-hour send window
export const FIXTURE_DSN_STATUS = '5.1.1'

export type FixtureRefusal = 'fixture_disabled' | 'test_tenant_unset' | 'test_tenant_only'
export class InboxFixtureError extends Error {
  code: FixtureRefusal | 'fixture_incomplete'
  constructor(code: FixtureRefusal | 'fixture_incomplete') { super(code); this.code = code }
}

// null when this tenant may seed or clean up the fixture; otherwise why not. The flag is exactly '1' (not 'true', not
// ' 1'); the designated tenant id must be set, non-blank and equal to the session's tenant, compared exactly.
export function inboxFixtureRefusal(tenantId: unknown, env: Record<string, string | undefined> = process.env): FixtureRefusal | null {
  if (env[INBOX_FIXTURE_FLAG] !== '1') return 'fixture_disabled'
  const designated = env.OUTREACH_TEST_TENANT_ID
  if (typeof designated !== 'string' || designated.trim() === '') return 'test_tenant_unset'
  if (typeof tenantId !== 'string' || tenantId !== designated) return 'test_tenant_only'
  return null
}

const pad = (i: number) => String(i + 1).padStart(3, '0')
export function fixtureIds(tenantId: string) {
  const h = createHash('sha256').update(`dazl-inbox-fixture-v1:${tenantId}`).digest('hex')
  const n = Array.from({ length: INBOX_FIXTURE_THREADS }, (_, i) => pad(i))
  return {
    jobId: h.slice(0, 24),
    leadIds: n.map(k => `inboxfx-${h.slice(0, 12)}-${k}`),
    bounceLeadId: `inboxfx-${h.slice(0, 12)}-bounce`,
    // [a-z0-9] only: the delivery notice references it as dazl.<id>@..., the form the notice correlation reads
    messageId: `inboxfixture${h.slice(0, 16)}`,
    gmailIds: n.map(k => `dazl-inbox-fixture-${k}`),
    threadIds: n.map(k => `dazl-inbox-fixture-thread-${k}`),
    bounceGmailId: 'dazl-inbox-fixture-bounce',
    bounceThreadId: 'dazl-inbox-fixture-thread-bounce',
    addresses: n.map(k => `fixture-${k}@${INBOX_FIXTURE_DOMAIN}`),
    bounceAddress: `bounce@${INBOX_FIXTURE_DOMAIN}`,
  }
}

// The synthetic delivery-status notice for the fixture send: a permanent failure that correlates (exact Message-ID
// reference and named recipient) but has no authenticated provenance, so the shared judgement holds it for review.
export function fixtureNotice(ids: ReturnType<typeof fixtureIds>, at: number): NoticeMsg {
  const dsn = `Reporting-MTA: dns; ${INBOX_FIXTURE_DOMAIN}\nFinal-Recipient: rfc822; ${ids.bounceAddress}\nAction: failed\nStatus: ${FIXTURE_DSN_STATUS}\n`
  return {
    id: ids.bounceGmailId, threadId: ids.bounceThreadId, internalDate: String(at * 1000),
    payload: {
      mimeType: 'multipart/report',
      headers: [
        { name: 'From', value: `Mail Delivery Subsystem <mailer-daemon@${INBOX_FIXTURE_DOMAIN}>` },
        { name: 'Subject', value: '[test-only fixture] Delivery Status Notification (Failure)' },
        { name: 'Original-Message-ID', value: `<dazl.${ids.messageId}@${INBOX_FIXTURE_DOMAIN}>` },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Test-only fixture notice (#369). No message was sent, so none bounced.').toString('base64url') } },
        { mimeType: 'message/delivery-status', body: { data: Buffer.from(dsn).toString('base64url') } },
      ],
    },
  }
}

export interface SeedResult { created: boolean; job_id: string; threads: number; bounce_review_thread: string; page_max: number }

export async function seedInboxFixture(d: DbLike, tenantId: string, o: { env?: Record<string, string | undefined>; now?: number } = {}): Promise<SeedResult> {
  const why = inboxFixtureRefusal(tenantId, o.env); if (why) throw new InboxFixtureError(why)
  const db = asDb(d)
  const ids = fixtureIds(tenantId)
  const base = (o.now ?? Math.floor(Date.now() / 1000)) - AGE_S
  const result = (created: boolean): SeedResult => ({ created, job_id: ids.jobId, threads: INBOX_FIXTURE_THREADS + 1, bounce_review_thread: ids.bounceThreadId, page_max: PAGE_MAX })
  const created = await db.tx(function* (t) {
    // The play row is the claim: a second or concurrent seed finds it and writes nothing.
    const claim = yield* t.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, ?, 'test only', 'test only', 'running') ON CONFLICT (id) DO NOTHING",
      [ids.jobId, tenantId, INBOX_FIXTURE_PLAY])
    if (claim.changes !== 1) return false
    const lead = "INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, source_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'test')"
    for (let i = 0; i < INBOX_FIXTURE_THREADS; i++) {
      yield* t.run(lead, [ids.leadIds[i], ids.jobId, `Fixture contact ${pad(i)}`, `Inbox fixture ${pad(i)} (test only)`, ids.addresses[i], SIGNAL, SOURCE_URL])
      // Pairs of threads share a second, so live pagination also crosses ties.
      yield* t.run(`INSERT INTO inbound_messages ${NOTICE_INSERT}`, [ids.gmailIds[i], tenantId, ids.threadIds[i], ids.leadIds[i], ids.addresses[i],
        `[test-only fixture ${pad(i)}/${INBOX_FIXTURE_THREADS}] Synthetic reply for the Inbox pagination check (#369). Nothing was sent or received.`,
        CLASSES[i % CLASSES.length], base - Math.floor(i / 2) * 60, null])
    }
    yield* t.run(lead, [ids.bounceLeadId, ids.jobId, 'Fixture bounce contact', 'Inbox fixture bounce (test only)', ids.bounceAddress, SIGNAL, SOURCE_URL])
    yield* t.run("UPDATE scan_jobs SET status = 'done' WHERE id = ? AND user_id = ? AND status = 'running'", [ids.jobId, tenantId])
    // The recorded send the notice correlates to. Marked test (test = 1) and addressed to the fixture domain; no Gmail
    // id or thread, so the reply sync never reads it; sent_at a month back and never claimed, so no 24-hour send count
    // includes it. Status 'sent' is what the notice correlation requires; 'sent' is final, so nothing can move it.
    yield* t.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, test) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, 1)",
      [ids.messageId, tenantId, ids.bounceLeadId, ids.bounceAddress, '[test-only fixture] Inbox bounce check (not a real email)',
        'Test-only fixture message for the #369 bounce_review check. Not a real outreach email; nothing was sent.', base - 3600])
    const send = yield* t.get<NoticeSend>(NOTICE_SEND_SQL, [tenantId, ids.messageId])
    const v = judgeDeliveryNotice(ids.bounceGmailId, fixtureNotice(ids, base + 60), base, ref => (send && ref === send.id ? send : undefined))
    // Fail closed: a fixture that would not be judged bounce_review proves nothing, and nothing of it is kept.
    if (v.row.classification !== 'bounce_review') throw new InboxFixtureError('fixture_incomplete')
    yield* t.run(`INSERT INTO inbound_messages ${NOTICE_INSERT}`, noticeParams(tenantId, v.row))
    return true
  })
  return result(created)
}

export interface CleanupResult { deleted: { threads: number; sends: number; leads: number; plays: number; reads: number } }

// Removes exactly the fixture's rows for this tenant, in one transaction; a second call deletes nothing. A row that is
// not the fixture's - another tenant's, a real play, a real reply - never matches: every delete names the tenant and
// the derived ids, and each is pinned again to its marker.
export async function cleanupInboxFixture(d: DbLike, tenantId: string, o: { env?: Record<string, string | undefined> } = {}): Promise<CleanupResult> {
  const why = inboxFixtureRefusal(tenantId, o.env); if (why) throw new InboxFixtureError(why)
  const db = asDb(d)
  const ids = fixtureIds(tenantId)
  const inList = (xs: string[]) => `(${xs.map(() => '?').join(', ')})`
  const gmail = [...ids.gmailIds, ids.bounceGmailId], threads = [...ids.threadIds, ids.bounceThreadId], leads = [...ids.leadIds, ids.bounceLeadId]
  return db.tx(function* (t) {
    const job = yield* t.get<{ id: string }>('SELECT id FROM scan_jobs WHERE id = ? AND user_id = ? AND business_name = ?', [ids.jobId, tenantId, INBOX_FIXTURE_PLAY])
    const r = (sql: string, p: Param[]) => t.run(sql, p)
    const inbound = yield* r(`DELETE FROM inbound_messages WHERE tenant_id = ? AND gmail_id IN ${inList(gmail)} AND (lead_id IS NULL OR lead_id IN ${inList(leads)})`, [tenantId, ...gmail, ...leads])
    const reads = yield* r(`DELETE FROM inbox_thread_reads WHERE tenant_id = ? AND thread_id IN ${inList(threads)}`, [tenantId, ...threads])
    const messages = yield* r("DELETE FROM outreach_messages WHERE tenant_id = ? AND id = ? AND lead_id = ? AND to_email = ? AND test = 1", [tenantId, ids.messageId, ids.bounceLeadId, ids.bounceAddress])
    let leadsDeleted = 0, plays = 0
    if (job) {
      leadsDeleted = (yield* r(`DELETE FROM leads WHERE scan_job_id = ? AND id IN ${inList(leads)}`, [job.id, ...leads])).changes
      plays = (yield* r('DELETE FROM scan_jobs WHERE id = ? AND user_id = ? AND business_name = ?', [job.id, tenantId, INBOX_FIXTURE_PLAY])).changes
    }
    return { deleted: { threads: inbound.changes, sends: messages.changes, leads: leadsDeleted, plays, reads: reads.changes } }
  })
}
