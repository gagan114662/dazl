// The calibration run for a calibrated launch (#405): what the server itself observes, handed to the preflight in
// launch-policy.ts, which records the result. Nothing here sends to a prospect:
//   - sample drafts: the first touches autopilot would write for the policy's audience, saved as ordinary drafts the
//     tenant can read. Each is checked with the same pre-approval gate a hand approval uses (approveBlockReason:
//     identity, date window, contact, evidence) and against the policy's claim authority.
//   - integration check: one plain message from the connected Gmail to the policy's test inbox, which policyProblems
//     only accepts when it is exactly the authenticated sender; never to anyone else. Gmail accepting it is not proof:
//     delivery counts only when the message is then found in that mailbox's INBOX by its Message-ID (Gmail read
//     access). Without read access, or if it is not there, the check fails and the launch holds.
//   - stops: the guards autopilot enforces on every send, as implemented (reply/opt-out/bounce suppression, the
//     uncertain-send pause, the per-company cap).
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getAccessToken, gmailSend, gmailStatus, confirmedSendResult } from '../gmail/oauth.ts'
import { buildMime, toBase64Url } from '../gmail/mime.ts'
import { approveBlockReason, createDraft, getSettings, type Deps } from './service.ts'
import { MIN_CONFIDENCE } from './autopilot.ts'
import { claimIssuesFor, outsidePolicy, readLaunchPolicy, recordPreflight, MIN_SAMPLE_DRAFTS, type PreflightResult, type SampleDraft } from './launch-policy.ts'

// Receipt evidence: the message with this Message-ID is in the mailbox's INBOX. Any error or absence is "not received".
async function receivedInInbox(token: string, messageId: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const headers = { authorization: `Bearer ${token}` }
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
    const list = await fetchImpl(`${base}?maxResults=5&q=${encodeURIComponent(`rfc822msgid:${messageId}`)}`, { headers, signal: AbortSignal.timeout(20_000) })
    if (!list.ok) return false
    const found = ((await list.json()) as { messages?: { id?: unknown }[] }).messages ?? []
    for (const f of found) {
      if (typeof f.id !== 'string' || !/^[\w-]{1,64}$/.test(f.id)) continue
      const m = await fetchImpl(`${base}/${f.id}?format=minimal`, { headers, signal: AbortSignal.timeout(20_000) })
      if (!m.ok) continue
      const labels = ((await m.json()) as { labelIds?: unknown }).labelIds
      if (Array.isArray(labels) && labels.includes('INBOX')) return true
    }
    return false
  } catch { return false }
}

export const AUTOPILOT_STOPS = { reply: true, optOut: true, bounce: true, uncertainPause: true, domainCap: true } as const

// a pre-approval refusal, sorted into the preflight's three sample checks
function sampleOf(db: Database.Database, tenantId: string, leadId: string, id: string, claimIssues: string[]): SampleDraft {
  const m = db.prepare('SELECT to_email, body FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(id, tenantId) as { to_email: string; body: string }
  const code = approveBlockReason(db, tenantId, id, { skipAccount: true }) ?? ''
  const dateBad = /date|currentness|window|stale/.test(code)
  const contactBad = !dateBad && /contact|email|domain|identity|role|recipient|suppress/.test(code)
  return { leadId, to: m.to_email, body: m.body, evidenceOk: !code || dateBad || contactBad, dateOk: !dateBad, contactOk: !contactBad, claimIssues }
}

export async function runCalibration(db: Database.Database, tenantId: string, businessName: string, d: Deps = {}): Promise<PreflightResult> {
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const stored = readLaunchPolicy(db, tenantId)
  if (!stored) return { ok: false, failures: ['policy_not_accepted'], heldLeads: [] }
  const { policy } = stored
  const mailbox = gmailStatus(db, tenantId)
  const connected = mailbox?.status === 'active' ? mailbox.email.toLowerCase() : null

  // samples: the audience's best verified leads with a contact, as autopilot would pick them, skipping excluded recipients
  const candidates = db.prepare(
    `SELECT l.id, l.contact, l.source_url, j.id AS play FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND l.evidence_excerpt IS NOT NULL AND l.confidence >= ? AND l.contact IS NOT NULL AND l.quarantined_at IS NULL
     ORDER BY l.score DESC LIMIT 200`).all(tenantId, MIN_CONFIDENCE) as { id: string; contact: string; source_url: string | null; play: string }[]
  const samples: SampleDraft[] = []
  for (const c of candidates) {
    if (samples.length >= MIN_SAMPLE_DRAFTS) break
    if (outsidePolicy(policy, c.play, c.contact)) continue
    const existing = db.prepare("SELECT id FROM outreach_messages WHERE tenant_id = ? AND lead_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1").get(tenantId, c.id) as { id: string } | undefined
    let id = existing?.id
    if (!id) { try { id = createDraft(db, tenantId, c.id, businessName) } catch { continue } }
    const body = (db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(id) as { body: string }).body
    samples.push(sampleOf(db, tenantId, c.id, id, claimIssuesFor(policy, body, c.source_url ? [c.source_url] : [])))
  }

  // integration check: only when the connected mailbox is the policy's sender, and only to the owned test inbox
  let testInboxDelivered = false
  const settings = getSettings(db, tenantId) as { sender_name?: string } | undefined
  if (connected && connected === policy.sender && settings) {
    const messageId = `dazl.launchcheck.${now}.${randomBytes(6).toString('hex')}@${connected.split('@')[1]}`
    try {
      const token = await getAccessToken(db, tenantId, d)
      const raw = toBase64Url(buildMime({
        fromName: settings.sender_name ?? businessName, fromEmail: connected, to: policy.testInbox,
        subject: 'dazl launch check', body: 'This message checks that autopilot can send from this mailbox. No action needed.',
        messageId, date: new Date(now * 1000),
        // the tenant's own inbox: the link goes to their autopilot settings, where the launch is turned off
        unsubscribeUrl: `${(d.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://dazl.ai').replace(/\/$/, '')}/app/outreach`,
      }))
      confirmedSendResult(await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl))
      testInboxDelivered = mailbox?.read_granted === true && await receivedInInbox(token, messageId, d.fetchImpl ?? fetch)
    } catch { testInboxDelivered = false }
  }

  return recordPreflight(db, tenantId, { connectedMailbox: connected, testInboxDelivered, samples, stopsEnforced: { ...AUTOPILOT_STOPS } }, now)
}
