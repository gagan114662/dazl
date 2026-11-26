// #382: the Apollo -> PDL fallback opt-in must stay an explicit, off-by-default, tenant-scoped toggle. A PDL key
// saved under the original wording ("Used only when no Apollo key is saved") is not consent to paid fallback
// credits, so the route, the panel copy and the store must never let saving a key imply the fallback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const route = readFileSync(new URL('../app/api/settings/enrichment/route.ts', import.meta.url), 'utf8')
const store = readFileSync(new URL('../lib/connectors/store.ts', import.meta.url), 'utf8')

test('route: the fallback toggle is separate from keys and the flag is returned on GET', () => {
  assert.ok(route.includes("typeof body.fallback === 'boolean'"), 'POST accepts {fallback: boolean}')
  assert.ok(route.includes('writeEnrichFallback(db, user.tenantId, body.fallback)'), 'toggle writes only the flag, never a key')
  assert.ok(route.includes('readEnrichFallbackEnabled(db, user.tenantId)'), 'GET reports the current flag')
  assert.ok(route.includes("fallback ${body.fallback ? 'opted in' : 'opted out'}"), 'the toggle is audited')
  assert.ok(!/fallback[^\n]*writeCredential|writeCredential[^\n]*fallback/.test(route), 'saving a key never sets the flag')
})
test('store: the flag row is never a connector or a credential', () => {
  assert.ok(store.includes("connector != 'enrich:fallback'"), 'connectorStatus hides the flag row')
  assert.ok(store.includes('if (!r || !r.ciphertext) return null'), 'empty ciphertext never decrypts into a key')
})

