import assert from 'node:assert/strict'
import https from 'node:https'
import { test } from 'node:test'
import { safeGet } from '../lib/sources/http.ts'

test('public source transport refuses nonpublic literal hosts before starting a socket', async t => {
  const request = t.mock.method(https, 'request', () => { throw new Error('test has no transport') })
  for (const hostname of ['127.0.0.1', '[::1]']) {
    assert.equal(await safeGet(`https://${hostname}/`), null)
  }
  assert.equal(request.mock.callCount(), 0)
})
