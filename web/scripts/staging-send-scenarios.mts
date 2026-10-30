// Send-safety scenarios for staging (issue #362, part 2; docs/STAGING.md "Send-safety scenarios"). Drives the app's real
// send, sequence, reply-sync, unsubscribe and uncertain-send code end to end on an isolated SQLite file, and writes an
// evidence report. Six scenarios:
//   owned-inbox-handoff  an approved message addressed to the owned staging inbox is handed to the provider interface
//                exactly once. The recorded MIME is decoded and checked: subject, recipient and sender; the body before
//                the footer is exactly the approved words; the footer carries the sender's name and postal address and
//                an unsubscribe link equal to the List-Unsubscribe header that resolves to this message; the recorded
//                hash is of those bytes. A message edited after approval is refused (approval hash). This is the
//                recorded hand-off, not delivery: nothing reaches an inbox
//   reply-stop   a reply in the thread stops the sequence: step 2 is never sent; a control sequence with no reply does
//                send step 2 at the same time (so the stop is the reply's doing, not the clock's)
//   opt-out      the unsubscribe link from the sent message suppresses the address for that tenant: its next approved
//                message is not sent; another tenant's message to the same address still is (tenant scope)
//   bounce       a mailer-daemon 5.x.x bounce in the thread suppresses the address; the next message is not sent
//   uncertain    a send whose outcome is unknown (network error after the hand-off) is marked uncertain and never
//                retried; every other send for that tenant is blocked until an operator resolves it
//   restart      a process is killed (SIGKILL) inside the provider call; a fresh process on the same database reaps the
//                claim as uncertain, makes no provider call, and blocks the tenant's other sends
//
// Sending is OFF: every scenario stops at a recorded hand-off to the provider interface. The only transport is a recorder that writes each message to transport.log and returns a fake id. It
// never opens a connection (the script runs under test/helpers/net-fence.ts, which throws on any non-loopback socket),
// and it refuses any recipient outside the fixed allowlist below (reserved *.staging.dazl.test addresses), failing the
// run. Gmail token and thread reads are answered by an in-process stub. The master key is generated per run. No
// production data, credentials or database is touched: the database is a new file in --out, which must be new or
// empty and may not be inside DB_PATH's directory. A real send (owned inbox through a real provider) is NOT possible
// from this script; it needs an approved sending identity, recipients and words and a separately reviewed change.
//   DAZL_ENV=staging npm run -s staging:scenarios -- --out /var/lib/dazl-staging/scenarios/<date>
// Exit 0 = every scenario passed (evidence.json "ok": true); 1 = a scenario failed; 2 = refused to run.
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { completeOAuth, GMAIL_READ_SCOPE, startOAuth } from '../lib/gmail/oauth.ts'
import { approve, editDraft, isSuppressed, readUnsubToken, resolveUncertain, saveSettings, sendMessage, unsubscribeByToken, type Deps } from '../lib/outreach/service.ts'
import { acceptReadConsent, syncReplies } from '../lib/outreach/replies.ts'
import { approveSequence, createSequence, runSequences } from '../lib/outreach/sequences.ts'

const DAY = 86_400
const NOW = 1_900_000_000
// Every address a scenario may send to. Reserved test domain: even a real provider could not deliver there.
export const ALLOWLIST = new Set([
  'owner-inbox@staging.dazl.test', 'reply-lead@staging.dazl.test', 'control-lead@staging.dazl.test', 'optout-lead@staging.dazl.test',
  'bounce-lead@staging.dazl.test', 'uncertain-lead@staging.dazl.test', 'second-lead@staging.dazl.test', 'restart-lead@staging.dazl.test',
])
const GENV = { GOOGLE_CLIENT_ID: 'scenario.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'scenario-not-a-secret', PUBLIC_BASE_URL: 'https://staging.dazl.test' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8')
const header = (mime: string, name: string) => new RegExp(`^${name}: (.*)$`, 'mi').exec(mime)?.[1]?.trim() ?? null
// The text/plain body of a recorded message (lib/gmail/mime.ts: base64 transfer encoding, CRLF line ends), as text.
export function recordedBody(mime: string): string | null {
  const at = mime.indexOf('\r\n\r\n'); if (at < 0) return null
  if (!/^Content-Transfer-Encoding: base64$/mi.test(mime.slice(0, at))) return null
  return Buffer.from(mime.slice(at + 4).replace(/\s+/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n')
}
const SENDER = { sender_name: 'Scenario Sender', postal_address: '100 Demo Street, Columbus, OH 43004 (staging test address)' }

export class AllowlistError extends Error {}
// The only transport: refuses anything not on the allowlist, records the rest, returns a fake provider id.
export function recordingTransport(log: string, tenant: string, onAttempt?: () => Promise<void>) {
  let n = 0
  return async (_token: string, raw: string, _f?: unknown, threadId?: string) => {
    const mime = decode(raw)
    const to = (header(mime, 'To') ?? '').replace(/^.*</, '').replace(/>.*$/, '').trim().toLowerCase()
    if (!ALLOWLIST.has(to)) throw new AllowlistError(`recipient ${to || '(none)'} is not on the scenario allowlist; nothing recorded`)
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), tenant, to, subject: header(mime, 'Subject'), sha256: createHash('sha256').update(mime).digest('hex'), pid: process.pid }) + '\n')
    if (onAttempt) await onAttempt()
    n++
    return { id: `rec-${tenant}-${n}`, threadId: threadId ?? `thread-${tenant}-${n}` }
  }
}
// Gmail as the app sees it: a token endpoint and the threads dazl started. Anything else is refused.
function gmailStub(threads: Record<string, unknown[]> = {}) {
  return (async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('https://oauth2.googleapis.com/')) return json({ access_token: 'scenario-access-token', expires_in: 3600 })
    const m = /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/threads\/([^?]+)/.exec(u)
    if (m) return json({ messages: threads[decodeURIComponent(m[1])] ?? [] })
    throw new Error(`scenario gmail stub: refused ${u}`)
  }) as unknown as typeof fetch
}
const inbound = (id: string, from: string, body: string, at: number) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: Buffer.from(body).toString('base64url') } } })

async function tenant(db: Database.Database, id: string, master: Buffer) {
  db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y')").run(id, `${id}@staging.dazl.test`)
  const state = new URL(startOAuth(db, id, { env: GENV, now: NOW, withRead: true })).searchParams.get('state')!
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: `sender-${id}@staging.dazl.test`, email_verified: true })).toString('base64url') + '.y'
  await completeOAuth(db, id, 'scenario-code', state, { env: GENV, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'scenario-refresh', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken })) as unknown as typeof fetch })
  saveSettings(db, id, SENDER)
  acceptReadConsent(db, id)
}
function draft(db: Database.Database, tenantId: string, to: string, words = 'A short note about your new location. This is synthetic staging test text.') {
  const job = createJob(db, tenantId, { business_name: 'Scenario Co', industry: 'dental', location: 'Ohio' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Scenario Dental (staging)', to, 'Opening a second location', 'https://scenario-dental.example.test/news', 'Scenario Dental is opening a second location. (synthetic)', 90)
  db.prepare("UPDATE leads SET human_confirmed_at = ?, human_confirmed_from = 'staging_scenario' WHERE id = ?").run(NOW, lead)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body) VALUES (?, ?, ?, ?, 'A quick question', ?)").run(mid, tenantId, lead, to, words)
  return { lead, mid }
}
const status = (db: Database.Database, mid: string) => db.prepare('SELECT status, error, approved_hash FROM outreach_messages WHERE id = ?').get(mid) as { status: string; error: string | null; approved_hash: string | null }
const lines = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const sentTo = (log: string, tenantId: string) => lines(log).filter(l => l.tenant === tenantId)

type Check = { what: string; ok: boolean; detail?: string }
type Scenario = { name: string; ok: boolean; ms: number; checks: Check[]; error?: string }

async function scenarios(out: string, master: Buffer): Promise<Scenario[]> {
  const dbPath = path.join(out, 'scenarios.db'), log = path.join(out, 'transport.log')
  const db = new Database(dbPath)
  migrateAllSqlite(db)
  const deps = (t: string, o: Partial<Deps> & { flags?: Record<string, string> } = {}) => ({ env: GENV, master, now: NOW, baseUrl: 'https://staging.dazl.test', fetchImpl: gmailStub(), sendFn: recordingTransport(log, t) as never, ...o })
  const results: Scenario[] = []
  const run = async (name: string, body: (c: (what: string, ok: boolean, detail?: string) => void) => Promise<void>) => {
    const checks: Check[] = [], t0 = Date.now()
    try { await body((what, ok, detail) => checks.push({ what, ok: !!ok, ...(detail ? { detail } : {}) })) }
    catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, checks, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }); return }
    results.push({ name, ok: checks.length > 0 && checks.every(c => c.ok), ms: Date.now() - t0, checks })
  }
  const rejects = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e instanceof Error ? e.message : String(e) } }

  // the messages as handed off, by provider id, for the content checks
  const mimes: Record<string, string> = {}
  const capture = (t: string) => { const rec = recordingTransport(log, t); return (async (tok: string, raw: string, f?: unknown, th?: string) => { const r = await rec(tok, raw, f, th); mimes[r.id] = decode(raw); return r }) as never }

  await run('owned-inbox-handoff', async check => {
    const T = 'scn-owned'; await tenant(db, T, master)
    const OWNED = 'owner-inbox@staging.dazl.test'
    const words = 'Owned inbox scenario: these exact approved words must be what is handed off.\nSecond line, kept as written. (synthetic)'
    const m = draft(db, T, OWNED, words); approve(db, T, m.mid)
    const approved = db.prepare('SELECT subject, body, to_email FROM outreach_messages WHERE id = ?').get(m.mid) as { subject: string; body: string; to_email: string }
    check('approval hash recorded', !!status(db, m.mid).approved_hash)
    check('send result', await sendMessage(db, T, m.mid, deps(T, { sendFn: capture(T) })) === 'sent')
    check('sent again: no second hand-off', await sendMessage(db, T, m.mid, deps(T)) === 'sent' && sentTo(log, T).length === 1, `${sentTo(log, T).length} hand-off(s)`)
    const rec = sentTo(log, T)[0]
    const mime = mimes[(db.prepare('SELECT gmail_id FROM outreach_messages WHERE id = ?').get(m.mid) as { gmail_id: string }).gmail_id] ?? ''
    check('recorded hash is of the bytes handed off', !!mime && rec?.sha256 === createHash('sha256').update(mime).digest('hex'))
    check('addressed only to the owned inbox', rec?.to === OWNED && header(mime, 'To') === OWNED, header(mime, 'To') ?? '')
    check('from the connected sender', (header(mime, 'From') ?? '').includes(`<sender-${T}@staging.dazl.test>`), header(mime, 'From') ?? '')
    check('subject is the approved subject', header(mime, 'Subject') === approved.subject, header(mime, 'Subject') ?? '')
    const body = recordedBody(mime) ?? ''
    const cut = body.indexOf('\n\n--\n')
    check('body before the footer is exactly the approved words', cut >= 0 && body.slice(0, cut) === approved.body.trim(), cut >= 0 ? `${body.slice(0, cut).length} chars` : 'no footer marker')
    const footer = cut >= 0 ? body.slice(cut + 5).split('\n') : []
    check("footer: the sender's name and postal address", footer[0] === SENDER.sender_name && footer[1] === SENDER.postal_address, footer.slice(0, 2).join(' | '))
    const link = header(mime, 'List-Unsubscribe')?.replace(/^<|>$/g, '') ?? ''
    const inBody = /unsubscribe here: (\S+)\s*$/.exec(body)?.[1] ?? ''
    check('footer unsubscribe link equals the List-Unsubscribe header', !!link && inBody === link, inBody.slice(0, 50))
    let tok: string | null = null; try { tok = new URL(link).searchParams.get('t') } catch { /* checked below */ }
    check('the link resolves to this message', !!tok && readUnsubToken(tok, master) === m.mid)
    // another allowlisted inbox: a second first email to the owned inbox from another lead is refused before approval
    // (cross-play recipient cooldown, #364), and this check is about an edit after approval
    const edited = draft(db, T, 'second-lead@staging.dazl.test'); approve(db, T, edited.mid)
    editDraft(db, T, edited.mid, { subject: 'A quick question', body: 'Words changed after approval. (synthetic)' })
    const why = await rejects(sendMessage(db, T, edited.mid, deps(T)))
    check('edited after approval: refused', !!why && sentTo(log, T).length === 1, why ?? 'sent')
  })

  await run('reply-stop', async check => {
    const T = 'scn-reply'; await tenant(db, T, master)
    const flags = { SEQUENCES_ENABLED: '1' }
    const replied = draft(db, T, 'reply-lead@staging.dazl.test'), control = draft(db, T, 'control-lead@staging.dazl.test')
    for (const m of [replied, control]) { const seq = createSequence(db, T, m.mid); approveSequence(db, T, seq, id => approve(db, T, id, true), NOW) }
    await sendMessage(db, T, replied.mid, deps(T)); await sendMessage(db, T, control.mid, deps(T))
    const thread = (db.prepare('SELECT thread_id FROM outreach_messages WHERE id = ?').get(replied.mid) as { thread_id: string }).thread_id
    const later = NOW + 4 * DAY
    const threads = { [thread]: [inbound('in-1', 'reply-lead@staging.dazl.test', 'Thanks, we are interested - can you call me next week? (synthetic)', NOW + DAY)] }
    await runSequences(db, T, 'Scenario Co', deps(T, { now: later, fetchImpl: gmailStub(threads), flags }))
    await runSequences(db, T, 'Scenario Co', deps(T, { now: later + 60, fetchImpl: gmailStub(threads), flags })) // a second tick
    const to = sentTo(log, T).map(l => l.to)
    check('replied lead: step 1 only, step 2 never sent', to.filter(t => t === 'reply-lead@staging.dazl.test').length === 1, `${to.filter(t => t === 'reply-lead@staging.dazl.test').length} send(s)`)
    check('control lead (no reply): step 2 sent at the same time, once', to.filter(t => t === 'control-lead@staging.dazl.test').length === 2, `${to.filter(t => t === 'control-lead@staging.dazl.test').length} send(s)`)
    const seq = db.prepare("SELECT status FROM sequences WHERE tenant_id = ? AND message_id = ?").get(T, replied.mid) as { status: string }
    check('replied sequence is stopped', seq.status === 'replied' || seq.status === 'stopped', seq.status)
  })

  await run('opt-out', async check => {
    const A = 'scn-optout-a', B = 'scn-optout-b'; await tenant(db, A, master); await tenant(db, B, master)
    const to = 'optout-lead@staging.dazl.test'
    const first = draft(db, A, to); approve(db, A, first.mid)
    await sendMessage(db, A, first.mid, deps(A, { sendFn: capture(A) }))
    const optMime = Object.values(mimes).at(-1) ?? ''
    const link = header(optMime, 'List-Unsubscribe')?.replace(/^<|>$/g, '') ?? ''
    const token = link ? new URL(link).searchParams.get('t') : null
    check('sent message carries a List-Unsubscribe link', !!token, link.slice(0, 60))
    check('the link unsubscribes', !!token && unsubscribeByToken(db, token, master))
    check('suppressed for that tenant', isSuppressed(db, A, to))
    check('not suppressed for another tenant', !isSuppressed(db, B, to))
    const next = draft(db, A, to)
    const why = await rejects((async () => { approve(db, A, next.mid); return sendMessage(db, A, next.mid, deps(A)) })())
    check('next message to the address: not sent', sentTo(log, A).length === 1, why ?? status(db, next.mid).status)
    const other = draft(db, B, to); approve(db, B, other.mid)
    check('another tenant can still send to it', await sendMessage(db, B, other.mid, deps(B)) === 'sent' && sentTo(log, B).length === 1)
  })

  await run('bounce', async check => {
    const T = 'scn-bounce'; await tenant(db, T, master)
    const to = 'bounce-lead@staging.dazl.test'
    const first = draft(db, T, to); approve(db, T, first.mid); await sendMessage(db, T, first.mid, deps(T))
    const thread = (db.prepare('SELECT thread_id FROM outreach_messages WHERE id = ?').get(first.mid) as { thread_id: string }).thread_id
    const r = await syncReplies(db, T, { env: GENV, master, now: NOW + DAY, fetchImpl: gmailStub({ [thread]: [inbound('dsn-1', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure). 550 5.1.1 The email account that you tried to reach does not exist. (synthetic)', NOW + 600)] }) })
    check('sync records the bounce', r.bounces === 1, JSON.stringify(r))
    check('the address is suppressed', isSuppressed(db, T, to))
    const next = draft(db, T, to)
    const why = await rejects((async () => { approve(db, T, next.mid); return sendMessage(db, T, next.mid, deps(T, { now: NOW + DAY })) })())
    check('next message to the address: not sent', sentTo(log, T).length === 1, why ?? status(db, next.mid).status)
  })

  await run('uncertain', async check => {
    const T = 'scn-uncertain'; await tenant(db, T, master)
    const m = draft(db, T, 'uncertain-lead@staging.dazl.test'); approve(db, T, m.mid)
    const rec = recordingTransport(log, T)
    // the provider took the message and the connection then dropped: outcome unknown
    const dropped = (async (tok: string, raw: string, f?: unknown, th?: string) => { await rec(tok, raw, f, th); throw new TypeError('fetch failed: socket hang up (synthetic)') }) as never
    check('send outcome unknown: marked uncertain', await sendMessage(db, T, m.mid, deps(T, { sendFn: dropped })) === 'uncertain' && status(db, m.mid).status === 'uncertain', status(db, m.mid).error ?? '')
    const again = await rejects(sendMessage(db, T, m.mid, deps(T)))
    check('the uncertain message is not retried', sentTo(log, T).length === 1, again ?? 'returned')
    const second = draft(db, T, 'second-lead@staging.dazl.test'); approve(db, T, second.mid)
    const why = await rejects(sendMessage(db, T, second.mid, deps(T)))
    check('other sends for the tenant are blocked while it is unresolved', !!why && sentTo(log, T).length === 1, why ?? 'sent')
    resolveUncertain(db, T, m.mid, 'sent', deps(T))
    check('after the operator marks it sent, the next send goes', await sendMessage(db, T, second.mid, deps(T)) === 'sent' && sentTo(log, T).length === 2)
  })

  // restart: the claim is made in a child process that is killed inside the provider call
  await run('restart', async check => {
    const T = 'scn-restart'; await tenant(db, T, master)
    const m = draft(db, T, 'restart-lead@staging.dazl.test'); approve(db, T, m.mid)
    const other = draft(db, T, 'second-lead@staging.dazl.test'); approve(db, T, other.mid)
    db.close()
    const child = (mode: string, extra: string[] = []) => spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--child', mode, dbPath, log, T, ...extra], { env: { ...process.env, SCENARIO_MASTER_B64: master.toString('base64') }, stdio: ['ignore', 'pipe', 'pipe'] })
    const a = child('claim', [m.mid])
    const attempted = await new Promise<boolean>(resolve => { a.stdout.on('data', d => { if (String(d).includes('IN_PROVIDER_CALL')) resolve(true) }); a.on('exit', () => resolve(false)); setTimeout(() => resolve(false), 30_000) })
    check('first process reached the provider call', attempted)
    a.kill('SIGKILL'); await new Promise(r => a.once('exit', r))
    const reopened = new Database(dbPath)
    check('after the kill the claim is still held (sending)', status(reopened, m.mid).status === 'sending', status(reopened, m.mid).status); reopened.close()
    const b = child('restart', [m.mid, other.mid])
    let outB = ''; b.stdout.on('data', d => { outB += d }); b.stderr.on('data', d => { outB += d })
    const code = await new Promise(r => b.once('exit', r))
    const res = (() => { try { return JSON.parse(outB.trim().split('\n').at(-1) ?? '{}') } catch { return { raw: outB.slice(-400) } } })()
    check('fresh process ran', code === 0, JSON.stringify(res).slice(0, 300))
    const after = new Database(dbPath)
    check('the interrupted claim is reaped as uncertain', status(after, m.mid).status === 'uncertain' && status(after, m.mid).error === 'send_interrupted', `${status(after, m.mid).status}/${status(after, m.mid).error}`)
    check('no second provider call for it, from any process', sentTo(log, T).filter(l => l.to === 'restart-lead@staging.dazl.test').length === 1)
    check("the tenant's other approved message is blocked", status(after, other.mid).status === 'approved' && sentTo(log, T).length === 1, res.other ?? '')
    after.close()
  })
  return results
}

// Child processes of the restart scenario.
async function childMain(mode: string, dbPath: string, log: string, T: string, mid: string, other?: string) {
  const master = Buffer.from(process.env.SCENARIO_MASTER_B64 ?? '', 'base64')
  const db = new Database(dbPath)
  if (mode === 'claim') {
    // reach the provider call, say so, and hang there until killed
    const sendFn = recordingTransport(log, T, async () => { process.stdout.write('IN_PROVIDER_CALL\n'); await new Promise(() => {}) })
    await sendMessage(db, T, mid, { env: GENV, master, now: NOW, baseUrl: 'https://staging.dazl.test', fetchImpl: gmailStub(), sendFn: sendFn as never })
    return
  }
  // restart: eleven minutes later (past the 10-minute stale claim), a new process tries both messages
  const d = { env: GENV, master, now: NOW + 660, baseUrl: 'https://staging.dazl.test', fetchImpl: gmailStub(), sendFn: recordingTransport(log, T) as never }
  const tryOne = async (id: string) => { try { return await sendMessage(db, T, id, d) } catch (e) { return e instanceof Error ? e.message : String(e) } }
  const out = { first: await tryOne(mid), other: other ? await tryOne(other) : null }
  db.close()
  process.stdout.write(JSON.stringify(out) + '\n')
}

function refuse(why: string): never { console.error(`staging-send-scenarios: refused: ${why}`); process.exit(2) }
function commit(): string | null {
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try { return readFileSync(path.join(here, '.build-commit'), 'utf8').trim() } catch { /* not built */ }
  try { const head = readFileSync(path.join(here, '../.git/HEAD'), 'utf8').trim(); return head.startsWith('ref: ') ? readFileSync(path.join(here, '../.git', head.slice(5)), 'utf8').trim() : head } catch { return null }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  if (args[0] === '--child') { await childMain(args[1], args[2], args[3], args[4], args[5], args[6]); process.exit(0) }
  if (process.env.DAZL_ENV !== 'staging') refuse('DAZL_ENV must be staging')
  const at = args.indexOf('--out'); const outArg = at >= 0 ? args[at + 1] : null
  if (!outArg) refuse('usage: staging-send-scenarios.mts --out DIR (a new or empty directory)')
  const out = path.resolve(outArg)
  if (existsSync(out) && readdirSync(out).length) refuse(`${out} is not empty: each run gets a new directory`)
  for (const v of ['DB_PATH', 'PROD_DB_PATH']) {
    const live = process.env[v]; if (!live) continue
    const dir = path.dirname(path.resolve(live))
    if ((out + path.sep).startsWith(dir + path.sep)) refuse(`--out is inside ${v}'s directory; use a directory of its own`)
  }
  mkdirSync(out, { recursive: true })
  const started = new Date(), t0 = Date.now()
  const results = await scenarios(out, randomBytes(32))
  const transport = lines(path.join(out, 'transport.log'))
  const report = {
    kind: 'dazl staging send-safety scenarios', version: 1, commit: commit(), started_at: started.toISOString(), duration_ms: Date.now() - t0, host_env: 'staging',
    sending: 'off: every send stops at a recorded hand-off to the provider interface (transport.log); nothing is delivered to any inbox; no network (net fence); recipients limited to the allowlist',
    allowlist: [...ALLOWLIST], transport_calls: transport.length, transport_recipients: [...new Set(transport.map(t => t.to))],
    ok: results.every(r => r.ok), scenarios: results,
  }
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(report, null, 2) + '\n')
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.ms} ms)${r.error ? `: ${r.error}` : ''}`)
    for (const c of r.checks) if (!c.ok || process.env.SCENARIO_VERBOSE) console.log(`     ${c.ok ? 'ok  ' : 'FAIL'} ${c.what}${c.detail ? ` [${c.detail}]` : ''}`)
  }
  console.log(`${report.ok ? 'all scenarios passed' : 'SCENARIOS FAILED'}; ${transport.length} recorded send(s), all to allowlisted addresses; evidence: ${path.join(out, 'evidence.json')}`)
  process.exit(report.ok ? 0 : 1)
}
