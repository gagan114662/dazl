// #1036 dazl's own mailbox check (lib/people/smtp-verify.ts) against a FAKE SMTP SERVER on loopback: the real wire code, real
// sockets, scripted answers. Nothing leaves the machine; no DATA command is ever sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { VerifierError } from '../lib/people/zerobounce.ts'
import { verifierFromEnv, verifierMonthlyCap } from '../lib/people/email-pattern.ts'
import { backoffUntil, FACT_TTL_S, getDomainFact, RCPT_PER_HOUR, realEnv, smtpConfigFromEnv, smtpMailboxVerifier, smtpMonthlyCap, SMTP_STAGING_FAKE, ZEN_RECHECK_S, type SmtpConfig, type SmtpEnv } from '../lib/people/smtp-verify.ts'

type Rule = (rcpt: string, domain: string) => string | null
interface Fake { port: number; log: string[]; conns: () => number; maxConcurrent: () => number; close: () => Promise<void> }
// answer(rcpt) -> reply line "250 ok" / "550 no such user" / "450 try later"; greeting overrides the 220 banner.
async function fakeSmtp(answer: (to: string) => string, greeting = '220 mx.fake.test ESMTP'): Promise<Fake> {
  const log: string[] = []; let conns = 0, open = 0, maxOpen = 0
  const srv = net.createServer(sock => {
    conns++; open++; maxOpen = Math.max(maxOpen, open)
    sock.on('close', () => { open-- }); sock.on('error', () => {})
    sock.write(`${greeting}\r\n`)
    let buf = ''
    sock.on('data', d => {
      buf += String(d)
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); log.push(line)
        const u = line.toUpperCase()
        if (u.startsWith('EHLO')) sock.write('250-mx.fake.test\r\n250 PIPELINING\r\n')
        else if (u.startsWith('MAIL FROM')) sock.write('250 ok\r\n')
        else if (u.startsWith('RCPT TO')) sock.write(`${answer(/<([^>]*)>/.exec(line)?.[1]?.toLowerCase() ?? '')}\r\n`)
        else if (u.startsWith('RSET')) sock.write('250 ok\r\n')
        else if (u.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end() }
        else sock.write('502 not implemented\r\n')
      }
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  return { port: (srv.address() as net.AddressInfo).port, log, conns: () => conns, maxConcurrent: () => maxOpen, close: () => new Promise(r => srv.close(() => r())) }
}
const rcpts = (f: Fake) => f.log.filter(l => /^RCPT TO/i.test(l))
let clock = 1_800_000_000
const cfgFor = (port: number): SmtpConfig => ({ helo: 'verify.notify.dazl.ai', mailFrom: 'verify@notify.dazl.ai', egressIp: '203.0.113.7', port, connectMs: 3000, commandMs: 3000 })
const envFor = (over: Partial<SmtpEnv> = {}): SmtpEnv => ({ ...realEnv, resolveMx: async () => [{ exchange: '127.0.0.1', priority: 10 }], resolveZen: async () => 'clean', now: () => clock, random: () => 'abc123', ...over })
const setup = async (answer: (to: string) => string, over: Partial<SmtpEnv> = {}, greeting?: string) => {
  const db = new Database(':memory:'); migrateAllSqlite(db); const fake = await fakeSmtp(answer, greeting)
  return { db, fake, v: smtpMailboxVerifier(db, cfgFor(fake.port), envFor(over)) }
}
const normal = (to: string) => to.startsWith('dazl-check-') || to.includes('nouser') ? '550 5.1.1 no such user' : '250 ok'

test('#1036 smtp: 250 for the address and 550 for the random probe = deliverable; the dialog is EHLO, MAIL FROM, RCPT probe, RSET, RCPT address, QUIT - never DATA', async () => {
  const { fake, v } = await setup(normal)
  try {
    const a = await v.verify('dana.lee@acme.test')
    assert.equal(a.outcome, 'deliverable')
    await new Promise(r => setTimeout(r, 100)) // the QUIT is written as the check returns; let it arrive
    assert.deepEqual(fake.log, ['EHLO verify.notify.dazl.ai', 'MAIL FROM:<verify@notify.dazl.ai>', 'RCPT TO:<dazl-check-abc123@acme.test>', 'RSET', 'RCPT TO:<dana.lee@acme.test>', 'QUIT'])
    assert.ok(!fake.log.some(l => /^DATA/i.test(l)), 'nothing is ever sent')
  } finally { await fake.close() }
})

test('#1036 smtp: 550 on the address = undeliverable; the probe answer is cached 30 days so the next check skips it', async () => {
  const { db, fake, v } = await setup(normal)
  try {
    assert.equal((await v.verify('nouser.here@acme.test')).outcome, 'undeliverable')
    assert.equal(getDomainFact(db, 'acme.test', clock)?.catchAll, false)
    const before = rcpts(fake).length
    assert.equal((await v.verify('dana.lee@acme.test')).outcome, 'deliverable')
    assert.equal(rcpts(fake).length - before, 1, 'no second catch-all probe within the cache window')
    assert.equal(getDomainFact(db, 'acme.test', clock + FACT_TTL_S + 5), null, 'after 30 days the fact is stale and re-learned')
  } finally { await fake.close() }
})

test('#1036 smtp: a catch-all server is catch_all, never deliverable, and the next address at that domain opens no connection', async () => {
  const { db, fake, v } = await setup(() => '250 ok')
  try {
    const a = await v.verify('anyone@catchall.test')
    assert.equal(a.outcome, 'catch_all'); assert.equal(getDomainFact(db, 'catchall.test', clock)?.catchAll, true)
    assert.equal(rcpts(fake).length, 1, 'only the probe was asked; the address itself never was')
    const c = fake.conns()
    assert.equal((await v.verify('someone.else@catchall.test')).outcome, 'catch_all')
    assert.equal(fake.conns(), c, 'answered from the cache with no connection')
  } finally { await fake.close() }
})

test('#1036 smtp: 450 (greylisting) = unknown and a backoff for that host; during it nothing is contacted; after it, the host is tried again; success resets it', async () => {
  let greylist = true
  const { db, fake, v } = await setup(to => (to.includes('grey') && greylist ? '450 4.2.0 greylisted, try later' : normal(to)))
  try {
    const a = await v.verify('grey.user@acme.test')
    assert.equal(a.outcome, 'unknown'); const until = backoffUntil(db, '127.0.0.1', clock); assert.equal(until, clock + 900)
    const c = fake.conns()
    assert.equal((await v.verify('dana.lee@acme.test')).outcome, 'unknown', 'inside the backoff')
    assert.equal(fake.conns(), c, 'no connection while backing off')
    clock += 901; greylist = false
    assert.equal((await v.verify('grey.user@acme.test')).outcome, 'deliverable')
    assert.equal(backoffUntil(db, '127.0.0.1', clock), 0, 'a clean answer ends the backoff')
    // exponential: two 4xx in a row wait 15 min, then 30 min
    greylist = true; clock += 10
    await v.verify('grey.a@acme.test'); const first = backoffUntil(db, '127.0.0.1', clock) - clock
    clock += 901; await v.verify('grey.b@acme.test'); const second = backoffUntil(db, '127.0.0.1', clock) - clock
    assert.deepEqual([first, second], [900, 1800])
  } finally { await fake.close() }
})

test('#1036 smtp: a 5xx (a policy answer) says nothing about the mailbox: unknown, and never retried inside the call; a 5xx greeting backs the host off for a day', async () => {
  const { fake, v } = await setup(to => (to.includes('policy') ? '554 5.7.1 blocked' : normal(to)))
  try {
    assert.equal((await v.verify('policy.user@acme.test')).outcome, 'unknown')
    assert.equal(rcpts(fake).filter(l => l.includes('policy.user')).length, 1, 'asked once, not retried')
  } finally { await fake.close() }
  const g = await setup(normal, {}, '554 5.7.1 go away')
  try {
    assert.equal((await g.v.verify('dana.lee@acme.test')).outcome, 'unknown')
    assert.equal(backoffUntil(g.db, '127.0.0.1', clock), clock + 86_400)
  } finally { await g.fake.close() }
})

test('#1036 smtp: at most 60 RCPT per MX host per hour (counted before each command); the next hour starts fresh', async () => {
  const { fake, v } = await setup(normal)
  try {
    const answers: string[] = []
    for (let i = 0; i < 75; i++) answers.push((await v.verify(`user${i}@acme.test`)).outcome)
    assert.equal(rcpts(fake).length, RCPT_PER_HOUR)
    assert.ok(answers.slice(59).every(a => a === 'unknown'), 'past the limit: unknown, no command sent')
    clock += 3600; assert.equal((await v.verify('fresh.user@acme.test')).outcome, 'deliverable')
    assert.equal(rcpts(fake).length, RCPT_PER_HOUR + 1)
  } finally { await fake.close() }
})

test('#1036 smtp: one connection per MX host at a time, however many checks are asked at once', async () => {
  const { fake, v } = await setup(normal)
  try {
    const all = await Promise.all(['a', 'b', 'c', 'd'].map(n => v.verify(`${n}.user@acme.test`)))
    assert.deepEqual(all.map(x => x.outcome), ['deliverable', 'deliverable', 'deliverable', 'deliverable'])
    assert.equal(fake.maxConcurrent(), 1)
  } finally { await fake.close() }
})

test('#1036 smtp: MX choice - the preferred (lowest number) host; no MX falls back to the domain itself; a missing domain is undeliverable; a DNS failure is unknown', async () => {
  const f = await fakeSmtp(normal)
  try {
    const db = new Database(':memory:'); migrateAllSqlite(db)
    const asked: string[] = []
    const mkv = (over: Partial<SmtpEnv>) => smtpMailboxVerifier(db, cfgFor(f.port), envFor({ ...over, connect: async (h, p, t) => { asked.push(h); return realEnv.connect('127.0.0.1', p, t) } }))
    await mkv({ resolveMx: async () => [{ exchange: 'backup.mx.test.', priority: 20 }, { exchange: 'primary.mx.test.', priority: 5 }] }).verify('dana.lee@one.test')
    assert.deepEqual(asked, ['primary.mx.test'], 'the preferred MX, trailing dot removed')
    asked.length = 0
    const enodata = Object.assign(new Error('ENODATA'), { code: 'ENODATA' }), enotfound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    assert.equal((await mkv({ resolveMx: async () => { throw enodata }, resolveA: async () => ['192.0.2.9'] }).verify('dana.lee@two.test')).outcome, 'deliverable'); assert.deepEqual(asked, ['two.test'])
    assert.equal((await mkv({ resolveMx: async () => { throw enodata }, resolveA: async () => [] }).verify('x@three.test')).outcome, 'undeliverable')
    assert.equal((await mkv({ resolveMx: async () => { throw enotfound } }).verify('x@four.test')).outcome, 'undeliverable')
    assert.equal((await mkv({ resolveMx: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }) } }).verify('x@five.test')).outcome, 'unknown')
    assert.equal((await mkv({}).verify('not an address')).outcome, 'unknown')
  } finally { await f.close() }
})

test('#1036 smtp: the Spamhaus breaker - checked once a day; listed = every check stops (VerifierError stop) and nobody is contacted; unavailable does not stop', async () => {
  let zen: 'clean' | 'listed' | 'unavailable' = 'clean'; let asks = 0
  const { fake, v } = await setup(normal, { resolveZen: async () => { asks++; return zen } })
  try {
    await v.verify('a.user@acme.test'); await v.verify('b.user@acme.test')
    assert.equal(asks, 1, 'one query per day')
    clock += ZEN_RECHECK_S + 1; zen = 'listed'
    const c = fake.conns()
    await assert.rejects(v.verify('c.user@acme.test'), (e: unknown) => e instanceof VerifierError && e.kind === 'stop' && /Spamhaus/.test(e.message))
    assert.equal(fake.conns(), c, 'a listed address probes nobody')
    clock += ZEN_RECHECK_S + 1; zen = 'unavailable'
    assert.equal((await v.verify('d.user@acme.test')).outcome, 'deliverable', 'a resolver that refuses the query is not a listing')
  } finally { await fake.close() }
})

test('#1036 smtp: configuration fails closed - off by default; needs a HELO name and an IPv4 egress address; mail from defaults to verify@notify.dazl.ai', () => {
  assert.equal(smtpConfigFromEnv({}), null)
  assert.equal(smtpConfigFromEnv({ SMTP_VERIFY_ENABLED: '1' }), null, 'no HELO, no IP')
  assert.equal(smtpConfigFromEnv({ SMTP_VERIFY_ENABLED: '1', SMTP_VERIFY_HELO: 'verify.notify.dazl.ai' }), null, 'no egress IP: the blocklist check could not run')
  assert.equal(smtpConfigFromEnv({ SMTP_VERIFY_ENABLED: '1', SMTP_VERIFY_HELO: 'not a host', SMTP_VERIFY_EGRESS_IP: '203.0.113.7' }), null)
  assert.equal(smtpConfigFromEnv({ SMTP_VERIFY_ENABLED: '0', SMTP_VERIFY_HELO: 'verify.notify.dazl.ai', SMTP_VERIFY_EGRESS_IP: '203.0.113.7' }), null)
  assert.deepEqual(smtpConfigFromEnv({ SMTP_VERIFY_ENABLED: '1', SMTP_VERIFY_HELO: 'Verify.Notify.dazl.ai', SMTP_VERIFY_EGRESS_IP: '203.0.113.7' }), { helo: 'verify.notify.dazl.ai', mailFrom: 'verify@notify.dazl.ai', egressIp: '203.0.113.7', port: 25, connectMs: 10_000, commandMs: 15_000 })
})

test('#1036 smtp: verifierFromEnv offers it only with a database and the full configuration; the staging fake only on staging; the cap is its own', () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const on = { SMTP_VERIFY_ENABLED: '1', SMTP_VERIFY_HELO: 'verify.notify.dazl.ai', SMTP_VERIFY_EGRESS_IP: '203.0.113.7' }
  assert.equal(verifierFromEnv(on, undefined, db)?.name, 'smtp')
  assert.equal(verifierFromEnv(on), null, 'no database: no cache, no limits, so no check')
  assert.equal(verifierFromEnv({ ...on, SMTP_VERIFY_ENABLED: '0' }, undefined, db), null)
  assert.equal(verifierFromEnv({ DAZL_STAGING_FAKE_SMTP: '1' }, undefined, db), null, 'the fake is inert outside staging')
  assert.equal(verifierFromEnv({ DAZL_ENV: 'staging', DAZL_STAGING_FAKE_SMTP: '1' }, undefined, db)?.name, SMTP_STAGING_FAKE)
  assert.equal(verifierFromEnv({ DAZL_ENV: 'staging', DAZL_STAGING_FAKE_SMTP: '1' }), null)
  assert.deepEqual([smtpMonthlyCap({}), smtpMonthlyCap({ SMTP_VERIFY_MONTHLY_CAP: '50' }), smtpMonthlyCap({ SMTP_VERIFY_MONTHLY_CAP: '99999' }), smtpMonthlyCap({ SMTP_VERIFY_MONTHLY_CAP: 'x' })], [3000, 50, 20000, 0])
  assert.deepEqual([verifierMonthlyCap({}, 'smtp'), verifierMonthlyCap({}, 'smtp-staging-fake'), verifierMonthlyCap({}, 'zerobounce')], [3000, 3000, 100], 'a provider keeps its free allowance')
})

test('#1036 smtp: port 25 shut (connection refused / timeout) degrades honestly: unknown with a backoff, never "valid"', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const closed = await fakeSmtp(normal); const port = closed.port; await closed.close() // nobody listens here now
  const v = smtpMailboxVerifier(db, cfgFor(port), envFor())
  const a = await v.verify('dana.lee@acme.test')
  assert.equal(a.outcome, 'unknown'); assert.ok(backoffUntil(db, '127.0.0.1', clock) > clock)
})
