// #1686 (Quest, production, 2026-11-24): after a Google sign-in as one account and a password sign-in as another in the same browser,
// Settings showed one account, the dashboard the other, and Sign out left the browser signed in. Production records showed no shared
// data: each account owned only its own workspace. The cause was the cookie: Google sign-in sets dazl_session for the parent domain,
// a password sign-in sets it for the host only, the browser keeps both, and Sign out removed only the host-only one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { expireSessionCookies, expiredSessionCookies, sessionTokens } from '../lib/session-cookie.ts'

test('#1686 every session the browser presents is seen, each once, whatever else is in the Cookie header', () => {
  assert.deepEqual(sessionTokens('dazl_session=aaa; theme=dark; dazl_session=bbb'), ['aaa', 'bbb'])
  assert.deepEqual(sessionTokens('other=1;dazl_session=aaa;dazl_session=aaa'), ['aaa'])
  assert.deepEqual(sessionTokens('dazl_session_x=nope; xdazl_session=nope; dazl_session='), [])
  assert.deepEqual(sessionTokens(null), [])
  assert.deepEqual(sessionTokens(''), [])
})

test('#1686 the cookie is removed in its host-only form and in its parent-domain form', () => {
  const both = expiredSessionCookies('https://dazl.ai', 'both')
  assert.equal(both.length, 2)
  assert.match(both[0], /^dazl_session=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/)
  assert.match(both[1], /^dazl_session=; Domain=\.dazl\.ai; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/)
  assert.deepEqual(expiredSessionCookies('https://dazl.ai', 'host'), [both[0]])
  assert.deepEqual(expiredSessionCookies('https://dazl.ai', 'domain'), [both[1]])
  // no parent-domain form on localhost or an IP address: nothing to remove there
  assert.deepEqual(expiredSessionCookies('http://localhost:3000', 'domain'), [])
  assert.equal(expiredSessionCookies('http://127.0.0.1:3000', 'both').length, 1)
  const res = expireSessionCookies({ headers: new Headers({ 'set-cookie': 'other=1' }) }, 'https://dazl.ai', 'both')
  assert.equal(res.headers.getSetCookie().length, 3, 'added beside the cookies already on the response')
})

test('#1686 each way of signing in removes the other form of the cookie, and signing out removes both and ends every presented session', () => {
  const src = (p: string) => readFileSync(new URL(`../app/api/auth/${p}/route.ts`, import.meta.url), 'utf8')
  // a password sign-in or sign-up sets the host-only cookie and removes the parent-domain one
  assert.match(src('signin'), /return expireSessionCookies\(NextResponse\.json\(\{ ok: true, redirect: '\/app', \.\.\.resume \}\), [^)]+, 'domain'\)/)
  assert.equal((src('signup').match(/expireSessionCookies\([^\n]+, 'domain'\)/g) ?? []).length, 2, 'the script answer and the no-script form answer')
  // Google sign-in sets the parent-domain cookie and removes the host-only one, as the last thing done to the response
  const google = src('callback/google')
  assert.match(google, /return expireSessionCookies\(res, base, 'host'\)\n\}/)
  assert.ok(google.indexOf('setSessionCookie(res, base, session') < google.indexOf("expireSessionCookies(res, base, 'host')"))
  // signing out: every presented session ends, the host-only cookie is deleted and the parent-domain one removed, on both answers
  const out = src('signout')
  assert.match(out, /sessionTokens\(req\?\.headers\.get\('cookie'\)\)/)
  assert.match(out, /for \(const t of tokens\) await deleteSession\(t\)/)
  assert.match(out, /cookieStore\.delete\('dazl_session'\)/)
  assert.equal((out.match(/expireSessionCookies\([^\n]+, base, 'domain'\)/g) ?? []).length, 2)
  assert.match(src('sessions/revoke-all'), /keepCurrent \? NextResponse\.json\(\{ ok: true, revoked \}\) : expireSessionCookies\(/)
})
