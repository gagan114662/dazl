// #1036 dazl's OWN mailbox check (no paid lookup): a MailboxVerifier (lib/people/email-pattern.ts) that asks the company's own mail
// server whether it would accept mail for one address, and sends nothing.
//
//   MX lookup -> connect to the preferred MX (lowest preference number) -> EHLO -> MAIL FROM -> RCPT TO <random probe> -> RCPT TO <address> -> QUIT.
//   There is NO DATA command: no message is ever sent, so nobody receives anything.
//   Catch-all probe: RCPT TO a random address at the domain first. If the server accepts it, it accepts everything: the answer is
//   'catch_all' and never 'deliverable' (DECISIONS 2026-10-26: a catch-all proves nothing about the mailbox).
//   250/251 on the real address of a non-catch-all domain = 'deliverable'; 550/551/553 = 'undeliverable'; any 4xx (greylisting,
//   try again later) = 'unknown' and a backoff for that MX host; any other 5xx = 'unknown' (a policy block says nothing about the
//   mailbox). A 5xx is never retried.
//
// Politeness and safety (all persisted in smtp_verify_state, an operator ledger with no tenant data, so they hold across processes
// and restarts):
//   - one connection per MX host at a time (a per-host queue in this process);
//   - at most RCPT_PER_HOUR RCPT commands per MX host per UTC hour, counted BEFORE each command (the catch-all probe counts too);
//   - exponential backoff per MX host after a 4xx (15 min doubling to 6 h), and a day after a connection-level 5xx; during a backoff
//     the host is not contacted at all;
//   - MX, catch-all answer and the learned address format are cached per domain for FACT_TTL_S (30 days);
//   - a daily Spamhaus ZEN check of the box's sending IP (SMTP_VERIFY_EGRESS_IP): while it is listed the breaker is open and every
//     check stops with a VerifierError('stop'), so a listed IP is never used to probe more servers;
//   - HELO name and MAIL FROM are configuration (SMTP_VERIFY_HELO required; SMTP_VERIFY_MAIL_FROM default verify@notify.dazl.ai).
// OFF unless SMTP_VERIFY_ENABLED=1 and the configuration is complete (smtpConfigFromEnv). Outbound port 25 must be open on the box.
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { VerifierError } from './zerobounce.ts'
import { guardedLookup, isPublicIp } from '../scan/fetch-page.ts'
import type { MailboxVerifier, VerifyAnswer } from './email-pattern.ts'

export const SMTP_VERIFIER = 'smtp'
export const SMTP_STAGING_FAKE = 'smtp-staging-fake'
export const FACT_TTL_S = 30 * 86_400
// The MX is kept 30 days; the answer "this domain rejects unknown addresses" only 7: a domain that moves behind an accept-all gateway must not
// keep producing 'deliverable' for a month. After 7 days the catch-all probe is asked again (one extra RCPT).
export const NOT_CATCH_ALL_TTL_S = 7 * 86_400
export const RCPT_PER_HOUR = 60
export const ZEN_RECHECK_S = 86_400
const BACKOFF_BASE_S = 900, BACKOFF_MAX_S = 6 * 3600, HARD_BACKOFF_S = 86_400

export const smtpVerifyEnabled = (env: Record<string, string | undefined> = process.env) => env.SMTP_VERIFY_ENABLED === '1'
// A verifier name that is dazl's own SMTP check (the real one or the staging fake): its monthly cap is its own, not a provider's allowance.
export const isSmtpVerifier = (name: string) => name === SMTP_VERIFIER || name === SMTP_STAGING_FAKE
// Checks per UTC month across every tenant. dazl's own infrastructure has no provider allowance, but a check is still a connection to
// someone else's mail server, so it is capped: default 3000, never above 20000; a non-integer is 0 (no check).
export function smtpMonthlyCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SMTP_VERIFY_MONTHLY_CAP
  if (raw === undefined || raw.trim() === '') return 3000
  return /^\d{1,6}$/.test(raw.trim()) ? Math.min(Number(raw.trim()), 20_000) : 0
}

// egressIp is the address the box's mail leaves from AS THE INTERNET SEES IT (on EC2, the public / Elastic IP, not an address on the
// interface): it is only what the Spamhaus check looks up, so the box must have a single outbound address.
export interface SmtpConfig { helo: string; mailFrom: string; egressIp: string; port: number; connectMs: number; commandMs: number }
// Null (the check is not offered) unless SMTP_VERIFY_ENABLED=1 AND a HELO name and a valid IPv4 egress address are set: fail closed.
export function smtpConfigFromEnv(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  if (!smtpVerifyEnabled(env)) return null
  const helo = (env.SMTP_VERIFY_HELO ?? '').trim().toLowerCase(), ip = (env.SMTP_VERIFY_EGRESS_IP ?? '').trim()
  const mailFrom = (env.SMTP_VERIFY_MAIL_FROM ?? 'verify@notify.dazl.ai').trim().toLowerCase()
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(helo)) return null
  if (!/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(ip)) return null
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(mailFrom)) return null
  return { helo, mailFrom, egressIp: ip, port: 25, connectMs: 10_000, commandMs: 15_000 }
}

export function migrateSmtpVerify(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS smtp_verify_state (
    k TEXT PRIMARY KEY CHECK (length(k) <= 300),
    n INTEGER NOT NULL DEFAULT 0,
    hold_until INTEGER NOT NULL DEFAULT 0,
    v TEXT CHECK (v IS NULL OR length(v) <= 500),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  )`)
}

// ---- the wire ----
export interface SmtpReply { code: number; text: string }
export interface SmtpConn { reply(): Promise<SmtpReply>; send(line: string): void; close(): void | Promise<void> }
export interface SmtpEnv {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>
  resolveA(domain: string): Promise<string[]>
  resolveZen(ip: string): Promise<'clean' | 'listed' | 'unavailable'>
  connect(host: string, port: number, timeoutMs: number, replyMs?: number): Promise<SmtpConn>
  now(): number
  random(): string
}

// A real SMTP connection: replies are lines "250 text" or multi-line "250-text ... 250 text"; one reply is complete at the first
// line whose fourth character is a space. Every wait has a timeout; a closed socket rejects pending reads.
// `lookup`: how the host name is resolved. The real path passes guardedLookup (scan/fetch-page.ts), which refuses a host with ANY non-public
// address (loopback, 10/8, 172.16/12, 192.168/16, link-local incl. 169.254.169.254, CGNAT, v6 unique-local) at connect time, so an MX record
// a lead's domain points at an internal address can never make this server connect there. Tests connect to loopback fake servers without it.
export function netConnect(host: string, port: number, timeoutMs: number, lookup?: typeof guardedLookup, replyMs: number = timeoutMs): Promise<SmtpConn> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port, ...(lookup ? { lookup: lookup as net.LookupFunction } : {}) })
    let buf = '', ended: Error | null = null
    const waiting: { res: (r: SmtpReply) => void; rej: (e: Error) => void; t: NodeJS.Timeout }[] = []
    const ready: SmtpReply[] = []
    let partial: string[] = []
    const fail = (e: Error) => { ended = e; for (const w of waiting.splice(0)) { clearTimeout(w.t); w.rej(e) } }
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => {
      buf += d
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2)
        if (partial.length >= 100) { sock.destroy(); fail(new Error('reply too long')); return } // a hostile server streaming "250-x" lines
        partial.push(line)
        if (/^\d{3} ?/.test(line) && line[3] !== '-') {
          const code = Number(line.slice(0, 3)), text = partial.map(l => l.slice(4)).join(' ').slice(0, 300); partial = []
          const w = waiting.shift(); if (w) { clearTimeout(w.t); w.res({ code, text }) } else ready.push({ code, text })
        }
      }
      if (buf.length > 8192) { sock.destroy(); fail(new Error('reply too long')) }
    })
    const connectTimer = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')) }, timeoutMs)
    sock.on('error', e => { clearTimeout(connectTimer); fail(e); reject(e) })
    sock.on('close', () => { clearTimeout(connectTimer); fail(new Error('connection closed')) })
    sock.once('connect', () => {
      clearTimeout(connectTimer)
      resolve({
        reply: () => ready.length ? Promise.resolve(ready.shift()!) : ended ? Promise.reject(ended) : new Promise((res, rej) => { const t = setTimeout(() => { sock.destroy(); rej(new Error('reply timeout')) }, replyMs); waiting.push({ res, rej, t }) }),
        send: line => { sock.write(`${line}\r\n`) },
        // end() flushes the QUIT already written before the FIN; destroy() only if the peer never closes
        // resolves when the socket is really closed (or after 1 s): the per-host queue waits for it, so "one connection at a time" is true on the wire
        close: () => new Promise<void>(res => { const t = setTimeout(() => { sock.destroy(); res() }, 1000); sock.once('close', () => { clearTimeout(t); res() }); sock.end() }),
      })
    })
  })
}

const reverseIp = (ip: string) => ip.split('.').reverse().join('.')
export const realEnv: SmtpEnv = {
  resolveMx: async d => (await import('node:dns/promises')).resolveMx(d),
  resolveA: async d => (await import('node:dns/promises')).resolve4(d),
  // Spamhaus answers 127.0.0.x for a listing; 127.255.255.x means the query was refused (an open or blocked resolver): no answer.
  resolveZen: async ip => {
    try {
      const a = await (await import('node:dns/promises')).resolve4(`${reverseIp(ip)}.zen.spamhaus.org`)
      if (a.some(x => x.startsWith('127.255.255.'))) return 'unavailable'
      return a.some(x => x.startsWith('127.0.0.')) ? 'listed' : 'unavailable'
    } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOTFOUND' || (e as NodeJS.ErrnoException).code === 'ENODATA' ? 'clean' : 'unavailable' }
  },
  // An IP-literal host skips the lookup entirely in net.connect, so a literal is checked here (an MX answer such as "169.254.169.254").
  connect: (h, p, t, r) => net.isIP(h) && !isPublicIp(h) ? Promise.reject(new Error('blocked_address')) : netConnect(h, p, t, guardedLookup, r),
  now: () => Math.floor(Date.now() / 1000),
  random: () => randomBytes(6).toString('hex'),
}

// ---- persisted state (operator ledger, no tenant data) ----
interface DomainFact { mx: string; catchAll: boolean | null; at: number }
const row = (db: Database.Database, k: string) => db.prepare('SELECT n, hold_until, v, updated_at FROM smtp_verify_state WHERE k = ?').get(k) as { n: number; hold_until: number; v: string | null; updated_at: number } | undefined
const put = (db: Database.Database, k: string, f: { n?: number; hold_until?: number; v?: string | null }, now: number) =>
  db.prepare(`INSERT INTO smtp_verify_state (k, n, hold_until, v, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (k) DO UPDATE SET n = excluded.n, hold_until = excluded.hold_until, v = excluded.v, updated_at = excluded.updated_at`).run(k, f.n ?? 0, f.hold_until ?? 0, f.v ?? null, now)

export function getDomainFact(db: Database.Database, domain: string, now: number): DomainFact | null {
  const r = row(db, `dom:${domain}`)
  if (!r || r.updated_at < now - FACT_TTL_S || !r.v) return null
  try { const f = JSON.parse(r.v) as DomainFact; return typeof f.mx === 'string' ? { mx: f.mx, catchAll: f.catchAll === true ? true : f.catchAll === false && r.updated_at >= now - NOT_CATCH_ALL_TTL_S ? false : null, at: r.updated_at } : null } catch { return null }
}
export const setDomainFact = (db: Database.Database, domain: string, f: { mx: string; catchAll: boolean | null }, now: number) => put(db, `dom:${domain}`, { v: JSON.stringify({ mx: f.mx, catchAll: f.catchAll }) }, now)

// The RCPT budget of one MX host for this UTC hour: counted before the command, in one transaction.
export function reserveRcpt(db: Database.Database, mx: string, now: number): boolean {
  const k = `rcpt:${mx}:${Math.floor(now / 3600)}`
  return db.transaction(() => {
    const used = row(db, k)?.n ?? 0
    if (used >= RCPT_PER_HOUR) return false
    put(db, k, { n: used + 1 }, now)
    if (used === 0) db.prepare('DELETE FROM smtp_verify_state WHERE k LIKE ? AND updated_at < ?').run('rcpt:%', now - 86_400) // old hours go
    return true
  })()
}
export function backoffUntil(db: Database.Database, mx: string, now: number): number { const r = row(db, `bo:${mx}`); return r && r.hold_until > now ? r.hold_until : 0 }
export function noteBackoff(db: Database.Database, mx: string, now: number, hard = false): number {
  const fails = (row(db, `bo:${mx}`)?.n ?? 0) + 1
  const until = now + (hard ? HARD_BACKOFF_S : Math.min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** (fails - 1)))
  put(db, `bo:${mx}`, { n: fails, hold_until: until }, now)
  return until
}
export const clearBackoff = (db: Database.Database, mx: string, now: number) => { if (row(db, `bo:${mx}`)) put(db, `bo:${mx}`, { n: 0, hold_until: 0 }, now) }

// Outbound port 25 is closed by default on many clouds (EC2 drops it until a removal request is granted). A connection that never gets
// as far as a greeting counts; PORT25_FAILS in a row across hosts (any success resets) mean the port is shut from here, and for the
// next hour every check answers 'unknown' at once, without waiting out a connect timeout per host. Never 'valid'.
export const PORT25_FAILS = 3, PORT25_HOLD_S = 3600
export const port25Blocked = (db: Database.Database, now: number): boolean => { const r = row(db, 'p25'); return !!r && r.n >= PORT25_FAILS && r.updated_at > now - PORT25_HOLD_S }
// Only failures that look like a filtered port count: a timeout, or no route. A refused connection proves the port is reachable, and a
// name that does not resolve is the domain's problem, so neither may switch the verifier off for every tenant.
export const looksLikeShutPort = (e: unknown): boolean => /timeout/i.test(e instanceof Error ? e.message : '') || ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes((e as NodeJS.ErrnoException | undefined)?.code ?? '')
const notePort25Fail = (db: Database.Database, now: number) => { const r = row(db, 'p25'); put(db, 'p25', { n: r && r.updated_at > now - PORT25_HOLD_S ? r.n + 1 : 1 }, now) }
const clearPort25 = (db: Database.Database, now: number) => { if (row(db, 'p25')?.n) put(db, 'p25', { n: 0 }, now) }

// The daily blocklist check of the sending IP. 'listed' opens the breaker; 'unavailable' (the resolver refused) does not.
export async function zenStatus(db: Database.Database, cfg: SmtpConfig, env: SmtpEnv): Promise<'clean' | 'listed' | 'unavailable'> {
  const now = env.now(), k = `zen:${cfg.egressIp}`, r = row(db, k)
  if (r?.v && r.updated_at > now - ZEN_RECHECK_S && (r.v === 'clean' || r.v === 'listed' || r.v === 'unavailable')) return r.v
  const s = await env.resolveZen(cfg.egressIp)
  put(db, k, { v: s }, now)
  return s
}

// ---- the verifier ----
const queues = new Map<string, Promise<unknown>>()
// One connection per MX host at a time in this process: calls for the same host run one after another.
function oneAtATime<T>(host: string, f: () => Promise<T>): Promise<T> {
  const prev = queues.get(host) ?? Promise.resolve()
  const next = prev.then(f, f)
  const tail: Promise<void> = next.then(() => undefined, () => undefined).then(() => { if (queues.get(host) === tail) queues.delete(host) })
  queues.set(host, tail)
  return next
}

const unknown = (detail: string): VerifyAnswer => ({ outcome: 'unknown', detail: detail.slice(0, 160) })
// An answer reached with no request leaving this server (VerifyAnswer.noCall): the caller gives its allowance back.
const offline = (a: VerifyAnswer): VerifyAnswer => ({ ...a, noCall: true })
// Recipient-unknown replies (RFC 5321 / 3463: 550 mailbox unavailable, 551 user not local, 553 mailbox name not allowed).
const NO_SUCH_USER_CODES = new Set([550, 551, 553])
// A recipient-unknown answer only: with an enhanced status code it must be 5.1.x (bad destination mailbox). A 550 5.7.1 (blocked sender,
// bad rDNS, a blocklisting of our IP) is a refusal of US, says nothing about the mailbox, and is never cached as a catch-all answer.
const noSuchUser = (r: SmtpReply): boolean => NO_SUCH_USER_CODES.has(r.code) && !/\b5\.[02-9]\.\d{1,3}\b/.test(r.text)

export function smtpMailboxVerifier(db: Database.Database, cfg: SmtpConfig, env: SmtpEnv = realEnv, name: string = SMTP_VERIFIER): MailboxVerifier {
  migrateSmtpVerify(db)
  return {
    name,
    // Why no check can run right now, from the ledger alone (no network): port 25 shut, or the sending address already known as listed.
    blockedNow(): string | null {
      const now = env.now()
      if (port25Blocked(db, now)) return 'outbound mail port 25 appears to be shut from this server, so no mailbox can be checked'
      const z = row(db, `zen:${cfg.egressIp}`)
      if (z?.v === 'listed' && z.updated_at > now - ZEN_RECHECK_S) return 'the sending address is listed by Spamhaus ZEN; mailbox checks are stopped'
      return null
    },
    async verify(address: string, signal?: AbortSignal): Promise<VerifyAnswer> {
      const m = /^([a-z0-9._%+-]{1,64})@([a-z0-9.-]{1,253}\.[a-z]{2,})$/i.exec(address.trim())
      if (!m) return offline(unknown('not an address'))
      const domain = m[2].toLowerCase()
      address = `${m[1]}@${m[2]}` // the validated form only: nothing the caller sent past the match (a CRLF) reaches the wire
      if (signal?.aborted) return offline(unknown('aborted'))
      // the breaker: a listed sending IP probes nobody
      if (await zenStatus(db, cfg, env) === 'listed') throw Object.assign(new VerifierError('stop', 'the sending address is listed by Spamhaus ZEN; mailbox checks are stopped'), { noCall: true })
      const now = env.now()
      let fact = getDomainFact(db, domain, now)
      // a domain whose server accepts everything is answered from the cache: no connection at all
      if (fact?.catchAll === true) return offline({ outcome: 'catch_all', detail: 'the mail server accepts every address (cached)' })
      let mx = fact?.mx ?? null
      if (!mx) {
        try {
          const list = (await env.resolveMx(domain)).slice().sort((a, b) => a.priority - b.priority)
          mx = list[0]?.exchange?.toLowerCase().replace(/\.$/, '') ?? null
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code === 'ENOTFOUND') return offline({ outcome: 'undeliverable', detail: 'the domain does not exist' })
          if (code === 'ENODATA') {
            // no MX record: the domain's own address is the implicit MX (RFC 5321 5.1)
            try { if ((await env.resolveA(domain)).length) mx = domain } catch { /* below */ }
            if (!mx) return offline({ outcome: 'undeliverable', detail: 'the domain has no mail server' })
          } else return offline(unknown('the mail server could not be looked up'))
        }
        if (!mx) return offline({ outcome: 'undeliverable', detail: 'the domain has no mail server' })
        setDomainFact(db, domain, { mx, catchAll: fact?.catchAll ?? null }, now)
        fact = { mx, catchAll: fact?.catchAll ?? null, at: now }
      }
      const host = mx
      return oneAtATime(host, async (): Promise<VerifyAnswer> => {
        if (signal?.aborted) return offline(unknown('aborted')) // the caller's budget ran out while this call waited its turn
        const t0 = env.now()
        if (port25Blocked(db, t0)) return offline(unknown('outbound mail port 25 appears to be shut from this server, so no mailbox can be checked'))
        const until = backoffUntil(db, host, t0)
        if (until) return offline(unknown(`the mail server asked us to wait; trying again after ${new Date(until * 1000).toISOString().slice(11, 16)} UTC`))
        let conn: SmtpConn | null = null, abortHandler: (() => void) | null = null
        const bail = (e: unknown): VerifyAnswer => { noteBackoff(db, host, env.now()); return unknown(e instanceof Error ? e.message : 'connection failed') }
        try {
          try { conn = await env.connect(host, cfg.port, cfg.connectMs, cfg.commandMs) }
          catch (e) {
            // an MX that points at a non-public address is the domain's doing, not a sign that port 25 is shut: a day's backoff, no stats
            if (e instanceof Error && e.message === 'blocked_address') { noteBackoff(db, host, env.now(), true); return unknown('the mail server address is not a public one') }
            if (looksLikeShutPort(e)) notePort25Fail(db, env.now())
            throw e
          }
          clearPort25(db, env.now())
          abortHandler = () => { try { void conn?.close() } catch { /* closed */ } }
          signal?.addEventListener('abort', abortHandler, { once: true })
          const cmd = async (line: string): Promise<SmtpReply> => { conn!.send(line); return conn!.reply() }
          const greet = await conn.reply()
          if (greet.code >= 500) { noteBackoff(db, host, env.now(), true); return unknown(`the mail server refused the connection (${greet.code})`) }
          if (greet.code !== 220) { noteBackoff(db, host, env.now()); return unknown(`the mail server is busy (${greet.code})`) }
          const ehlo = await cmd(`EHLO ${cfg.helo}`)
          if (ehlo.code !== 250) { noteBackoff(db, host, env.now(), ehlo.code >= 500); return unknown(`the mail server refused EHLO (${ehlo.code})`) }
          const from = await cmd(`MAIL FROM:<${cfg.mailFrom}>`)
          if (from.code !== 250) { noteBackoff(db, host, env.now(), from.code >= 500); return unknown(`the mail server refused the sender (${from.code})`) }
          const rcpt = async (to: string): Promise<SmtpReply | null> => reserveRcpt(db, host, env.now()) ? cmd(`RCPT TO:<${to}>`) : null
          // 1. the catch-all probe, once per domain per 30 days
          if (fact!.catchAll === null) {
            const probe = await rcpt(`dazl-check-${env.random()}@${domain}`)
            if (!probe) return unknown('the hourly limit for this mail server is used')
            if (probe.code === 250 || probe.code === 251) { setDomainFact(db, domain, { mx: host, catchAll: true }, env.now()); return { outcome: 'catch_all', detail: 'the mail server accepts every address' } }
            // A second RCPT in the SAME transaction (no RSET: RSET also clears MAIL FROM, and real servers - Google among them - then
            // answer 503 bad sequence). A rejected recipient does not end the transaction.
            if (noSuchUser(probe)) setDomainFact(db, domain, { mx: host, catchAll: false }, env.now())
            else { if (probe.code >= 400 && probe.code < 500) noteBackoff(db, host, env.now()); return unknown(`the mail server did not answer the test address (${probe.code})`) }
          }
          // 2. the address itself
          const a = await rcpt(address)
          if (!a) return unknown('the hourly limit for this mail server is used')
          if (a.code === 250 || a.code === 251) { clearBackoff(db, host, env.now()); return { outcome: 'deliverable', detail: `accepted by ${host}` } }
          if (noSuchUser(a)) { clearBackoff(db, host, env.now()); return { outcome: 'undeliverable', detail: `no such mailbox at ${host} (${a.code})` } }
          if (a.code >= 400 && a.code < 500) { noteBackoff(db, host, env.now()); return unknown(`the mail server asked us to try later (${a.code})`) }
          return unknown(`the mail server declined to say (${a.code})`) // other 5xx: a policy answer, not proof about the mailbox; never retried
        } catch (e) { return bail(e) }
        finally { if (abortHandler) signal?.removeEventListener('abort', abortHandler); try { conn?.send('QUIT') } catch { /* closing */ } ; try { await conn?.close() } catch { /* closed */ } }
      })
    },
  }
}
