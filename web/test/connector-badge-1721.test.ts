// #1721 (Quest on #1917, 2026-11-26): the Connectors badge decided BEHAVIORALLY. The production read path is
// session-worker (ops install): src/fetchers.ts CAPABILITY marks x, reddit, instagram, bilibili and linkedin
// supported (real fetchers); facebook and xiaohongshu are gated stubs. The app mirrors CAPABILITY via
// PLATFORM_SUPPORT (pinned equal by advanced-capability-sync.test.ts), so p.supported is the session-ready truth.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CHANNELS, connectorBadge } from '../lib/channels.ts'

const ch = (id: string) => CHANNELS.find(c => c.id === id)!

test('#1721 the worker badge: Not available yet exactly when the platform row is missing, unsupported, or disallowed', () => {
  const reddit = ch('reddit')
  // case 1: row present, supported, connectors on - the badge promises the session the row below delivers
  assert.equal(connectorBadge(reddit, { supported: true, allowed: true }), 'Needs your session')
  // case 2: connectors off (flag or worker off) - the row says "Not available on dazl yet."; the badge agrees
  assert.equal(connectorBadge(reddit, { supported: true, allowed: false }), 'Not available yet')
  // case 3: the platform row is missing entirely
  assert.equal(connectorBadge(reddit, undefined), 'Not available yet')
  // unbuilt adapter (facebook): unavailable even present + allowed
  assert.equal(connectorBadge(ch('facebook'), { supported: false, allowed: true }), 'Not available yet')
  // supported platforms the production worker fetches badge session-ready: instagram, linkedin, x
  for (const id of ['instagram', 'linkedin', 'x']) assert.equal(connectorBadge(ch(id), { supported: true, allowed: true }), 'Needs your session', id)
  // non-worker statuses are untouched
  assert.equal(connectorBadge(ch('web'), undefined), 'Working', 'a live tier-0 source')
})
