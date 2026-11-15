// #1089: two things a deployment needs before strangers can use it, stated by readiness (/api/ready):
//  - mail: the confirmation and reset links must be able to leave the host. Having the two settings is not enough to know
//    that, so this check also needs a port that is not 25 (commonly closed for outbound mail on cloud hosts) and a recent
//    successful session with the configured server: a real connect, and a login when the URL carries credentials (a server
//    that rejects the login fails; a URL with no credentials is only a connect). It shows the server is reachable and
//    accepts us, not that a message is delivered.
//  - deletion: self-serve account deletion writes a tombstone to a ledger file outside the database
//    (lib/tenant/ledger.ts); without DAZL_TOMBSTONE_LEDGER the delete route refuses every request.
// Check names, a reason code and the port only: never the SMTP host, user or secret, and no path.
//
// REPORTED, NOT GATING, unless DAZL_READY_REQUIRES_LAUNCH=1: /api/ready's `ok` is what the launch scripts
// (ops/safe_launch.py, fresh_listener.py), the release gate's smokes and the recovery drill wait on, and none of them
// has mail or a ledger. So by default the two checks appear under `checks` and in `launch.ok`, and `ok` is unchanged;
// an operator sets the switch on a deployment once its relay and ledger exist, and from then on a broken relay or a
// missing ledger makes that deployment not ready.
export const launchRequired = (env: Env): boolean => env.DAZL_READY_REQUIRES_LAUNCH === '1'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import path from 'node:path'

type Env = Record<string, string | undefined>
export type MailCheck = { ok: true; port: number; verified_s_ago: number } | { ok: false; reason: 'not_configured' | 'malformed' | 'port_25' | 'verify_pending' | 'verify_failed' | 'verify_timeout'; port?: number }
export type DeletionCheck = { ok: true } | { ok: true; skipped: 'staging' } | { ok: false; reason: 'not_configured' | 'not_writable' }

// What can be said about the mail settings without touching the network.
export function mailSettings(env: Env): { ok: true; url: string; port: number } | { ok: false; reason: 'not_configured' | 'malformed' | 'port_25'; port?: number } {
  const url = env.SYSTEM_MAIL_SMTP_URL?.trim(), from = env.SYSTEM_MAIL_FROM?.trim()
  if (!url || !from) return { ok: false, reason: 'not_configured' }
  let u: URL
  try { u = new URL(url) } catch { return { ok: false, reason: 'malformed' } }
  if ((u.protocol !== 'smtp:' && u.protocol !== 'smtps:') || !u.hostname) return { ok: false, reason: 'malformed' }
  // the port nodemailer itself uses for this URL (smtp-connection: the given port, else 465 when secure, else 587)
  const port = u.port ? Number(u.port) : u.protocol === 'smtps:' || u.searchParams.get('secure') === 'true' ? 465 : 587
  if (port === 25) return { ok: false, reason: 'port_25', port }
  return { ok: true, url, port }
}

export type Verify = (url: string, timeoutMs: number) => Promise<void>
// Connects and authenticates; sends nothing.
export const smtpVerify: Verify = async (url, timeoutMs) => {
  const nodemailer = await import('nodemailer')
  // The same URL the sender uses (lib/system-mail.ts), with short timeouts added the way nodemailer reads options from a
  // connection URL (its query string): the defaults wait 30 s for a greeting and 2 minutes to connect.
  const u = new URL(url)
  for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) u.searchParams.set(k, String(timeoutMs))
  const tx = nodemailer.createTransport(u.toString())
  try { await tx.verify() } finally { tx.close() }
}

export const MAIL_VERIFY_TTL_S = 300      // a success is trusted this long: a probe every few seconds must not open an SMTP session each time
export const MAIL_VERIFY_FAIL_TTL_S = 30  // a failure is retried sooner, so a fixed relay shows as ready within half a minute
export const MAIL_VERIFY_TIMEOUT_MS = 4000
let last: { url: string; at: number; result: MailCheck } | null = null
let pending: { url: string; done: Promise<void> } | null = null
export const resetMailCheck = () => { last = null; pending = null }

// Never waits for the network: it answers from the last result and, when that is missing or old, starts ONE verify in the
// background (concurrent probes share it), answering verify_pending until the first result is in. So a probe is always
// fast, and no number of probes can open more than one SMTP session at a time.
export function mailCheck(env: Env, o: { verify?: Verify; now?: () => number; timeoutMs?: number } = {}): MailCheck {
  const s = mailSettings(env)
  if (!s.ok) return s
  const clock = o.now ?? (() => Date.now()), now = clock(), timeoutMs = o.timeoutMs ?? MAIL_VERIFY_TIMEOUT_MS
  const known = last && last.url === s.url ? last : null
  const fresh = known && now - known.at < (known.result.ok ? MAIL_VERIFY_TTL_S : MAIL_VERIFY_FAIL_TTL_S) * 1000
  if (!fresh && !(pending && pending.url === s.url)) {
    const run = async () => {
      let result: MailCheck
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (o.verify ?? smtpVerify)(s.url, timeoutMs),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('mail verify timeout')), timeoutMs + 500) }),
        ])
        result = { ok: true, port: s.port, verified_s_ago: 0 }
      } catch (e) {
        result = { ok: false, reason: /timeout|ETIMEDOUT/i.test(String((e as Error)?.message ?? e)) ? 'verify_timeout' : 'verify_failed', port: s.port }
      } finally { if (timer) clearTimeout(timer) }
      last = { url: s.url, at: clock(), result }
    }
    const mine = { url: s.url, done: run().finally(() => { if (pending === mine) pending = null }) }
    pending = mine
  }
  if (!known) return { ok: false, reason: 'verify_pending', port: s.port }
  // an old result stands until the background verify replaces it
  return known.result.ok ? { ...known.result, verified_s_ago: Math.floor((now - known.at) / 1000) } : known.result
}
// For tests and callers that want the result of the verify in flight.
export const mailCheckSettled = async (): Promise<void> => { await pending?.done }

// Staging is not held to it (its accounts are test accounts and it has no ledger); every other deployment is.
export function deletionCheck(env: Env): DeletionCheck {
  if (env.DAZL_ENV === 'staging') return { ok: true, skipped: 'staging' }
  const file = env.DAZL_TOMBSTONE_LEDGER?.trim()
  if (!file) return { ok: false, reason: 'not_configured' }
  // what the delete route needs (lib/tenant/ledger.ts reads the ledger, then appends): an existing regular file it can read
  // and write, or a directory it can create the file in
  try {
    if (existsSync(file)) { if (!statSync(file).isFile()) return { ok: false, reason: 'not_writable' }; accessSync(file, constants.R_OK | constants.W_OK) }
    else accessSync(path.dirname(file), constants.W_OK)
    return { ok: true }
  } catch { return { ok: false, reason: 'not_writable' } }
}
