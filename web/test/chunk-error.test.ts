import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChunkLoadError } from '../lib/chunk-error.ts'

test('chunk-load failures from webpack and turbopack are recognised', () => {
  const named = new Error('Loading chunk 123 failed.'); named.name = 'ChunkLoadError'
  assert.equal(isChunkLoadError(named), true)
  assert.equal(isChunkLoadError(new Error('Failed to load chunk /_next/static/chunks/0sp2f4p8jce6m.js from module 42')), true)
  assert.equal(isChunkLoadError('Loading CSS chunk 7 failed'), true)
})

test('ordinary errors do not trigger a reload', () => {
  assert.equal(isChunkLoadError(new Error('Could not load your emails')), false)
  assert.equal(isChunkLoadError(new TypeError('x is undefined')), false)
  assert.equal(isChunkLoadError(null), false)
  assert.equal(isChunkLoadError(undefined), false)
})
