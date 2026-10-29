// #368: what a reply says, and what dazl does with it (lib/outreach/reply-text.ts, lib/outreach/replies.ts).
// Synthetic messages only; Gmail is a stub (no network, no model). Safe MIME and HTML extraction of the NEW text,
// conservative localized opt-out and "not interested" wording, and uncertain replies blocked for review. Quoted history
// never counts, an opt-out stops the thread and suppresses the address for the future, and nothing ambiguous ever
// grants consent. Two tenants: one tenant's replies never touch the other's suppressions, consent or threads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, isSuppressed } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { grantConsent, hasConsent, migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, classifyReply, migrateReplies, syncReplies } from '../lib/outreach/replies.ts'
import { htmlToText, messageText, newText, type GPart } from '../lib/outreach/reply-text.ts'

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const part = (mimeType: string, body: string, extra: Partial<GPart> = {}): GPart => ({ mimeType, body: { data: b64(body) }, ...extra })
const multi = (mimeType: string, parts: GPart[]): GPart => ({ mimeType, parts })
const classify = (p: GPart, h = {}) => { const t = messageText(p); return classifyReply(t.text, h, t.status) }

test('HTML-only replies: the new text is read; quoted history, scripts and styles never count', () => {
  const unsub = part('text/html', '<html><head><style>.x{}</style></head><body><div dir="ltr">Please <b>unsubscribe</b> me.</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Pat wrote:</div><blockquote>Sounds good, tell me more</blockquote></div></body></html>')
  assert.deepEqual(messageText(unsub), { text: 'Please unsubscribe me.', status: 'ok', source: 'html' })
  assert.equal(classify(unsub), 'opt_out')
  // a quoted earlier "interested" (Outlook, Yahoo, Thunderbird, plain blockquote) is not this reply's answer
  for (const q of ['<div id="divRplyFwdMsg">From: Pat</div><p>I am interested, call me</p>', '<div class="yahoo_quoted">Sounds good</div>', '<div class="moz-cite-prefix">On Mon Pat wrote:</div><blockquote>let\'s talk</blockquote>', '<blockquote type="cite">yes please</blockquote>'])
    assert.equal(classify(part('text/html', `<p>Who is this?</p>${q}`)), 'other', q)
  assert.equal(classify(part('text/html', '<p>Thanks</p><script>document.write("interested")</script><style>p:after{content:"call me"}</style>')), 'other')
  assert.equal(htmlToText('<p>Not&nbsp;interested &amp; please&#32;stop emailing me</p>'), 'Not interested & please stop emailing me')
})

test('nested multipart: plain text inside alternative inside mixed; attachments and forwarded messages are skipped', () => {
  const msg = multi('multipart/mixed', [
    multi('multipart/related', [multi('multipart/alternative', [part('text/plain', 'Please take me off your list.\n\nOn Tue, Pat <me@acme.example> wrote:\n> Interested?'), part('text/html', '<p>Please take me off your list.</p>')])]),
    part('text/plain', 'Yes please, call me', { filename: 'notes.txt' }),
    { mimeType: 'message/rfc822', parts: [part('text/plain', 'Sounds good, let\'s talk')] },
    part('application/pdf', '%PDF', { filename: 'deck.pdf', body: { attachmentId: 'a1' } }),
  ])
  assert.deepEqual(messageText(msg), { text: 'Please take me off your list.', status: 'ok', source: 'plain' })
  assert.equal(classify(msg), 'opt_out')
  // an empty plain part falls back to the HTML one
  assert.equal(classify(multi('multipart/alternative', [part('text/plain', ''), part('text/html', '<p>No thanks</p>')])), 'negative')
  // only attachments: nothing readable is not "harmless", it is for review
  assert.equal(classify(multi('multipart/mixed', [part('text/plain', 'yes please', { filename: 'a.txt' })])), 'uncertain')
  // a charset other than UTF-8
  assert.equal(classify(multi('multipart/alternative', [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"' }], body: { data: b64(Buffer.from('Désinscrivez-moi, merci', 'latin1')) } }])), 'opt_out')
})

test('localized opt-out and negative wording; ambiguous wording and unread scripts are held for review, never positive', () => {
  for (const t of ['Por favor, darme de baja de esta lista', 'No me escriba más, gracias', 'Merci de me désinscrire. Désinscrivez-moi', 'Retirez-moi de votre liste', 'Bitte abmelden. Keine weiteren E-Mails', 'Tragen Sie mich aus', 'Quero descadastrar, não me envie mais', 'Cancellami dalla lista per favore', 'Graag afmelden, geen e-mails meer', 'Please UNSUBSCRIBE'])
    assert.equal(classifyReply(t), 'opt_out', t)
  for (const t of ['No nos interesa, gracias', 'Pas intéressé, merci', 'Kein Interesse.', 'Não tenho interesse', 'Non siamo interessati', 'Geen interesse', 'Not interested, thanks'])
    assert.equal(classifyReply(t), 'negative', t)
  for (const t of ['STOP', 'Stopp', 'Please remove', 'This is spam', 'GDPR request: where did you get my data?', 'How did you get my address?', 'Interested? Stop the sequence for now', 'Не интересно, спасибо', '興味がありません', 'لا شكرا'])
    assert.equal(classifyReply(t), 'uncertain', t)
  // a negation wins over the positive word it contains; positive wording in other languages never grants consent
  assert.equal(classifyReply("I'm not interested"), 'negative')
  assert.equal(classifyReply('Me interesa, llámame'), 'other')
  assert.equal(classifyReply('Sounds good, send me more information'), 'positive')
  // whole words only: "cessation" or "unstoppable" are not opt-outs
  assert.equal(classifyReply('Our cessation program is growing'), 'other')
})

test('quoted earlier positive text never makes a reply positive (plain text, several languages)', () => {
  for (const q of ['On Mon, Oct 5, Pat <me@acme.example> wrote:', 'El lun, 5 oct, Pat escribió:', 'Le lun. 5 oct., Pat a écrit :', 'Am Mo., 5. Okt. schrieb Pat <me@acme.example>:', 'Em seg., 5 de out., Pat escreveu:', 'Il giorno lun 5 ott Pat ha scritto:', 'Op ma 5 okt schreef Pat:', '-----Original Message-----', 'From: Pat <me@acme.example>'])
    assert.equal(classifyReply(newText(`Who is this?\n\n${q}\nYes please, sounds good, let's talk`)), 'other', q)
  assert.equal(classifyReply(newText('Remove me\n> Interested, call me')), 'opt_out')
})

test('auto-replies are no one\'s answer; malformed content is held for review', () => {
  const p = part('text/plain', 'I am out of the office. Interested parties may call me.')
  for (const h of [{ autoSubmitted: 'auto-replied' }, { precedence: 'auto_reply' }, { precedence: 'list' }, { xAutoreply: 'yes' }, { xAutorespond: '1' }, { subject: 'Abwesenheitsnotiz: Pat' }, { subject: 'Réponse automatique : absent' }, { subject: 'Out of the Office' }])
    assert.equal(classify(p, h), 'auto', JSON.stringify(h))
  assert.deepEqual(messageText({ mimeType: 'text/plain', body: { data: '%%%not base64%%%' } }), { text: '', status: 'malformed', source: 'plain' })
  assert.equal(classify({ mimeType: 'text/plain', body: { data: '%%%not base64%%%' } }), 'uncertain')
  assert.equal(classify({ mimeType: 'text/plain', body: { data: b64(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xc3, 0x28, 0xa0, 0xa1])) } }), 'uncertain', 'not UTF-8')
  assert.equal(classify(undefined as never), 'uncertain')
  assert.equal(classify(part('text/plain', '\n\n> quoted only\n')), 'uncertain')
  // deeply nested (hostile) structure: bounded, no crash, held for review
  let deep: GPart = part('text/plain', 'remove me'); for (let i = 0; i < 50; i++) deep = multi('multipart/mixed', [deep])
  assert.equal(classify(deep), 'uncertain')
})

// ---------- sync, two tenants, stub Gmail ----------
const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000, DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
async function tenant(db: Database.Database, t: string, me: string) {
  const state = new URL(startOAuth(db, t, { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, t, 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken(me) })) as unknown as typeof fetch })
  saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, t, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  acceptReadConsent(db, t)
}
function sent(db: Database.Database, t: string, to: string) {
  const job = createJob(db, t, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES (?, ?, 'Northside', ?, 'Hiring', 'https://n.example/a', 'Northside is hiring', 90, 1800000000, 'test_review')").run(lead, job, to)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, t, lead, to, NOW - 4 * DAY, NOW - 4 * DAY, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}
const msg = (id: string, from: string, payload: GPart, headers: { name: string; value: string }[] = []) => ({ id, threadId: 't', internalDate: String((NOW - DAY) * 1000), payload: { ...payload, headers: [{ name: 'From', value: from }, ...headers, ...(payload.headers ?? [])] } })
function gmail(threads: Record<string, unknown[]>, calls: string[]) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    return json({}, 404)
  }) as unknown as typeof fetch
}
const stopped = (db: Database.Database, t: string, thread: string) => (db.prepare('SELECT stopped FROM followup_threads WHERE tenant_id = ? AND thread_id = ?').get(t, thread) as { stopped: string | null } | undefined)?.stopped ?? null
const cls = (db: Database.Database, t: string, id: string) => (db.prepare('SELECT classification FROM inbound_messages WHERE tenant_id = ? AND gmail_id = ?').get(t, id) as { classification: string } | undefined)?.classification

test('sync, two tenants: HTML unsubscribe suppresses and stops only A\'s thread; an unclear reply blocks B\'s thread for review and revokes consent without suppressing; positives grant only in their own tenant', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
  await tenant(db, 'A', 'me@a-seller.example'); await tenant(db, 'B', 'me@b-seller.example')
  // the same person was contacted by both tenants
  const a1 = sent(db, 'A', 'sam@buyer.example'), b1 = sent(db, 'B', 'sam@buyer.example')
  const a2 = sent(db, 'A', 'kim@other.example'), b2 = sent(db, 'B', 'lee@third.example')
  grantConsent(db, 'B', 'sam@buyer.example', { channel: 'email', scope: 'followup', basis: 'reply_interest', evidenceRef: 'gmail:earlier', now: NOW - 2 * DAY })
  const callsA: string[] = [], callsB: string[] = []
  const htmlUnsub = multi('multipart/alternative', [part('text/html', '<div>Bitte abmelden, danke.</div><div class="gmail_quote"><blockquote>Interested, call me</blockquote></div>')])
  const rA = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail({
    [a1.thread]: [msg('a1-r', 'Sam <sam@buyer.example>', htmlUnsub)],
    [a2.thread]: [msg('a2-r', 'Kim <kim@other.example>', part('text/plain', 'Sounds good, tell me more\n\nOn Mon, Pat wrote:\n> Quick question'))],
  }, callsA) })
  const rB = await syncReplies(db, 'B', { env: genv, master, now: NOW, fetchImpl: gmail({
    [b1.thread]: [msg('b1-r', 'Sam <sam@buyer.example>', { mimeType: 'text/plain', body: { data: '%%%broken%%%' } })],
    [b2.thread]: [msg('b2-r', 'Lee <lee@third.example>', part('text/plain', 'Out of office until Monday'), [{ name: 'Auto-Submitted', value: 'auto-replied' }])],
  }, callsB) })
  assert.deepEqual([rA.optOuts, rA.consents, rA.reviews, rA.error], [1, 1, 0, undefined])
  assert.deepEqual([rB.optOuts, rB.consents, rB.reviews, rB.error], [0, 0, 1, undefined])
  // A: the HTML-only unsubscribe (German) stops the thread and suppresses the address for A's future sends
  assert.equal(cls(db, 'A', 'a1-r'), 'opt_out'); assert.equal(stopped(db, 'A', a1.thread), 'opt_out')
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), true)
  // ...but not for B, whose thread with the same person is governed only by B's own reply
  assert.equal(isSuppressed(db, 'B', 'sam@buyer.example'), false)
  // B: the malformed reply blocks the thread for review and revokes B's earlier consent, without suppressing anyone
  assert.equal(cls(db, 'B', 'b1-r'), 'uncertain'); assert.equal(stopped(db, 'B', b1.thread), 'review')
  assert.equal(hasConsent(db, 'B', 'sam@buyer.example', 'email', 'followup', NOW), false)
  // A positive reply (the quoted line does not matter) grants consent in A only; the auto-reply grants and stops nothing
  assert.equal(cls(db, 'A', 'a2-r'), 'positive'); assert.equal(hasConsent(db, 'A', 'kim@other.example', 'email', 'followup', NOW), true)
  assert.equal(hasConsent(db, 'B', 'kim@other.example', 'email', 'followup', NOW), false)
  assert.equal(cls(db, 'B', 'b2-r'), 'auto'); assert.equal(stopped(db, 'B', b2.thread), null)
  // each tenant's sync opened only its own threads, by id, and nothing else (no list, search or other scope)
  const gm = (c: string[]) => c.filter(u => u.includes('gmail.googleapis.com'))
  assert.deepEqual(gm(callsA).map(u => u.replace(/.*threads\//, '').replace(/\?.*/, '')).sort(), [a1.thread, a2.thread].sort())
  assert.deepEqual(gm(callsB).map(u => u.replace(/.*threads\//, '').replace(/\?.*/, '')).sort(), [b1.thread, b2.thread].sort())
  assert.ok(![...callsA, ...callsB].some(u => /messages\?|q=|labels|\/send/.test(u)))
  // stored excerpts are the new text only (the quoted "Interested, call me" is not kept)
  assert.equal((db.prepare("SELECT excerpt FROM inbound_messages WHERE gmail_id = 'a1-r'").get() as { excerpt: string }).excerpt, 'Bitte abmelden, danke.')
  // a later sync does not re-read or re-classify what was stored
  await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail({ [a1.thread]: [msg('a1-r', 'Sam <sam@buyer.example>', part('text/plain', 'Sounds good'))] }, []) })
  assert.equal(cls(db, 'A', 'a1-r'), 'opt_out')
})
