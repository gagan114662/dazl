// #357 sign-up through the real routes (workspace-session-loader.mjs: real session lookup, per-request cookie jar).
// Sign-up answers the same for a new address and for one that already has an account (status, body, no cookie, about
// the same time); nobody is signed in; an existing address gets a notice instead. An unconfirmed account reaches no app
// route or page, even with a session made before confirmation was required; confirming opens the app; replayed,
// superseded and expired links fail. Malformed input fails closed the same way for every address. No mail leaves the
// process (a test transport writes the outbox) and any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, getSessionUser, hasLiveSession } from '../../lib/auth-db.ts'
import { resolveUser } from '../../lib/auth-google.ts'
import { getDb } from '../../lib/db/client.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.SYSTEM_MAIL_SMTP_URL = 'smtp://fixture.invalid'; process.env.SYSTEM_MAIL_FROM = 'fixture@example.test'
const { setTransportForTests } = await import('../../lib/system-mail.ts')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
let failMail = false
setTransportForTests(async m => {
  if (failMail) throw new Error('smtp down (fixture)')
  raw.prepare('INSERT INTO system_mail_outbox (id,user_id,to_email,subject,body,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), 'fixture', m.to, m.subject, m.text, Math.floor(Date.now() / 1000))
})
const signup = await import('../../app/api/auth/signup/route.ts')
const signin = await import('../../app/api/auth/signin/route.ts')
const verify = await import('../../app/api/auth/verify/route.ts')
const email = await import('../../app/api/auth/email/route.ts')
const usage = await import('../../app/api/usage/route.ts')
const { proxy } = await import('../../proxy.ts')

let ip = 0
const req = (path: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.${(++ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`, ...headers },
  body: typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body) })
// One sign-up as a browser would send it: a fresh cookie jar; everything the caller can observe comes back.
const signUp = async (body: unknown) => {
  const jar = new Map<string, string>()
  const t0 = performance.now()
  const r = await withJar(jar, () => signup.POST(req('/api/auth/signup', body)))
  const ms = performance.now() - t0
  return { status: r.status, text: await r.text(), cookie: r.headers.get('set-cookie'), jar: [...jar.keys()], ms }
}
const seen = (r: Awaited<ReturnType<typeof signUp>>) => ({ status: r.status, text: r.text, cookie: r.cookie, jar: r.jar })
const signIn = async (address: unknown, password: unknown) => {
  const jar = new Map<string, string>()
  const r = await withJar(jar, () => signin.POST(req('/api/auth/signin', { email: address, password })))
  return { status: r.status, body: await r.json() as { code?: string; error?: string }, token: jar.get('dazl_session') }
}
const mails = (to: string) => raw.prepare('SELECT subject, body FROM system_mail_outbox WHERE to_email = ? ORDER BY rowid').all(to) as { subject: string; body: string }[]
const links = (to: string) => mails(to).map(m => /\/verify#t=([a-f0-9]{64})/.exec(m.body)?.[1]).filter((t): t is string => !!t)
const count = (sql: string, ...args: unknown[]) => (raw.prepare(sql).get(...args) as { n: number }).n
const userRow = (address: string) => raw.prepare('SELECT id, name, business_name, password_hash, salt, email_verified_at FROM users WHERE email = ?').get(address) as Record<string, unknown> | undefined
const PW = 'a strong password 1'
const NOTICE = 'Someone tried to sign up to dazl with your email'
const verified = (address: string) => (raw.prepare('SELECT email_verified_at AS v FROM users WHERE email = ?').get(address) as { v: number | null }).v !== null
const opened = async (token: unknown) => (await verify.POST(req('/api/auth/verify', { token }))).status
const app = (token: string | undefined, f: () => Promise<Response>) => withJar(new Map(token ? [['dazl_session', token]] : []), f)
const page = async (path: string, token: string) => (await proxy(new NextRequest(`https://dazl.test${path}`, { headers: { cookie: `dazl_session=${token}` } }))).headers.get('location')

// Existing accounts of every kind: confirmed password, unconfirmed password, Google.
const hash = (pw: string, salt: string) => scryptSync(pw, salt, 64).toString('hex')
async function existing(id: string, address: string, confirmed: boolean) {
  await createPasswordUser({ id, email: address, name: `Name ${id}`, business_name: `Biz ${id}`, password_hash: hash('their own password 9', 's'.repeat(32)), salt: 's'.repeat(32) })
  if (confirmed) raw.prepare('UPDATE users SET email_verified_at = 1 WHERE id = ?').run(id)
}

test('sign-up: one answer for a new address and for confirmed, unconfirmed and Google accounts; nobody signed in; the owner hears instead', async () => {
  await existing('K1', 'known@example.test', true)
  await existing('K2', 'pending@example.test', false)
  const g = await resolveUser(await getDb(), { sub: 'g-357', email: 'gee@example.test', name: 'G' })
  assert.ok('user_id' in g)
  const before = { k1: userRow('known@example.test'), k2: userRow('pending@example.test'), g: userRow('gee@example.test') }
  const orgs = count('SELECT count(*) AS n FROM organizations')

  const answers = {
    fresh: await signUp({ email: 'fresh@example.test', password: PW, name: 'F', business_name: 'F Co' }),
    known: await signUp({ email: 'known@example.test', password: PW, name: 'F', business_name: 'F Co' }),
    pending: await signUp({ email: 'pending@example.test', password: PW, name: 'F', business_name: 'F Co' }),
    google: await signUp({ email: 'gee@example.test', password: PW, name: 'F', business_name: 'F Co' }),
    variant: await signUp({ email: '  Known@Example.TEST ', password: PW, name: 'F', business_name: 'F Co' }),
  }
  for (const [k, r] of Object.entries(answers)) assert.deepEqual(seen(r), seen(answers.fresh), k)
  assert.equal(answers.fresh.status, 200)
  assert.deepEqual(JSON.parse(answers.fresh.text), { ok: true, check_email: true, message: 'Check your email. If this address can receive mail from us, a link to finish creating your account is on its way; open it, then sign in.' })
  assert.equal(answers.fresh.cookie, null, 'no Set-Cookie for anyone'); assert.deepEqual(answers.fresh.jar, [])
  assert.equal(count('SELECT count(*) AS n FROM sessions'), 0, 'sign-up makes no session at all')

  // the existing accounts are untouched; only the new address became an (unconfirmed) account with its workspace
  assert.deepEqual({ k1: userRow('known@example.test'), k2: userRow('pending@example.test'), g: userRow('gee@example.test') }, before)
  assert.equal(count('SELECT count(*) AS n FROM users'), 4)
  assert.equal(count('SELECT count(*) AS n FROM organizations'), orgs + 1)
  assert.equal(userRow('fresh@example.test')!.email_verified_at, null)

  // mail: the new address gets its confirmation link; each existing one a notice that carries no link acting on it
  assert.deepEqual(mails('fresh@example.test').map(m => m.subject), ['Confirm your email for dazl'])
  assert.equal(links('fresh@example.test').length, 1)
  for (const [to, n] of [['known@example.test', 2], ['pending@example.test', 1], ['gee@example.test', 1]] as const) {
    assert.deepEqual(mails(to).map(m => m.subject), Array(n).fill(NOTICE), to)
    for (const m of mails(to)) assert.doesNotMatch(m.body, /#t=/, 'a notice is not a capability')
  }
  assert.match(mails('gee@example.test')[0].body, /Continue with Google/)
  assert.match(mails('known@example.test')[0].body, /\/reset/)
  assert.equal(count("SELECT count(*) AS n FROM email_tokens WHERE user_id IN ('K1', 'K2', ?)", g.user_id), 0, 'no token issued for an existing account')
  console.log('SIGNUP SAME ANSWER ok')
})

test('sign-up takes about the same time for a new and an existing address (interleaved, medians)', async () => {
  const N = 9
  for (let i = 0; i < N; i++) await existing(`T${i}`, `taken${i}@example.test`, i % 3 !== 0)
  const known: number[] = [], unknown: number[] = []
  await signUp({ email: 'warmup@example.test', password: PW })
  for (let i = 0; i < N; i++) {
    const a = await signUp({ email: `taken${i}@example.test`, password: PW })
    const b = await signUp({ email: `new${i}@example.test`, password: PW })
    assert.deepEqual(seen(a), seen(b))
    known.push(a.ms); unknown.push(b.ms)
  }
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]
  const mk = median(known), mu = median(unknown)
  console.log(`SIGNUP TIMING median known=${mk.toFixed(1)}ms unknown=${mu.toFixed(1)}ms`)
  assert.ok(Math.abs(mk - mu) <= Math.max(15, 0.3 * Math.min(mk, mu)), `known ${mk.toFixed(1)}ms vs unknown ${mu.toFixed(1)}ms`)
})

test('an unconfirmed account reaches no app route or page; confirming opens the app; superseded, expired and replayed links fail', async () => {
  const address = 'newcomer@example.test'
  assert.equal((await signUp({ email: address, password: PW, name: 'N', business_name: 'N Co' })).status, 200)
  const [first] = links(address)
  const id = userRow(address)!.id as string

  // a wrong password: the same 401 as an unknown address. The right one: 403 email_unverified, no session, a new link.
  const wrong = await signIn(address, 'not the password 1'), nobody = await signIn('nobody@example.test', 'not the password 1')
  assert.deepEqual([wrong.status, wrong.body], [nobody.status, nobody.body]); assert.equal(wrong.status, 401)
  const early = await signIn(address, PW)
  assert.equal(early.status, 403); assert.equal(early.body.code, 'email_unverified'); assert.equal(early.token, undefined)
  assert.equal(links(address).length, 2, 'signing in sent a fresh link')

  // a session for the unconfirmed account (as an old sign-up made) reaches nothing: API routes, the page gate, /app
  const legacy = await createSession(id)
  assert.equal(await getSessionUser(legacy), null)
  assert.equal(await hasLiveSession(legacy), false)
  assert.equal((await app(legacy, () => email.GET())).status, 401)
  assert.equal((await app(legacy, () => usage.GET(new NextRequest('http://localhost/api/usage')))).status, 401)
  for (const p of ['/app', '/app/settings', '/app/leads']) assert.equal(await page(p, legacy), 'https://dazl.test/sign-in', p)

  // the first link was superseded by the sign-in's: refused, nothing changes
  assert.equal(await opened(first), 410); assert.equal(verified(address), false)
  // an expired link: refused, nothing changes
  const second = links(address)[1]
  raw.prepare("UPDATE email_tokens SET expires_at = 1 WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL").run(id)
  assert.equal(await opened(second), 410); assert.equal(verified(address), false)
  assert.equal((await signIn(address, PW)).status, 403, 'still closed')

  // the newest link confirms, once
  const newest = links(address).at(-1)!
  assert.equal(await opened(newest), 200); assert.equal(verified(address), true)
  assert.equal(await opened(newest), 410, 'replay')
  const inn = await signIn(address, PW)
  assert.equal(inn.status, 200); assert.ok(inn.token)
  assert.deepEqual(await (await app(inn.token, () => email.GET())).json(), { email: address, verified: true, google: false })
  assert.equal((await app(inn.token, () => usage.GET(new NextRequest('http://localhost/api/usage')))).status, 200)
  assert.equal(await page('/app', inn.token!), null, 'the page gate lets a confirmed session through')
  console.log('SIGNUP CONFIRMATION GATE ok')
})

test('malformed input fails closed, the same for a known and an unknown address, and creates or sends nothing', async () => {
  await existing('M1', 'member@example.test', true)
  const users = count('SELECT count(*) AS n FROM users'), outbox = count('SELECT count(*) AS n FROM system_mail_outbox')
  const deep: Record<string, unknown> = {}; let cur = deep; for (let i = 0; i < 500; i++) { cur.x = {}; cur = cur.x as Record<string, unknown> }
  const badBodies: unknown[] = ['{not json', 'null', '[]', '42', '"a string"', JSON.stringify(deep), new Uint8Array([0xff, 0xfe, 0xfd])]
  for (const b of badBodies) assert.equal((await signUp(b)).status, 400, String(b).slice(0, 20))
  const badEmails: unknown[] = [['member@example.test'], { e: 'member@example.test' }, 123, true, null, '', 'a'.repeat(300) + '@example.test', '\ud800@example.test', 'member@example.test\u0000']
  for (const e of badEmails) {
    const r = await signUp({ email: e, password: PW })
    assert.equal(r.status, 400, JSON.stringify(e)?.slice(0, 40)); assert.equal(r.cookie, null)
  }
  const badPasswords: unknown[] = [['a strong password 1'], { p: 1 }, 1234567890, null, true, '', 'short1', 'x'.repeat(201) + '1', 'no digits in this one']
  for (const p of badPasswords) {
    const known = await signUp({ email: 'member@example.test', password: p }), unknown = await signUp({ email: 'stranger@example.test', password: p })
    assert.deepEqual(seen(known), seen(unknown), JSON.stringify(p)?.slice(0, 40)); assert.equal(known.status, 400)
  }
  assert.equal(count('SELECT count(*) AS n FROM users'), users, 'nothing created')
  assert.equal(count('SELECT count(*) AS n FROM system_mail_outbox'), outbox, 'nothing sent')

  // extra and wrong-typed optional fields: ignored; no caller-chosen id, verification or role
  const extra = await signUp({ email: 'extra@example.test', password: PW, id: 'M1', email_verified_at: 1, role: 'owner', name: { evil: 1 }, business_name: 'B'.repeat(10_000) })
  assert.equal(extra.status, 200)
  const row = userRow('extra@example.test')!
  assert.notEqual(row.id, 'M1'); assert.equal(row.email_verified_at, null); assert.equal(row.name, ''); assert.equal(String(row.business_name).length, 150)
  assert.equal(userRow('member@example.test')!.id, 'M1')

  // verification tokens of every wrong shape: 410, nothing confirmed
  for (const t of [undefined, null, 42, [], {}, true, 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(100_000)]) assert.equal(await opened(t), 410, JSON.stringify(t)?.slice(0, 20))
  assert.equal((await verify.POST(req('/api/auth/verify', '{"token":', {}))).status, 410, 'broken JSON')
  assert.equal((await verify.POST(req('/api/auth/verify', { token: links('extra@example.test')[0] }, { 'content-type': 'text/plain' }))).status, 400, 'not JSON: refused before use')
  assert.equal((await verify.POST(req('/api/auth/verify', { token: links('extra@example.test')[0] }, { origin: 'https://evil.example' }))).status, 400, 'cross-origin: refused before use')
  assert.equal(verified('extra@example.test'), false)
  assert.equal(await opened(links('extra@example.test')[0]), 200, 'the refused requests left the link usable')

  // sign-in with wrong-typed fields: the same 401
  for (const [e, p] of [[['member@example.test'], PW], ['member@example.test', { p: 1 }], [null, null], [{}, []]] as const) assert.equal((await signIn(e, p)).status, 401)
  console.log('SIGNUP MALFORMED ok')
})

test('the per-address cap and concurrent sign-ups answer the same and never tell accounts apart; a failed send changes nothing for the caller', async () => {
  await existing('C1', 'capped-known@example.test', true)
  const known: string[] = [], unknown: string[] = []
  for (let i = 0; i < 5; i++) {
    known.push(JSON.stringify(seen(await signUp({ email: 'capped-known@example.test', password: PW }))))
    unknown.push(JSON.stringify(seen(await signUp({ email: 'capped-new@example.test', password: PW }))))
  }
  assert.equal(new Set([...known, ...unknown]).size, 1)
  assert.equal(mails('capped-known@example.test').length, 3, 'three notices, then nothing')
  assert.deepEqual(mails('capped-new@example.test').map(m => m.subject), ['Confirm your email for dazl', NOTICE, NOTICE], 'the same cap for a new address')

  const race = await Promise.all([signUp({ email: 'race@example.test', password: PW }), signUp({ email: 'race@example.test', password: PW })])
  assert.deepEqual(seen(race[0]), seen(race[1]))
  assert.equal(count("SELECT count(*) AS n FROM users WHERE email = 'race@example.test'"), 1)
  assert.deepEqual(mails('race@example.test').map(m => m.subject).sort(), ['Confirm your email for dazl', NOTICE].sort())

  await existing('D1', 'down-known@example.test', true)
  failMail = true
  const down = [await signUp({ email: 'down-known@example.test', password: PW }), await signUp({ email: 'down-new@example.test', password: PW })]
  failMail = false
  assert.deepEqual(seen(down[0]), seen(down[1])); assert.equal(down[0].status, 200)
  // the account made while mail was down signs in to a fresh link instead of being stuck
  const stuck = await signIn('down-new@example.test', PW)
  assert.equal(stuck.status, 403); assert.equal(links('down-new@example.test').length, 1)
  console.log('SIGNUP CAP+RACE ok')
})

test('without mail delivery sign-up is exactly main\'s: the new account is signed in and never locked out; a taken address gets main\'s 400', async () => {
  await existing('N1', 'nomail-known@example.test', true)
  await existing('N2', 'nomail-pending@example.test', false)
  const smtp = process.env.SYSTEM_MAIL_SMTP_URL; delete process.env.SYSTEM_MAIL_SMTP_URL
  try {
    const fresh = await signUp({ email: 'nomail-new@example.test', password: PW, name: 'Q', business_name: 'Q Co' })
    assert.equal(fresh.status, 200); assert.deepEqual(JSON.parse(fresh.text), { ok: true, redirect: '/app' }, 'main\'s answer')
    assert.deepEqual(fresh.jar, ['dazl_session'], 'signed in, as on main')
    const row = raw.prepare('SELECT email_confirmation_required AS f, email_verified_at AS v FROM users WHERE email = ?').get('nomail-new@example.test') as { f: number; v: unknown }
    assert.deepEqual({ ...row }, { f: 0, v: null }, 'no requirement without a way to confirm; nothing marked verified')
    const known = await signUp({ email: 'nomail-known@example.test', password: PW }), pending = await signUp({ email: 'nomail-pending@example.test', password: PW })
    assert.deepEqual(seen(known), seen(pending)); assert.equal(known.status, 400)
    assert.deepEqual(JSON.parse(known.text), { error: 'We could not create an account with those details. Try signing in instead.' }, 'main\'s 400')
    assert.equal(mails('nomail-known@example.test').length, 0, 'no notice without mail delivery')
    // the account made without mail signs in, keeps its session, and reaches the app
    const back = await signIn('nomail-new@example.test', PW)
    assert.equal(back.status, 200); assert.ok(back.token)
    assert.equal((await app(back.token, () => usage.GET(new NextRequest('http://localhost/api/usage')))).status, 200)
    assert.equal(await page('/app', back.token!), null)
    // a legacy unconfirmed account signs in and keeps working, with no mail configured
    const legacy = await signIn('nomail-pending@example.test', 'their own password 9')
    assert.equal(legacy.status, 200); assert.ok(legacy.token)
    assert.equal(await hasLiveSession(legacy.token), true)
  } finally { process.env.SYSTEM_MAIL_SMTP_URL = smtp }
  console.log('SIGNUP NO-MAIL ok')
})

test('accounts that existed before keep sessions and password sign-in with mail configured; the requirement never reaches them', async () => {
  await existing('E1', 'old-unconfirmed@example.test', false)
  const before = await createSession('E1')
  assert.ok(await getSessionUser(before), 'a session made before the change keeps working')
  assert.equal(await hasLiveSession(before), true)
  assert.equal(await page('/app', before), null)
  assert.equal((await app(before, () => usage.GET(new NextRequest('http://localhost/api/usage')))).status, 200)
  const inn = await signIn('old-unconfirmed@example.test', 'their own password 9')
  assert.equal(inn.status, 200, 'password sign-in as on main'); assert.ok(inn.token)
  assert.equal(links('old-unconfirmed@example.test').length, 0, 'no link pushed at a legacy account')
  assert.deepEqual({ ...(raw.prepare("SELECT email_confirmation_required AS f, email_verified_at AS v FROM users WHERE id = 'E1'").get() as object) }, { f: 0, v: null }, 'not marked verified')
  console.log('SIGNUP LEGACY ok')
})

test('#1095 login CSRF: sign-up and sign-in refuse a cross-site request (a foreign Origin, or a text/plain form body), create nothing and set no session', async () => {
  const users = () => count('SELECT count(*) AS n FROM users')
  const before = users()
  for (const [route, path] of [[signup, '/api/auth/signup'], [signin, '/api/auth/signin']] as const) {
    const body = { email: `csrf-${path.slice(10)}@example.test`, password: 'correct horse battery 9', name: 'X', business_name: 'X' }
    for (const headers of [{ origin: 'https://evil.example' }, { 'content-type': 'text/plain' }] as Record<string, string>[]) {
      const r = await route.POST(req(path, body, headers))
      assert.equal(r.status, 400, `${path} ${JSON.stringify(headers)}`)
      assert.ok(!r.headers.getSetCookie().some(c => /^dazl_session=[0-9a-f]/.test(c)), `${path}: no session`)
    }
  }
  assert.equal(users(), before, 'no account was created')
  console.log('SIGNUP LOGIN-CSRF ok')
})
