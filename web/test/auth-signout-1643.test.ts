// #1643: signing out with the app's button (a plain form post) landed on a blank page showing {"ok":true}. The route now
// answers a browser form post with a redirect home, and a scripted call (Settings, after deleting an account) with JSON as before.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { SIGNED_OUT_PATH, signoutRedirects } from '../lib/auth-signout.ts'

const h = (o: Record<string, string>) => new Headers(o)

test('#1643 a browser form post is redirected; a scripted JSON call is not', () => {
  assert.equal(signoutRedirects(h({ 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml' })), true, 'the Sign out form')
  assert.equal(signoutRedirects(h({ 'content-type': 'application/x-www-form-urlencoded' })), true)
  assert.equal(signoutRedirects(h({ 'content-type': 'multipart/form-data; boundary=x' })), true)
  assert.equal(signoutRedirects(h({ accept: 'text/html' })), true, 'a navigation with no body')
  assert.equal(signoutRedirects(h({ 'content-type': 'application/json', accept: '*/*' })), false, 'Settings: fetch with a JSON body')
  assert.equal(signoutRedirects(h({ 'content-type': 'application/json', accept: 'text/html' })), false)
  assert.equal(signoutRedirects(h({ accept: '*/*' })), false, 'a bare fetch')
  assert.equal(signoutRedirects(null), false, 'a call with no request (tests)')
  assert.equal(SIGNED_OUT_PATH, '/')
})

test('#1643 the route uses that rule with a 303, after the session is deleted; the app button is still a form post to it', () => {
  const route = readFileSync(new URL('../app/api/auth/signout/route.ts', import.meta.url), 'utf8')
  assert.match(route, /signoutRedirects\(req\.headers\)\) return NextResponse\.redirect\(new URL\(SIGNED_OUT_PATH, [^)]+\), 303\)/)
  assert.ok(route.indexOf('deleteSession(') < route.indexOf('signoutRedirects('), 'signed out first, then sent home')
  assert.ok(route.indexOf("cookieStore.delete('dazl_session')") < route.indexOf('signoutRedirects('))
  assert.match(readFileSync(new URL('../app/app/layout.tsx', import.meta.url), 'utf8'), /<form action="\/api\/auth\/signout" method="POST"/)
})
