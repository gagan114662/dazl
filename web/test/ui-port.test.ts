// The UI legs drive Chrome against a random loopback port. Chrome refuses a list of "unsafe" ports with
// net::ERR_UNSAFE_PORT (Chromium kRestrictedPorts), so a draw that lands on one flakes the whole leg - seen
// live on the 1441a4d5 release gate (browser job: 3659 at leads-research-review.ui.mjs). The fix is the
// shared picker (test/helpers/ui-port.mjs), which never draws a restricted port; this test pins both the
// picker and the convention that no UI leg picks its own raw random port again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { pickUiPort, CHROMIUM_RESTRICTED_PORTS } from './helpers/ui-port.mjs'

test('pickUiPort never returns a Chrome-restricted port', () => {
  assert.ok(CHROMIUM_RESTRICTED_PORTS.has(3659), 'the observed blocked port is in the pinned list')
  for (let i = 0; i < 20000; i++) {
    const p = pickUiPort()
    assert.ok(!CHROMIUM_RESTRICTED_PORTS.has(p), `drew restricted port ${p}`)
    assert.ok(p >= 3300 && p < 3800, `out of harness range: ${p}`)
  }
})

test('no UI leg picks its own raw random port; every loopback server uses the shared picker', () => {
  for (const f of readdirSync('test/ui')) {
    if (!f.endsWith('.mjs')) continue
    const src = readFileSync(`test/ui/${f}`, 'utf8')
    assert.ok(!src.includes('3300 + Math.floor(Math.random() * 500)'), `${f}: raw random port draw - use pickUiPort() (test/helpers/ui-port.mjs)`)
    if (src.includes('http://127.0.0.1:${port}')) assert.ok(src.includes("from '../helpers/ui-port.mjs'"), `${f}: loopback server without the shared port picker`)
  }
})
