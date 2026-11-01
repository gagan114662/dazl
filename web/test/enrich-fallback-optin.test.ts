// #382: the Apollo -> PDL fallback opt-in must stay an explicit, off-by-default, tenant-scoped toggle. A PDL key
// saved under the original wording ("Used only when no Apollo key is saved") is not consent to paid fallback
// credits, so the route, the panel copy and the store must never let saving a key imply the fallback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const route = readFileSync(new URL('../app/api/settings/enrichment/route.ts', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../app/app/settings/enrichment-panel.tsx', import.meta.url), 'utf8')
const store = readFileSync(new URL('../lib/connectors/store.ts', import.meta.url), 'utf8')

test('route: the fallback toggle is separate from keys and the flag is returned on GET', () => {
  assert.ok(route.includes("typeof body.fallback === 'boolean'"), 'POST accepts {fallback: boolean}')
  assert.ok(route.includes('writeEnrichFallback(db, user.tenantId, body.fallback)'), 'toggle writes only the flag, never a key')
  assert.ok(route.includes('readEnrichFallbackEnabled(db, user.tenantId)'), 'GET reports the current flag')
  assert.ok(route.includes("fallback ${body.fallback ? 'opted in' : 'opted out'}"), 'the toggle is audited')
  assert.ok(!/fallback[^\n]*writeCredential|writeCredential[^\n]*fallback/.test(route), 'saving a key never sets the flag')
})
test('panel: opt-in is explicit, default-off, honest about credits, and keeps the PDL-only contract', () => {
  assert.ok(panel.includes("byId['enrich:apollo']?.enabled && byId['enrich:pdl']?.enabled"), 'checkbox only when BOTH keys are connected')
  assert.ok(panel.includes('Off by default'), 'default-off is stated at the control')
  assert.ok(panel.includes('1 of your PDL credits'), 'the paid nature of the fallback is stated at the control')
  assert.ok(panel.includes('Used only when no Apollo key is saved'), 'the original PDL-only contract is preserved')
  assert.ok(panel.includes('act({ fallback: e.target.checked })'), 'the control toggles via the route, not a key write')
})
test('store: the flag row is never a connector or a credential', () => {
  assert.ok(store.includes("connector != 'enrich:fallback'"), 'connectorStatus hides the flag row')
  assert.ok(store.includes('if (!r || !r.ciphertext) return null'), 'empty ciphertext never decrypts into a key')
})
