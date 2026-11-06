// #535: the public Terms and Privacy pages state facts about the software. Each test below holds one of those facts
// (lib/legal/policy.ts) to the code that implements it, so a change in behaviour fails here until the policy text is
// changed too. These tests prove the text matches the code; they are not a legal-compliance claim.
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { API_HOSTS, DRAFT_NOTICE, FACTS, NON_REQUEST_HOSTS, OWNER_PLACEHOLDERS, POLICY_STATUS, PRIVACY, PUBLIC_SOURCES, TERMS } from '../lib/legal/policy.ts'
import { MATRIX } from '../lib/sources/capability-matrix.ts'
import { PLAN_LIMITS } from '../lib/plans.ts'
import { SESSION_RETAIN_S } from '../lib/sessions.ts'
import { OUTBOX_RETAIN_S, OUTBOX_DDL, sendSystemMail, systemMailAvailable } from '../lib/system-mail.ts'
import { reapAccountHistory } from '../lib/account-retention.ts'
import { RETENTION_DAYS as EVIDENCE_COPY_DAYS } from '../lib/scan/evidence-copies.ts'
import { ONBOARDING_AUDIT_RETAIN_YEARS, onboardingAuditCutoff } from '../lib/outreach/onboarding-policy.ts'
import { AUDIT_RETENTION_MIN_DAYS, auditRetention } from '../lib/audit.ts'
import { traceCaptureConfig } from '../lib/evals/capture.ts'
import { ALWAYS_RETAINED, CREDENTIAL_TABLES, deleteTenant, EXPORT_EXCLUDED, REDACTED_COLUMN } from '../lib/tenant/lifecycle.ts'
import { VENDORS } from '../lib/llm/vendors.ts'
import { ENRICH_APOLLO, ENRICH_PDL } from '../lib/enrich/index.ts'
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from '../lib/gmail/oauth.ts'
import { emailGuessEnabled } from '../lib/people/email-pattern.ts'
import { ATTESTATIONS, CONSENT_TEXT, CONSENT_VERSION, enable, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { approve, composeBody, createDraft, isSuppressed, OutreachError, saveSettings, sendMessage, suppress } from '../lib/outreach/service.ts'
import { approveSequence, createSequence, migrateSequences, runSequences } from '../lib/outreach/sequences.ts'
import { runFollowups } from '../lib/outreach/followups.ts'
import { createReopenDraft, migrateReopen, sendReopen, warmAgain } from '../lib/outreach/reopen.ts'
import { acceptReadConsent, migrateReplies } from '../lib/outreach/replies.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { bothEngines } from './helpers/engines.ts'
import { tenantFixture } from './helpers/tenant-fixture.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { buildMime } from '../lib/gmail/mime.ts'
import { outboundRecord, toRecord } from '../lib/ops/errors.ts'
import { NOT_DIRECT } from '../lib/tenant/scope.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const all = (secs: { paragraphs: string[] }[]) => secs.flatMap(s => s.paragraphs).join('\n')
const privacy = all(PRIVACY), terms = all(TERMS)
const DAY = 24 * 60 * 60
const MASTER = randomBytes(32)
const OAUTH_ENV = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000

test('the policies stay labelled DRAFT and keep their open decisions visible until the owner and counsel approve them', () => {
  assert.equal(POLICY_STATUS, 'draft')
  assert.match(DRAFT_NOTICE, /^DRAFT\b/)
  assert.match(DRAFT_NOTICE, /not yet approved by the site owner or reviewed by a lawyer/)
  // every owner fact not in the code is still a placeholder somewhere in the text
  for (const v of Object.values(OWNER_PLACEHOLDERS)) assert.ok(privacy.includes(v) || terms.includes(v), `${v} is not shown`)
  assert.match(terms, /\[NEEDS COUNSEL: warranty disclaimer, limitation of liability/)
  for (const page of ['app/privacy/page.tsx', 'app/terms/page.tsx']) {
    const src = read(page)
    assert.ok(src.includes('{DRAFT_NOTICE}'), `${page} must render the draft notice`)
    assert.ok(src.includes("from '@/lib/legal/policy'"), `${page} must render the checked policy text, not its own copy`)
  }
  assert.ok(read('app/privacy/page.tsx').includes('PRIVACY.map'))
  assert.ok(read('app/terms/page.tsx').includes('TERMS.map'))
})

test('the policies are public and linked from the home footer and sign-up', () => {
  const home = read('app/page.tsx'), signup = read('app/sign-up/page.tsx')
  for (const src of [home, signup]) {
    assert.match(src, /href="\/terms"/)
    assert.match(src, /href="\/privacy"/)
  }
  // the auth proxy only guards /app and /api; robots and the sitemap list both pages
  assert.match(read('proxy.ts'), /matcher: \['\/app\/:path\*', '\/api\/:path\*'\]/)
  assert.match(read('app/robots.ts'), /allow: \['\/', '\/privacy', '\/terms'\]/)
  assert.match(read('app/sitemap.ts'), /'\/privacy', '\/terms'/)
})

test('retention periods match the code constants', () => {
  assert.equal(FACTS.revokedSessionRetainDays * DAY, SESSION_RETAIN_S)
  assert.equal(FACTS.systemMailOutboxRetainHours * 60 * 60, OUTBOX_RETAIN_S)
  assert.equal(FACTS.evidenceCopyRetainDays, EVIDENCE_COPY_DAYS)
  assert.equal(FACTS.consentProofRetainYears, ONBOARDING_AUDIT_RETAIN_YEARS)
  assert.equal(FACTS.auditRetentionMinDays, AUDIT_RETENTION_MIN_DAYS)
  assert.ok(privacy.includes(`kept for ${FACTS.revokedSessionRetainDays} days`))
  assert.ok(privacy.includes(`deleted after ${FACTS.systemMailOutboxRetainHours} hours`))
  assert.ok(privacy.includes(`expires after ${FACTS.evidenceCopyRetainDays} days`))
  assert.ok(privacy.includes(`Once ${FACTS.consentProofRetainYears} years have passed since the deletion completed`), 'the 2-year purge is qualified: batched, on successful cleanup runs, so records can go later')
  // the consent period is calendar years from the completed deletion (Feb 29 rolls forward, never early)
  const now = Date.UTC(2030, 5, 15) / 1000
  assert.equal(onboardingAuditCutoff(now), Date.UTC(2030 - FACTS.consentProofRetainYears, 5, 15) / 1000)
})

test('session and outbox deletion only run under the flag the policy names, and are off by default', async () => {
  const untouchable = new Proxy({}, { get() { throw new Error('reaper touched the store while off') } }) as never
  assert.deepEqual(await reapAccountHistory(untouchable, {}, {}), { sessions: 0, outbox: 0 })
  assert.ok(read('lib/account-retention.ts').includes(`env.${FACTS.accountHistoryFlag}!=='1'`))
  assert.ok(privacy.includes(`${FACTS.accountHistoryFlag}=1`), 'the policy must keep the flag caveat while the reaper is gated')
})

test('no audit record is purged until a period is chosen, as the policy says', () => {
  assert.deepEqual(auditRetention({}), { state: 'off' })
  assert.equal(auditRetention({ [FACTS.auditRetentionFlag]: String(FACTS.auditRetentionMinDays) }).state, 'on')
  assert.equal(auditRetention({ [FACTS.auditRetentionFlag]: String(FACTS.auditRetentionMinDays - 1) }).state, 'invalid')
  assert.match(privacy, /no audit record is deleted automatically today/)
})

test('account email is held on the host while no system provider is configured, and the policy ties its 24-hour deletion to the retention flag', async () => {
  // current production state (#613 review, verified on the live process 2026-11-04): SMTP is not configured, so
  // account emails are kept in system_mail_outbox. ACCOUNT_RETENTION_ENABLED is also unset there, so the 24-hour
  // reap does NOT run today - the text must not say it does.
  assert.equal(systemMailAvailable({}), false)
  const db = new Database(':memory:')
  db.exec(OUTBOX_DDL)
  const r = await sendSystemMail(sqliteDb(db), { userId: 'u1', to: 'a@b.test', subject: 'Reset', text: 'link' }, {})
  assert.equal(r, 'outbox')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM system_mail_outbox').get() as { n: number }).n, 1)
  // the claim and the flag default together: with the flag unset the reaper deletes nothing...
  const untouchable = new Proxy({}, { get() { throw new Error('reaper ran while the flag is unset') } }) as never
  assert.deepEqual(await reapAccountHistory(untouchable, {}, {}), { sessions: 0, outbox: 0 })
  // ...and the policy says deletion applies only once the setting is on, not that it runs today
  assert.match(privacy, /account emails are not sent and are held on the host/)
  assert.match(privacy, /deletion under Retention applies only once ACCOUNT_RETENTION_ENABLED is turned on \(off by default\)/)
})

test('trace capture is off unless its flag is set', () => {
  assert.equal(traceCaptureConfig({}).enabled, false)
  assert.equal(traceCaptureConfig({ [FACTS.traceCaptureFlag]: '1' }).enabled, true)
})

test('what survives account deletion is exactly the always-retained set', () => {
  assert.deepEqual([...FACTS.retainedAfterDeletion].sort(), Object.keys(ALWAYS_RETAINED).sort())
  assert.match(privacy, /the audit trail, the record of evidence purges, and consent records/)
  assert.match(privacy, /Records from before this safeguard are blanked by a scheduled cleanup job when it runs/, 'and the legacy tick backstop, without promising it')
  assert.match(privacy, /no guaranteed moment by which it is gone/, 'and promises no guaranteed timing')
  // "removes credentials and sign-in state first" and "never included in a data export"
  for (const t of ['sessions', 'gmail_accounts', 'tenant_llm_keys', 'tenant_connectors']) assert.ok(CREDENTIAL_TABLES.includes(t), t)
  for (const c of ['password_hash', 'salt', 'ciphertext', 'refresh_ct']) assert.ok(REDACTED_COLUMN.test(c), c)
  assert.ok('sessions' in EXPORT_EXCLUDED)
  assert.match(privacy, /You can download an export of your workspace data in Settings/, 'self-service export exists with no config gate; the export excludes sessions/oauth_states and redacts credentials and conversion kinds, so never claim it is everything')
  assert.match(privacy, /self-service deletion is not switched on in the current service configuration/, 'delete route 503s while DAZL_TOMBSTONE_LEDGER is unset (production today): no working-feature claim from a button alone')
  assert.match(privacy, /The Settings page shows whether deletion is available/, 'the panel surfaces availability (#665); the copy must not claim a delete control that is hidden while unavailable')
  assert.ok(!/the Settings page also has a delete control/.test(privacy), 'no claim of a visible delete control: hidden whenever the ledger is unset')
  assert.match(privacy, /the deletion is not marked complete until the note is blank/, 'completion redaction is synchronous')
  assert.match(privacy, /the earlier erasure is not undone and completion must be retried/, 'failed completion does not undo the erasure; retry is not promised to succeed')
  assert.match(privacy, /stored Gmail tokens; the grant in your Google account is separate/)
  assert.match(read('lib/tenant/lifecycle.ts'), /Gmail tokens/)
})

test('AI, enrichment and CRM providers named in the policy are the ones the code supports', () => {
  assert.deepEqual(Object.keys(FACTS.aiVendors).sort(), [...VENDORS].sort())
  assert.deepEqual(Object.keys(FACTS.enrichmentProviders).sort(), [ENRICH_APOLLO, ENRICH_PDL].sort())
  const crm = /CRM_PROVIDERS[^=]*=\s*\[([^\]]+)\]/.exec(read('lib/crm/index.ts'))
  assert.ok(crm, 'CRM provider allowlist (CRM_PROVIDERS) not found in lib/crm/index.ts')
  assert.deepEqual(crm[1].split(',').map(s => s.trim().replace(/'/g, '')).sort(), Object.keys(FACTS.crmProviders).sort())
  for (const name of [...Object.values(FACTS.aiVendors), ...Object.values(FACTS.enrichmentProviders), 'HubSpot', 'Pipedrive']) {
    assert.ok(privacy.includes(name), `privacy policy does not name ${name}`)
  }
  // the free trial runs on dazl's own Anthropic key
  assert.match(read('lib/scan/trial.ts'), /DAZL_TRIAL_ANTHROPIC_KEY/)
  assert.match(read('lib/scan/trial.ts'), /Absent means the trial is off/)
  assert.match(privacy, /trial scans run on dazl's own Anthropic key/)
  assert.match(privacy, /the free trial when it is enabled/)
})

// Every https://host literal in lib/ and app/ is either a disclosed request target (API_HOSTS) or an explicitly
// listed non-request host (NON_REQUEST_HOSTS) - no URL-shape heuristics: a wrapper (getJson), a URL object or an
// adapter-local helper cannot hide a call, and a new host literal fails here until it is classified one way or the
// other (#613 review round 2).
const collectHosts = (src: string): Set<string> => {
  const out = new Set<string>()
  for (const m of src.matchAll(/https:\/\/([a-zA-Z0-9.-]+\.[a-z]{2,})/g)) {
    const h = m[1].toLowerCase()
    if (!/\.(example|invalid|test)$/.test(h)) out.add(h) // reserved fixture TLDs are not real hosts
  }
  return out
}

test('every third-party host the code names is disclosed or explicitly not a request; no entry is stale', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${f}`
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(ts|tsx|mts)$/.test(f) && rel !== 'lib/legal/policy.ts') files.push(rel)
    }
  }
  walk('lib'); walk('app')
  const found = new Map<string, string>()
  for (const f of files) for (const h of collectHosts(read(f))) if (!found.has(h)) found.set(h, relative(ROOT, join(ROOT, f)))
  const missing = [...found].filter(([h]) => !(h in API_HOSTS) && !(h in NON_REQUEST_HOSTS)).map(([h, f]) => `${h} (${f})`)
  assert.deepEqual(missing, [], 'new host literal: disclose it in API_HOSTS or list it in NON_REQUEST_HOSTS with the reason it is never called')
  assert.deepEqual(Object.keys(API_HOSTS).filter(h => !found.has(h)), [], 'API_HOSTS lists a host the code no longer names')
  assert.deepEqual(Object.keys(NON_REQUEST_HOSTS).filter(h => !found.has(h)), [], 'NON_REQUEST_HOSTS lists a host the code no longer names')
  for (const { name } of Object.values(API_HOSTS)) assert.ok(privacy.includes(name.split(' ')[0]), `privacy policy does not name ${name}`)
})

// Regression for the reviewer's red plant: neither a wrapper helper nor a URL object may escape detection.
test('host detection cannot be escaped by a wrapper or a URL object (red plant)', () => {
  const plant = `
    const getJson = (u: string) => fetch(u).then(r => r.json())
    export const a = () => getJson('https://newvendor.example-corp.io/v1/data')
    export const b = () => fetch(new URL('https://another-host.co/api'))`
  const hosts = collectHosts(plant)
  assert.ok(hosts.has('newvendor.example-corp.io'), 'wrapper-called literal missed')
  assert.ok(hosts.has('another-host.co'), 'URL-object literal missed')
  // ...and both would fail the classification above: neither is disclosed nor allowlisted
  assert.ok(!('newvendor.example-corp.io' in API_HOSTS) && !('newvendor.example-corp.io' in NON_REQUEST_HOSTS))
  assert.ok(!('another-host.co' in API_HOSTS) && !('another-host.co' in NON_REQUEST_HOSTS))
})

// Every source the capability matrix ships has a disclosure entry, and each entry is named in the policy text.
test('every shipped source has a disclosure entry named in the policy', () => {
  const shipped = MATRIX.filter(c => c.status === 'shipped').map(c => c.id).sort()
  assert.deepEqual(shipped, Object.keys(PUBLIC_SOURCES).sort(), 'a shipped source without a disclosure entry, or a stale one')
  for (const [id, name] of Object.entries(PUBLIC_SOURCES)) assert.ok(privacy.includes(name), `privacy policy does not name ${name} (${id})`)
})

test('Gmail: send is the required grant and reading is separate and optional', () => {
  assert.equal(FACTS.gmailSendScope, GMAIL_SEND_SCOPE)
  assert.equal(FACTS.gmailReadScope, GMAIL_READ_SCOPE)
  const scopes = /const SCOPES = \[([^\]]+)\]/.exec(read('lib/gmail/oauth.ts'))
  assert.ok(scopes)
  assert.ok(scopes[1].includes('GMAIL_SEND_SCOPE') && !scopes[1].includes('GMAIL_READ_SCOPE'))
  assert.match(privacy, /send access only \(gmail\.send\)/)
  assert.match(privacy, /optional grant \(gmail\.readonly\)/)
})

test('the Gmail reading description matches the reply sync: what is read, classified, stored and for how long', () => {
  const replies = read('lib/outreach/replies.ts')
  assert.match(replies, /excerpt TEXT NOT NULL CHECK \(length\(excerpt\) <= 200\)/)
  assert.match(replies, /text\.slice\(0, 200\)/)
  assert.match(replies, /classification TEXT NOT NULL, received_at INTEGER NOT NULL/)
  assert.match(replies, /bounded daemon-notice window beyond its own threads/)
  assert.match(read('lib/outreach/read-consent.ts'), /bounded time window/)
  assert.match(privacy, /classifies each reply by rules/)
  assert.match(privacy, /the Gmail message and thread identifiers, a 200-character excerpt, the classification and the received time/)
  assert.match(replies, /gmail_id TEXT NOT NULL, tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL/)
  assert.match(privacy, /delivery-failure notices beyond its own threads/)
  assert.match(privacy, /an unmatched notice leaves only its message and thread identifiers, received time and classification/)
  // the unmatched-notice row stores exactly those fields: gmail_id and thread_id, empty sender and excerpt
  assert.match(replies, /row: \{ gmail_id: hitId, thread_id: g\.threadId \?\? '', lead_id: null, from_email: '', excerpt: '', classification: 'bounce_unmatched'/)
  assert.match(privacy, /not deleted automatically today/)
  assert.match(privacy, /turning reading off stops future reads and follow-ups but does not delete what is already stored/)
  assert.match(privacy, /deleting your account deletes them with your other workspace data/)
  assert.match(privacy, /unless the deletion request asks to keep named tables/)
  assert.match(privacy, /NEEDS OWNER: retention period for stored reply records/)
  assert.match(privacy, /reads nothing without this consent/)
})

test('no categorical sale/share assertion is published: it stays a visible counsel marker', () => {
  assert.doesNotMatch(privacy, /We do not sell personal information\./)
  assert.match(privacy, /\[NEEDS COUNSEL: the sale\/share statement/)
})

test('prospect rows are tenant-scoped; the only global address-based processing is what the policy names', () => {
  assert.deepEqual((NOT_DIRECT.leads as { via: [string, string] }).via, ['scan_job_id', 'scan_jobs'])
  assert.ok('global' in NOT_DIRECT.lifecycle_events && 'global' in NOT_DIRECT.preview_claims)
  const globals = Object.keys(NOT_DIRECT).filter(k => 'global' in NOT_DIRECT[k])
  for (const t of ['leads', 'lead_enrichments', 'inbound_messages', 'outreach_messages', 'sequences', 'followup_threads'])
    assert.ok(!globals.includes(t), `${t} must stay tenant-scoped`)
  assert.match(read('app/api/outreach/sequences/route.ts'), /stop_reason/)
  assert.match(privacy, /tenant scoping/)
  assert.match(privacy, /stops that address's pending automated sequences, follow-ups and held first touches/)
  assert.match(privacy, /generic policy stop: the conversion kind \(signup, activation or payment\) does not appear in their stop reasons, lists or data exports/)
  assert.match(privacy, /bound to the recipient address until claimed/)
})

test('guessed addresses are off by default, never leave the unverified state and are not read by outreach', () => {
  assert.equal(emailGuessEnabled({}), false)
  assert.equal(emailGuessEnabled({ [FACTS.emailGuessFlag]: '1' }), true)
  assert.match(read('lib/people/email-pattern.ts'), /CHECK \(status IN \('unverified'\)\)/)
  const readers: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${f}`
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(f) && read(rel).includes('email_candidates')) readers.push(rel)
    }
  }
  walk('lib/outreach'); walk('app')
  assert.deepEqual(readers, [])
  assert.match(privacy, /never shown to you or emailed/)
})

test('outbound mail carries the sender name, mailing address and an unsubscribe link and header', () => {
  const s = { sender_name: 'Ana Lopez', postal_address: '100 King St W, Toronto ON M5X 1A9' }
  const body = composeBody('Hello there, a short note about your hiring.', s, 'https://dazl.test/api/unsubscribe?t=abc')
  assert.ok(body.includes(s.sender_name) && body.includes(s.postal_address) && body.includes('unsubscribe here: https://dazl.test/api/unsubscribe?t=abc'))
  const mime = buildMime({ fromName: s.sender_name, fromEmail: 'ana@acme.test', to: 'bo@north.test', subject: 'Hi', body, messageId: 'dazl.x@acme.test', unsubscribeUrl: 'https://dazl.test/api/unsubscribe?t=abc', date: new Date(0) })
  assert.match(mime, /^List-Unsubscribe: <https:\/\/dazl\.test\/api\/unsubscribe\?t=abc>$/m)
  assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m)
  // no sender identity, no send; a mailing address is required to save one
  assert.match(read('lib/outreach/service.ts'), /if \(!settings\) release\('sender_identity_missing'\)/)
  assert.throws(() => saveSettings(new Database(':memory:'), 't1', { sender_name: 'Ana', postal_address: '' }), (e: unknown) => e instanceof OutreachError && e.message.includes('bad_postal_address'))
  assert.match(privacy, /ends with the sender's name, a mailing address and an unsubscribe link/)
  assert.match(privacy, /Every outreach message dazl sends to a prospect \(first touch, sequence step, follow-up or re-open\)/)
  assert.match(privacy, /then the rest of your workspace data, except what the deletion request names to keep \(never credentials\) and the records listed below/)
  // the Terms say messages carry no AI label: the send path adds only the footer above
  assert.equal(body.slice('Hello there, a short note about your hiring.'.length).match(/\bAI\b|artificial intelligence/i), null)
  for (const f of ['lib/outreach/service.ts', 'lib/outreach/followups.ts', 'lib/outreach/sequences.ts'])
    assert.match(read(f), /const raw = toBase64Url\(buildMime\(/, `${f} must build the MIME with buildMime`)
  assert.match(terms, /dazl does not add an AI-generated label to prospect messages/)
})

test('the message handed to Gmail carries no AI label and only the expected headers (functional)', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db, ['A']); migrateConnectors(db)
  const state = new URL(startOAuth(db, 'A', { env: OAUTH_ENV, now: NOW })).searchParams.get('state')!
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y'
  await completeOAuth(db, 'A', 'code', state, { env: OAUTH_ENV, master: MASTER, now: NOW, fetchImpl: (async () => new Response(JSON.stringify({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken }))) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat Smith', postal_address: '100 King St W, Toronto ON M5X 1A9' })
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = 'lead-func-1'
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    lead, job, 'Northside Builders', 'info@northside.example', 'Hiring five roofers', 'https://news.example/a', 'Northside Builders is hiring five roofers', 85)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = ?").run(lead)
  const id = createDraft(db, 'A', lead, 'Acme')
  approve(db, 'A', id)
  let raw = ''
  const tokenOk = (async (url: unknown) => (String(url).includes('token') ? new Response(JSON.stringify({ access_token: 'at-1' })) : new Response('{}', { status: 404 }))) as unknown as typeof fetch
  const r = await sendMessage(db, 'A', id, { env: OAUTH_ENV, master: MASTER, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, mime: string) => { raw = mime; return { id: 'gm1' } }) as never })
  assert.equal(r, 'sent')
  assertProspectMime(raw, 'first-touch sendMessage')
})

// The header/body contract every prospect-bound path must meet: no AI label, only the expected headers.
const EXPECTED_HEADERS = ['From', 'To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']
const assertProspectMime = (raw: string, path: string) => {
  const mime = Buffer.from(raw, 'base64url').toString('utf8')
  assert.doesNotMatch(mime, /ai-generated|artificial intelligence|written with ai|generated by ai|x-ai/i, path)
  const headers = mime.slice(0, mime.indexOf('\r\n\r\n')).split('\r\n').map(h => h.split(':')[0])
  for (const h of headers) assert.ok(EXPECTED_HEADERS.includes(h), `${path}: unexpected header ${h}`)
}
// Every gmailSend caller that addresses a prospect is covered by a functional test below: first-touch
// sendMessage (above), sequence steps, follow-ups and re-opens. The calibration launch check addresses the
// tenant's own inbox, never a prospect, and system mail goes by SMTP, not gmailSend.

const tokenFetch = (async (url: unknown) => {
  const u = String(url)
  if (u.includes('token') || u.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at-1' }))
  if (u.includes('/threads/') || u.includes('messages?q=')) return new Response(JSON.stringify({ messages: [] }))
  return new Response('{}', { status: 404 })
}) as unknown as typeof fetch

function mimeDb() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateReplies(db); migrateLedger(db); migrateSequences(db); seedOffers(db, ['A'])
  return db
}
async function mimeConnect(db: Database.Database) {
  const state = new URL(startOAuth(db, 'A', { env: OAUTH_ENV, now: NOW })).searchParams.get('state')!
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y'
  await completeOAuth(db, 'A', 'code', state, { env: OAUTH_ENV, master: MASTER, now: NOW, fetchImpl: (async () => new Response(JSON.stringify({ refresh_token: 'rt', scope: `openid email https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken }))) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat Smith', postal_address: '100 King St W, Toronto ON M5X 1A9' })
}
function mimeLead(db: Database.Database, contact: string) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = 'lead-' + randomBytes(6).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    lead, job, 'Northside Builders', contact, 'Hiring five roofers', 'https://news.example/a', 'Northside Builders is hiring five roofers', 85)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = ?").run(lead)
  return lead
}
const captured = () => {
  const raws: string[] = []
  const sendFn = (async (_t: string, raw: string) => { raws.push(raw); return { id: 'gm' + raws.length, threadId: 'thread-1' } }) as never
  return { raws, sendFn }
}

test('a sequence step handed to Gmail carries no AI label and only the expected headers (functional)', async () => {
  const db = mimeDb()
  await mimeConnect(db)
  acceptReadConsent(db, 'A')
  const lead = mimeLead(db, 'sam@buyer.example')
  const mid = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,test) VALUES (?,?,?,?,'A quick question','This is a draft message for review.',1)").run(mid, 'A', lead, 'sam@buyer.example')
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, (mId: string) => approve(db, 'A', mId, true), NOW)
  const { raws, sendFn } = captured()
  const d = { env: OAUTH_ENV, master: MASTER, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenFetch, flags: { SEQUENCES_ENABLED: '1' }, sendFn }
  await sendMessage(db, 'A', mid, d as never)
  const r = await runSequences(db, 'A', '', { ...d, now: NOW + 3 * 86400 } as never)
  assert.equal(r.sent, 1)
  assert.equal(raws.length, 2, 'first touch plus one sequence step')
  assertProspectMime(raws[1], 'sequence step')
})

test('a follow-up handed to Gmail carries no AI label and only the expected headers (functional)', async () => {
  const db = mimeDb()
  await mimeConnect(db)
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 20 })
  db.prepare('UPDATE autopilot_settings SET followups_enabled = 1 WHERE tenant_id = ?').run('A')
  const lead = mimeLead(db, 'sam@buyer.example')
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,test) VALUES ('m-fu',?,?,?,'A quick question','This is the original first-touch message body.',1)").run('A', lead, 'sam@buyer.example')
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES ('A', 'th-fu', ?, 'sam@buyer.example', 'root', ?, ?, 0)").run(lead, NOW - 30 * 86400, NOW - 30 * 86400)
  db.prepare("INSERT INTO consent_ledger (id, tenant_id, contact, channel, scope, basis, evidence_ref, granted_at, expires_at) VALUES ('c-fu', 'A', 'sam@buyer.example', 'email', 'followup', 'reply_interest', 'gmail:x', ?, ?)").run(NOW - 86400, NOW + 90 * 86400)
  const { raws, sendFn } = captured()
  const r = await runFollowups(db, 'A', 'Acme', { env: OAUTH_ENV, master: MASTER, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenFetch, flags: { AUTOPILOT_ENABLED: '1' }, sendFn } as never)
  assert.equal(r.sent, 1)
  assertProspectMime(raws[0], 'follow-up')
})

test('a re-open handed to Gmail carries no AI label and only the expected headers (functional)', async () => {
  const db = mimeDb()
  await mimeConnect(db)
  migrateReopen(db)
  const lead = mimeLead(db, 'sam@buyer.example')
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,test) VALUES ('m-ro',?,?,?,'A quick question','This is the original first-touch message body.',1)").run('A', lead, 'sam@buyer.example')
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES ('A', 'th-ro', ?, 'sam@buyer.example', 'root', ?, ?, 1)").run(lead, NOW - 45 * 86400, NOW - 45 * 86400)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, from_email, excerpt, classification, received_at) VALUES ('in-ro', 'A', 'th-ro', 'sam@buyer.example', 'Yes, tell me more', 'interested', ?)").run(NOW - 45 * 86400)
  const warm = warmAgain(db, 'A', NOW)
  assert.equal(warm.length, 1, 'the quiet interested thread qualifies')
  createReopenDraft(db, 'A', 'th-ro', 'Acme')
  const { raws, sendFn } = captured()
  await sendReopen(db, 'A', 'th-ro', { env: OAUTH_ENV, master: MASTER, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenFetch, sendFn } as never)
  assert.equal(raws.length, 1)
  assertProspectMime(raws[0], 're-open')
})

test('an unsubscribe stops that sender at once: opt-out list, pending messages and sequences, scoped to the sender', () => {
  const db = new Database(':memory:')
  migrateOutreach(db)
  const ins = db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, ?, ?, ?, 'Hi', 'A note long enough to pass the check.', ?)")
  ins.run('m1', 'tA', 'l1', 'bo@north.test', 'draft'); ins.run('m2', 'tA', 'l2', 'bo@north.test', 'approved'); ins.run('m3', 'tB', 'l3', 'bo@north.test', 'draft')
  suppress(db, 'tA', 'Bo@North.test', 'unsubscribe')
  assert.equal(isSuppressed(db, 'tA', 'bo@north.test'), true)
  assert.equal(isSuppressed(db, 'tB', 'bo@north.test'), false, 'the opt-out list is per sender, as the policy says')
  const st = (id: string) => (db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(id) as { status: string }).status
  assert.deepEqual([st('m1'), st('m2'), st('m3')], ['skipped', 'skipped', 'draft'])
  assert.match(read('lib/outreach/service.ts'), /UPDATE sequences SET status = 'stopped', stop_reason = 'suppressed'/)
  assert.match(read('lib/outreach/autopilot.ts'), /suppress\(db, tenantId, email, 'bounce'\)/)
  // the public link works with no login, for clicks (GET) and one-click clients (POST)
  const route = read('app/api/unsubscribe/route.ts')
  assert.match(route, /export const GET/); assert.match(route, /export const POST/)
  assert.doesNotMatch(route, /getSessionUser|requireUser|auth\(/)
  assert.match(privacy, /An unsubscribe works at once, with no login/)
})

test('autopilot terms match the consent text the user accepts', () => {
  const consent = CONSENT_TEXT.join(' ')
  assert.match(consent, /without asking you first, within the daily limits you set, after the first sends have been approved by you/)
  assert.match(consent, /Pausing stops sends immediately/)
  assert.match(terms, /without asking you each time, within the daily limits you set and only after your first sends were approved by you/)
  assert.match(terms, /pausing stops sends before the next send/)
  assert.match(terms, /\[NEEDS OWNER: the autopilot consent text users accepted still says 'Pausing stops sends immediately'/)
  assert.match(read('lib/outreach/autopilot.ts'), /overpromises: the code re-checks pause before each send/)
})

test('error reports leaving the server carry no message, account id or personal data', () => {
  const r = toRecord(new Error('failed for jane@north.test'), { source: 'route', where: 'x', tenantId: 'a'.repeat(32) })
  const out = JSON.stringify(outboundRecord(r, { environment: 'test' }))
  assert.doesNotMatch(out, /jane|north\.test|a{32}|failed for/)
  assert.match(privacy, /never messages, account identifiers, request bodies or personal data/)
  assert.match(privacy, /server's own error log keeps the fuller scrubbed record/)
  assert.match(read('lib/ops/errors.ts'), /full scrubbed record stays in the server's own log/)
})

test('the free plan allowance matches the plan limits', () => {
  assert.equal(FACTS.freeScansPerMonth, PLAN_LIMITS.free.scansPerMonth)
  assert.ok(terms.includes(`${FACTS.freeScansPerMonth} scans a month`))
})

// The privacy page's qualified claim ("deleting your account deletes them ... unless the deletion request asks to
// keep named tables"), proven against the real deletion path, not a grep: the default erases stored replies;
// naming inbound_messages keeps them; the other tenant is byte-identical.
bothEngines('privacy claim: a completed deletion erases stored replies by default; naming inbound_messages keeps them (real deleteTenant)', async c => {
  const DA = 'legal-del-aaaa', DB2 = 'legal-del-bbbb', DC = 'legal-del-cccc'
  const f = await tenantFixture(c, [[DA, 'xa'], [DB2, 'xb'], [DC, 'xc']])
  const bBefore = await f.snap(DB2)
  assert.notEqual((await f.snap(DA)).inbound_messages, '[]', 'the fixture stores a reply row')
  const t = await deleteTenant(c.db, DA, { policy: { suppressions: 'erase' }, requestedBy: 'legal-policy test', now: NOW })
  assert.equal(t.state, 'completed')
  assert.equal((await f.snap(DA)).inbound_messages, '[]', 'default: stored replies are erased with the workspace')
  const t2 = await deleteTenant(c.db, DC, { policy: { suppressions: 'erase', retainTables: ['inbound_messages'] }, requestedBy: 'legal-policy test', now: NOW })
  assert.equal(t2.state, 'completed')
  assert.notEqual((await f.snap(DC)).inbound_messages, '[]', 'a deletion request that names inbound_messages keeps it')
  for (const ct of CREDENTIAL_TABLES) assert.equal((await f.snap(DC))[ct] ?? '[]', '[]', `credentials are never retained: ${ct}`)
  assert.deepEqual(await f.snap(DB2), bBefore, 'the other tenant is untouched')
})
