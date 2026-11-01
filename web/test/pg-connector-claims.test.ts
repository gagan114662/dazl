// #382: the connector_claims PRIMARY KEY is the race decider on Postgres itself - two separate connections claiming
// the same paid lookup concurrently produce exactly ONE winner; the loser reads the outcome and never repays.
// (The sqlite twin is exercised by the enrich waterfall's double-run leg; this file is the engine's own proof.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'
import { writeTryReserve, writeSettleClaim } from '../lib/connectors/store.ts'

test('connector_claims: two PG connections racing one lookup - exactly one claim wins; terminal replays free; transient holds', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const a = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  const b = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    await runPgMigrations(a.pool)
    const key = { tenantId: 't1', connector: 'enrich:pdl', jobId: 'j1', lookup: 'people Acme (acme.com)', status: 'reserved', results: 0 }
    const [r1, r2] = await Promise.all([writeTryReserve(a, key), writeTryReserve(b, key)])
    const wins = [r1, r2].filter(r => 'id' in r)
    const losses = [r1, r2].filter(r => 'prior' in r)
    assert.equal(wins.length, 1, 'exactly one connection claims the lookup')
    assert.equal(losses.length, 1, 'the other fails closed')
    assert.deepEqual(losses[0], { prior: 'uncertain' }, 'a reserved claim is a possible charge: never repaid')
    await writeSettleClaim(a, key, (wins[0] as { id: string }).id, 'ok', 2)
    assert.deepEqual(await writeTryReserve(b, key), { prior: 'ok' }, 'a terminal outcome replays free')
    const key2 = { ...key, lookup: 'people Retry (retry.example)' }
    const w = await writeTryReserve(a, key2)
    assert.ok('id' in w)
    await writeSettleClaim(a, key2, (w as { id: string }).id, 'rate_limited', 0) // even a received 429 HOLDS: the tenant's plan is not verifiable, so no outcome without data ever frees the lookup
    { // an UNCERTAIN settle (no known response) keeps the claim held on PG as on sqlite: the replay never re-bills
      const key3 = { ...key, lookup: 'people Held Co (held.example)' }
      const w3 = await writeTryReserve(a, key3)
      await writeSettleClaim(a, key3, (w3 as { id: string }).id, 'error', 0)
      const again = await writeTryReserve(a, key3)
      assert.deepEqual(again, { prior: 'uncertain' }, 'a possibly-charged attempt stays held for review on PG')
    }
    const r4 = await writeTryReserve(b, key2)
    assert.deepEqual(r4, { prior: 'uncertain' }, 'a transient outcome HOLDS the claim: no automatic retry, never a rebill')
  } finally { await a.close(); await b.close(); await s.drop() }
})
