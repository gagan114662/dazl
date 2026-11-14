// #1089: two things a deployment needs before strangers can use it, reported by readiness (/api/ready) instead of
// discovered by a customer:
//  - mail: the confirmation and reset links must be able to LEAVE the host. "The settings are present" is not that: prod
//    had both settings and nothing arrived, because the configured SMTP could not send out (port 25 is closed on this
//    class of host). So this check needs the settings, a port that is not 25, and a real connect-and-authenticate
//    against the configured server that succeeded recently.
//  - deletion: self-serve account deletion writes a tombstone to a ledger file outside the database
//    (lib/tenant/ledger.ts); without DAZL_TOMBSTONE_LEDGER the delete route refuses every request.
// Check names, a reason code and the port only: never the SMTP host, user or secret, and no path.
import { accessSync, constants, existsSync } from 'node:fs'
import path from 'node:path'

type Env = Record<string, string | undefined>
export type MailCheck = { ok: true; port: number; verified_s_ago: number } | { ok: false; reason: 'not_configured' | 'malformed' | 'port_25' | 'verify_failed' | 'verify_timeout'; port?: number }
export type DeletionCheck = { ok: true } | { ok: true; skipped: 'staging' } | { ok: false; reason: 'not_configured' | 'not_writable' }

// What can be said about the mail settings without touching the network.
export function mailSettings(env: Env): { ok: true; url: string; port: number } | { ok: false; reason: 'not_configured' | 'malformed' | 'port_25'; port?: number } {
  const url = env.SYSTEM_MAIL_SMTP_URL?.trim(), from = env.SYSTEM_MAIL_FROM?.trim()
  if (!url || !from) return { ok: false, reason: 'not_configured' }
  let u: URL
  try { u = new URL(url) } catch { return { ok: false, reason: 'malformed' } }
  if ((u.protocol !== 'smtp:' && u.protocol !== 'smtps:') || !u.hostname) return { ok: false, reason: 'malformed' }
  // nodemailer's defaults: smtps is 465, smtp is 587 only when said; a bare smtp:// URL means port 25
  const port = u.port ? Number(u.port) : u.protocol === 'smtps:' ? 465 : 25
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

export const MAIL_VERIFY_TTL_S = 300      // a probe every few seconds must not open an SMTP connection each time
export const MAIL_VERIFY_TIMEOUT_MS = 4000
let last: { url: string; at: number; result: MailCheck } | null = null
export const resetMailCheck = () => { last = null }

export async function mailCheck(env: Env, o: { verify?: Verify; now?: () => number; timeoutMs?: number } = {}): Promise<MailCheck> {
  const s = mailSettings(env)
  if (!s.ok) return s
  const now = (o.now ?? (() => Date.now()))(), timeoutMs = o.timeoutMs ?? MAIL_VERIFY_TIMEOUT_MS
  if (last && last.url === s.url && now - last.at < MAIL_VERIFY_TTL_S * 1000) return last.result.ok ? { ...last.result, verified_s_ago: Math.floor((now - last.at) / 1000) } : last.result
  let result: MailCheck
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      (o.verify ?? smtpVerify)(s.url, timeoutMs),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('mail verify timeout')), timeoutMs + 500) }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
    result = { ok: true, port: s.port, verified_s_ago: 0 }
  } catch (e) {
    result = { ok: false, reason: /timeout|ETIMEDOUT/i.test(String((e as Error)?.message ?? e)) ? 'verify_timeout' : 'verify_failed', port: s.port }
  }
  last = { url: s.url, at: now, result }
  return result
}

// Not required on staging, where account deletion is not offered for real accounts.
export function deletionCheck(env: Env): DeletionCheck {
  if (env.DAZL_ENV === 'staging') return { ok: true, skipped: 'staging' }
  const file = env.DAZL_TOMBSTONE_LEDGER?.trim()
  if (!file) return { ok: false, reason: 'not_configured' }
  try { accessSync(existsSync(file) ? file : path.dirname(file), constants.W_OK); return { ok: true } } catch { return { ok: false, reason: 'not_writable' } }
}
