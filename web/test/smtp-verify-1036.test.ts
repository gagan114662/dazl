// #1036 dazl's own mailbox check (lib/people/smtp-verify.ts) against a FAKE SMTP SERVER on loopback: the real wire code, real
// sockets, scripted answers. Nothing leaves the machine; no DATA command is ever sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { VerifierError } from '../lib/people/zerobounce.ts'
import { verifierFromEnv, verifierMonthlyCap } from '../lib/people/email-pattern.ts'
import { looksLikeShutPort, NOT_CATCH_ALL_TTL_S, netConnect, backoffUntil, FACT_TTL_S, PORT25_FAILS, port25Blocked, getDomainFact, RCPT_PER_HOUR, realEnv, smtpConfigFromEnv, smtpMailboxVerifier, smtpMonthlyCap, SMTP_STAGING_FAKE, ZEN_RECHECK_S, type SmtpConfig, type SmtpEnv } from '../lib/people/smtp-verify.ts'

interface Fake { port: number; log: string[]; conns: () => number; maxConcurrent: () => number; close: () => Promise<void> }
// answer(rcpt) -> reply line "250 ok" / "550 no such user" / "450 try later"; greeting overrides the 220 banner.
async function fakeSmtp(answer: (to: string) => string, greeting = '220 mx.fake.test ESMTP'): Promise<Fake> {
  const log: string[] = []; let conns = 0, open = 0, maxOpen = 0
  const srv = net.createServer(sock => {
    conns++; open++; maxOpen = Math.max(maxOpen, open)
    sock.on('close', () => { open-- }); sock.on('error', () => {})
    sock.write(`${greeting}\r\n`)
    let buf = '', mailFrom = false
    sock.on('data', d => {
      buf += String(d)
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); log.push(line)
        const u = line.toUpperCase()
        if (u.startsWith('EHLO')) sock.write('250-mx.fake.test\r\n250 PIPELINING\r\n')
        else if (u.startsWith('MAIL FROM')) { mailFrom = true; sock.write('250 ok\r\n') }
        else if (u.startsWith('RCPT TO') && !mailFrom) sock.write('503 5.5.1 need MAIL first\r\n') // as real servers do after an RSET
        else if (u.startsWith('RCPT TO')) { const r = answer(/<([^>]*)>/.exec(line)?.[1]?.toLowerCase() ?? ''); if (r) sock.write(`${r}\r\n`) } // '' = say nothing
        else if (u.startsWith('RSET')) { mailFrom = false; sock.write('250 ok\r\n') }
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
const envFor = (over: Partial<SmtpEnv> = {}): SmtpEnv => ({ ...realEnv, connect: (h, p, ms, r) => netConnect(h, p, ms, undefined, r), resolveMx: async () => [{ exchange: '127.0.0.1', priority: 10 }], resolveZen: async () => 'clean', now: () => clock, random: () => 'abc123', ...over })
const setup = async (answer: (to: string) => string, over: Partial<SmtpEnv> = {}, greeting?: string) => {
  const db = new Database(':memory:'); migrateAllSqlite(db); const fake = await fakeSmtp(answer, greeting)
  return { db, fake, v: smtpMailboxVerifier(db, cfgFor(fake.port), envFor(over)) }
}
const normal = (to: string) => to.startsWith('dazl-check-') || to.includes('nouser') ? '550 5.1.1 no such user' : '250 ok'

test('#1036 smtp: 250 for the address and 550 for the random probe = deliverable; the dialog is EHLO, MAIL FROM, RCPT probe, RCPT address, QUIT - never DATA', async () => {
  const { fake, v } = await setup(normal)
  try {
    const a = await v.verify('dana.lee@acme.test')
    assert.equal(a.outcome, 'deliverable')
    await new Promise(r => setTimeout(r, 100)) // the QUIT is written as the check returns; let it arrive
    assert.deepEqual(fake.log, ['EHLO verify.notify.dazl.ai', 'MAIL FROM:<verify@notify.dazl.ai>', 'RCPT TO:<dazl-check-abc123@acme.test>', 'RCPT TO:<dana.lee@acme.test>', 'QUIT'])
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
    const mkv = (over: Partial<SmtpEnv>) => smtpMailboxVerifier(db, cfgFor(f.port), envFor({ ...over, connect: async (h, p, t) => { asked.push(h); return netConnect('127.0.0.1', p, t) } }))
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

test('#1036 smtp: three hosts in a row that never greet (port 25 shut) switch the check off for an hour at once, with an honest answer; one greeting ends it', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  let connects = 0 // a blackholed port 25 (the EC2 default) never greets: modelled as a connection that fails at once
  const v = smtpMailboxVerifier(db, cfgFor(25), envFor({ resolveMx: async d => [{ exchange: `mx.${d}`, priority: 1 }], connect: async () => { connects++; throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) } }))
  for (let i = 0; i < PORT25_FAILS; i++) await v.verify(`a.user@d${i}.test`)
  assert.equal(connects, PORT25_FAILS); assert.ok(port25Blocked(db, clock))
  const a = await v.verify('b.user@another.test')
  assert.equal(a.outcome, 'unknown'); assert.match(String(a.detail), /port 25 appears to be shut/); assert.equal(connects, PORT25_FAILS, 'no connection attempted while it is judged shut')
  clock += 3601; assert.ok(!port25Blocked(db, clock), 'after an hour it is tried again')
  const live = await fakeSmtp(normal)
  try { const v2 = smtpMailboxVerifier(db, cfgFor(live.port), envFor()); assert.equal((await v2.verify('dana.lee@acme.test')).outcome, 'deliverable'); assert.equal(port25Blocked(db, clock), false) } finally { await live.close() }
})

test('#1036 smtp: the real connect path refuses an MX that points at a non-public address (loopback, private, link-local, metadata) - no socket is opened', async () => {
  const f = await fakeSmtp(normal)
  try {
    await assert.rejects(realEnv.connect('127.0.0.1', f.port, 2000), /blocked_address/)
    assert.equal(f.conns(), 0, 'nothing connected')
    for (const ip of ['10.0.0.5', '192.168.1.1', '169.254.169.254', '172.16.0.9', '100.64.0.1', '::1']) await assert.rejects(realEnv.connect(ip, 25, 500), /blocked_address/, ip)
    // through the verifier: an attacker's domain whose MX is internal gets a day's backoff and an honest answer, and does not count as "port 25 shut"
    const db = new Database(':memory:'); migrateAllSqlite(db)
    const v = smtpMailboxVerifier(db, cfgFor(f.port), { ...envFor(), connect: realEnv.connect, resolveMx: async () => [{ exchange: '169.254.169.254', priority: 1 }] })
    const a = await v.verify('x.user@evil.test')
    assert.equal(a.outcome, 'unknown'); assert.match(String(a.detail), /not a public one/)
    assert.equal(port25Blocked(db, clock), false); assert.equal(backoffUntil(db, '169.254.169.254', clock), clock + 86_400)
  } finally { await f.close() }
})

// ---- independent review of the verifier (R1-R9) ----
test('#1036 smtp review R1: hostile MX names - an internal address, localhost, the metadata address - are never connected to, through the REAL connect path', async () => {
  for (const exchange of ['10.0.0.5', 'localhost', '169.254.169.254', '192.168.0.10']) {
    const db = new Database(':memory:'); migrateAllSqlite(db); let reached = 0
    const real = realEnv.connect
    const v = smtpMailboxVerifier(db, cfgFor(25), { ...envFor(), connect: async (h, p, t, r) => { reached++; return real(h, p, t, r) }, resolveMx: async () => [{ exchange, priority: 1 }] })
    const a = await v.verify('x.user@evil.test')
    assert.equal(a.outcome, 'unknown', exchange); assert.match(String(a.detail), /not a public one/, exchange); assert.equal(port25Blocked(db, clock), false, `${exchange} is not a port-25 symptom`)
    assert.equal(reached, 1, 'the guard sits inside the real connect: it was asked once and refused')
  }
})

test('#1036 smtp review R2: only a timeout or no route counts as "port 25 shut"; refused connections and dead MX names never switch the check off for everyone', async () => {
  assert.deepEqual([looksLikeShutPort(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), looksLikeShutPort(new Error('connect timeout')), looksLikeShutPort(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })), looksLikeShutPort(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), looksLikeShutPort(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))], [true, true, true, false, false])
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const v = smtpMailboxVerifier(db, cfgFor(25), envFor({ resolveMx: async d => [{ exchange: `mx.${d}`, priority: 1 }], connect: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) } }))
  for (let i = 0; i < 5; i++) await v.verify(`a.user@h${i}.test`)
  assert.equal(port25Blocked(db, clock), false)
})

test('#1036 smtp review R3: a 550 that is a POLICY refusal (5.7.1) is unknown, never undeliverable, and is not cached as a catch-all answer', async () => {
  const { db, fake, v } = await setup(() => '550 5.7.1 client host blocked')
  try {
    assert.equal((await v.verify('dana.lee@acme.test')).outcome, 'unknown')
    assert.equal(getDomainFact(db, 'acme.test', clock)?.catchAll, null, 'nothing cached about catch-all')
    assert.equal(rcpts(fake).length, 1, 'the probe was refused by policy, so the address was not even asked')
  } finally { await fake.close() }
  const g = await setup(to => (to.startsWith('dazl-check-') ? '550 5.1.1 no such user' : '550 5.7.1 sender blocked'))
  try { assert.equal((await g.v.verify('dana.lee@acme.test')).outcome, 'unknown', 'a policy refusal on the address itself') } finally { await g.fake.close() }
})

test('#1036 smtp review R5: "rejects unknown addresses" is trusted for 7 days, not 30: a domain that moves behind an accept-all gateway is re-probed', async () => {
  let acceptAll = false
  const { db, fake, v } = await setup(to => (acceptAll ? '250 ok' : normal(to)))
  try {
    assert.equal((await v.verify('dana.lee@acme.test')).outcome, 'deliverable')
    clock += NOT_CATCH_ALL_TTL_S - 60; acceptAll = true
    assert.equal((await v.verify('ben.ross@acme.test')).outcome, 'deliverable', 'still inside the 7 days: the cached answer is used (documented limit)')
    clock += 120
    assert.equal(getDomainFact(db, 'acme.test', clock)?.catchAll, null, 'after 7 days the catch-all answer is stale; the MX is kept')
    assert.equal((await v.verify('cara.diaz@acme.test')).outcome, 'catch_all', 'the domain flipped to accept-all and is now seen as such')
  } finally { await fake.close() }
})

test('#1036 smtp review R6: only the validated address reaches the wire - a trailing CRLF adds no command, an embedded one is not an address', async () => {
  const { fake, v } = await setup(normal)
  try {
    assert.equal((await v.verify('a.user@acme.test\r\nDATA')).outcome, 'unknown'); assert.equal(fake.conns(), 0)
    assert.equal((await v.verify('  a.user@acme.test \r\n')).outcome, 'deliverable')
    await new Promise(r => setTimeout(r, 100))
    assert.ok(fake.log.every(l => l.length > 0 && !/^DATA/i.test(l)), JSON.stringify(fake.log))
    assert.deepEqual(rcpts(fake).filter(l => l.includes('a.user')), ['RCPT TO:<a.user@acme.test>'], 'exactly the validated address, in one line')
    assert.ok(!fake.log.includes('>'), 'no stray fragment of a split command')
  } finally { await fake.close() }
})

test('#1036 smtp review R7: a caller whose budget is spent is not served; aborting mid-call closes the socket at once instead of waiting out the reply timeout', async () => {
  const { fake, v } = await setup(to => (to.startsWith('dazl-check-') ? '550 5.1.1 no such user' : ''))   // the address RCPT is never answered
  try {
    const spent = AbortSignal.abort(); const c0 = fake.conns()
    assert.equal((await v.verify('dana.lee@acme.test', spent)).outcome, 'unknown'); assert.equal(fake.conns(), c0, 'no connection for an aborted caller')
    const t0 = Date.now(); const a = await v.verify('dana.lee@acme.test', AbortSignal.timeout(300))
    assert.equal(a.outcome, 'unknown'); assert.ok(Date.now() - t0 < 2000, `returned in ${Date.now() - t0} ms, not the 3 s reply timeout`)
  } finally { await fake.close() }
})

test('#1036 smtp review R8/R9: a server that streams endless "250-" lines is cut off; a reply split across TCP chunks is read; a 252 is not "deliverable"', async () => {
  const flood = await setup(normal, {}, Array.from({ length: 2000 }, () => '250-x').join('\r\n'))
  try { const t0 = Date.now(); assert.equal((await flood.v.verify('dana.lee@acme.test')).outcome, 'unknown'); assert.ok(Date.now() - t0 < 2500, 'cut off, not read to the timeout') } finally { await flood.fake.close() }
  // split greeting: "22" then "0 hello"
  const srv = net.createServer(sock => { sock.on('error', () => {}); sock.write('22'); setTimeout(() => sock.write('0 split.test ESMTP\r\n'), 60)
    let buf = ''; let mf = false
    sock.on('data', d => { buf += String(d); for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) { const l = buf.slice(0, i).toUpperCase(); buf = buf.slice(i + 2)
      if (l.startsWith('EHLO')) sock.write('250-split.test\r\n250-SIZE 100\r\n250 8BITMIME\r\n'); else if (l.startsWith('MAIL')) { mf = true; sock.write('250 ok\r\n') }
      else if (l.startsWith('RCPT') && mf) sock.write(l.includes('DAZL-CHECK') ? '550 5.1.1 no\r\n' : '252 cannot verify\r\n'); else if (l.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end() } } }) })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  try {
    const db = new Database(':memory:'); migrateAllSqlite(db)
    const a = await smtpMailboxVerifier(db, cfgFor((srv.address() as net.AddressInfo).port), envFor()).verify('dana.lee@split.test')
    assert.equal(a.outcome, 'unknown', 'the split greeting and the multi-line EHLO were read, and a 252 is not an acceptance'); assert.match(String(a.detail), /252/)
  } finally { await new Promise<void>(r => srv.close(() => r())) }
})

test('#1036 smtp review R7: a caller that is already aborted while it WAITS for the host is not served when its turn comes (no connection)', async () => {
  const f = await fakeSmtp(normal)
  try {
    const db = new Database(':memory:'); migrateAllSqlite(db); let connects = 0; let open!: () => void; const gate = new Promise<void>(r => { open = r })
    const v = smtpMailboxVerifier(db, cfgFor(f.port), envFor({ connect: async (_h, p, t, r) => { connects++; await gate; return netConnect('127.0.0.1', p, t, undefined, r) } }))
    const first = v.verify('a.user@acme.test')                       // holds the host until the gate opens
    const ctrl = new AbortController(); const second = v.verify('b.user@acme.test', ctrl.signal)
    await new Promise(r => setTimeout(r, 50)); ctrl.abort(); open()
    assert.equal((await first).outcome, 'deliverable'); assert.equal((await second).outcome, 'unknown')
    assert.equal(connects, 1, 'only the first caller connected')
  } finally { await f.close() }
})
