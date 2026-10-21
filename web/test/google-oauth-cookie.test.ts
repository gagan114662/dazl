import test from 'node:test'
import assert from 'node:assert/strict'
import { cookieDomain } from '../lib/auth-google.ts'

test('cookieDomain spans the parent domain so www-start and apex-callback share cookies', () => {
  assert.equal(cookieDomain('https://dazl.ai'), '.dazl.ai')
  assert.equal(cookieDomain('https://app.dazl.ai'), '.app.dazl.ai')
  assert.equal(cookieDomain('http://localhost:3000'), undefined)
  assert.equal(cookieDomain('http://127.0.0.1:3000'), undefined)
  assert.equal(cookieDomain('not a url'), undefined)
})
