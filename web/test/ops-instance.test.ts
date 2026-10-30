// lib/ops/instance.ts: the instance id and store backend /api/health reports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dbBackend, instanceId } from '../lib/ops/instance.ts'

test('instance id: DAZL_INSTANCE_ID when well-formed, else one random id per process', () => {
  assert.equal(instanceId({ DAZL_INSTANCE_ID: 'app-2.eu_west' }), 'app-2.eu_west')
  const random = instanceId({})
  assert.match(random, /^[a-f0-9]{12}$/)
  assert.equal(instanceId({}), random, 'stable for the life of the process')
  // anything that could carry more than an id is ignored, never echoed
  for (const bad of ['', 'a b', 'x'.repeat(65), '<script>', 'host:1234', 'ünicode']) assert.equal(instanceId({ DAZL_INSTANCE_ID: bad }), random, bad)
})

test('db backend: postgres exactly when DATABASE_URL is set (the store getDb() opens)', () => {
  assert.equal(dbBackend({ DATABASE_URL: 'postgres://u@db.internal/app' }), 'postgres')
  assert.equal(dbBackend({}), 'sqlite')
  assert.equal(dbBackend({ DATABASE_URL: '' }), 'sqlite')
})
