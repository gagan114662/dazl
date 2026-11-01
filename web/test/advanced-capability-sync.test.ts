// The app and the session worker are separate deployables that must agree on what the worker can
// fetch: if one side adds support without the other, this fails before a tenant is offered a
// session flow the worker cannot use, or a working platform is hidden as unavailable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ADV_PLATFORMS, PLATFORM_SUPPORT } from '../lib/advanced/config.ts'
import { CAPABILITY } from '../../session-worker/src/fetchers.ts'

test('app PLATFORM_SUPPORT and worker CAPABILITY agree on every platform', () => {
  for (const p of ADV_PLATFORMS) {
    const app = PLATFORM_SUPPORT[p]
    const worker = CAPABILITY[p]
    assert.ok(worker, `worker CAPABILITY is missing ${p}`)
    assert.equal(app.supported, worker.supported, `${p}: app says ${app.supported}, worker says ${worker.supported}`)
    if (!app.supported) {
      assert.ok(app.reason && app.reason.length > 10, `${p}: the app owes the UI a real reason`)
      assert.ok(worker.reason && worker.reason.length > 10, `${p}: the worker owes the app a real reason`)
    }
  }
  assert.deepEqual(Object.keys(CAPABILITY).sort(), [...ADV_PLATFORMS].sort(), 'the worker declares exactly the app platforms')
})
