// #1686 (Quest, production, 2026-11-24): after a Google sign-in as one account and a password sign-in as another in the same browser,
// Settings showed one account, the dashboard the other, and Sign out left the browser signed in. Production records showed no shared
// data: each account owned only its own workspace. The cause was the cookie: Google sign-in set dazl_session for the parent domain,
// a password sign-in set it for the host only, the browser kept both, and Sign out ended only one of the two sessions.
// These are the pure rules; the real proxy and the real sign-out route are exercised in test/helpers/proxy-gate-runtime.mts and
// test/helpers/session-routes-runtime.mts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_FIX_COOKIE, oldDomainSessionExpiry, sessionTokens, shouldDropOldSessionCookie } from '../lib/session-cookie.ts'
import { canonicalPageUrl } from '../lib/canonical-host.ts'

test('#1686 every session the browser presents is seen, each once, whatever else is in the Cookie header', () => {
  assert.deepEqual(sessionTokens('dazl_session=aaa; theme=dark; dazl_session=bbb'), ['aaa', 'bbb'])
  assert.deepEqual(sessionTokens('other=1;dazl_session=aaa;dazl_session=aaa'), ['aaa'])
  assert.deepEqual(sessionTokens('dazl_session_x=nope; xdazl_session=nope; dazl_session='), [])
  assert.deepEqual(sessionTokens(null), [])
  assert.deepEqual(sessionTokens(''), [])
})

test('#1686 the old parent-domain cookie is removed by one line, only where there is one, and only when two sessions are presented', () => {
  assert.equal(oldDomainSessionExpiry('https://dazl.ai'), 'dazl_session=; Domain=.dazl.ai; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax')
  assert.equal(oldDomainSessionExpiry('http://localhost:3000'), null, 'localhost has no parent-domain form')
  assert.equal(oldDomainSessionExpiry('http://127.0.0.1:3000'), null)
  const two = 'dazl_session=old; dazl_session=new'
  assert.equal(shouldDropOldSessionCookie(two, 'GET', 'https://dazl.ai'), true)
  assert.equal(shouldDropOldSessionCookie('dazl_session=only', 'GET', 'https://dazl.ai'), false, 'one session: nothing to remove')
  assert.equal(shouldDropOldSessionCookie('dazl_session=x; dazl_session=x', 'GET', 'https://dazl.ai'), false, 'the same session twice is one session')
  assert.equal(shouldDropOldSessionCookie(two, 'POST', 'https://dazl.ai'), false, 'only a page load is answered with a redirect')
  assert.equal(shouldDropOldSessionCookie(two, 'GET', 'http://localhost:3000'), false)
  assert.equal(shouldDropOldSessionCookie(two, 'GET', undefined), false)
  assert.equal(shouldDropOldSessionCookie(`${two}; ${SESSION_FIX_COOKIE}=1`, 'GET', 'https://dazl.ai'), false, 'already sent the removal: never a second redirect, so no loop')
})

// Review of PR #1688: the site answers on www too, and a host-only cookie set on www is not replaced by a sign-in on the bare hostname.
test('#1686 a page asked for on www is sent to the same path on the site\'s own hostname; API calls and other hosts are left alone', () => {
  const base = 'https://dazl.ai'
  assert.equal(canonicalPageUrl('www.dazl.ai', '/sign-in?next=%2Fapp', 'GET', base), 'https://dazl.ai/sign-in?next=%2Fapp')
  assert.equal(canonicalPageUrl('WWW.dazl.ai:443', '/', 'HEAD', base), 'https://dazl.ai/')
  assert.equal(canonicalPageUrl('www.dazl.ai', '/app/leads', 'GET', base), 'https://dazl.ai/app/leads')
  assert.equal(canonicalPageUrl('dazl.ai', '/sign-in', 'GET', base), null, 'already on the site\'s own hostname')
  assert.equal(canonicalPageUrl('www.dazl.ai', '/api/auth/signin', 'POST', base), null, 'a page open on www still posts to its own origin')
  assert.equal(canonicalPageUrl('www.dazl.ai', '/api/health', 'GET', base), null)
  assert.equal(canonicalPageUrl('www.dazl.ai', '/_next/static/chunks/x.js', 'GET', base), null)
  assert.equal(canonicalPageUrl('www.dazl.ai', '/sign-up', 'POST', base), null, 'only a page load is redirected')
  assert.equal(canonicalPageUrl('www.evil.example', '/sign-in', 'GET', base), null, 'never to or from another site')
  assert.equal(canonicalPageUrl('www.dazl.ai', '/sign-in', 'GET', undefined), null)
  assert.equal(canonicalPageUrl(null, '/sign-in', 'GET', base), null)
})
