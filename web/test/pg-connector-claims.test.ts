// #382: the connector_claims PRIMARY KEY is the race decider on Postgres itself - two separate connections claiming
// the same paid lookup concurrently produce exactly ONE winner; the loser reads the outcome and never repays.
// (The sqlite twin is exercised by the enrich waterfall's double-run leg; this file is the engine's own proof.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'
import { writeTryReserve, writeSettleClaim, readOutcomeAsync } from '../lib/connectors/store.ts'

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
    { // the recovery memo lands in the SAME settle as the terminal status, is read back by the replay, and no later settle rewrites it
      const key5 = { ...key, lookup: 'step:org Memo Co (memo.example)' }
      const w5 = await writeTryReserve(a, key5)
      assert.ok('id' in w5)
      const memo = JSON.stringify({ v: 1, domain: 'memo.example' })
      await writeSettleClaim(a, key5, (w5 as { id: string }).id, 'ok', 1, memo)
      const got = await readOutcomeAsync(a, { tenantId: 't1', connector: 'enrich:pdl', jobId: 'j1', lookup: key5.lookup }, { legacyAudit: false })
      assert.deepEqual(got, { prior: 'ok', status: 'ok', memo }, 'memo present == agreement passed == resume allowed')
      await writeSettleClaim(a, key5, (w5 as { id: string }).id, 'ok', 1, JSON.stringify({ v: 1, domain: 'other.example' }))
      const got2 = await readOutcomeAsync(a, { tenantId: 't1', connector: 'enrich:pdl', jobId: 'j1', lookup: key5.lookup }, { legacyAudit: false })
      assert.equal(got2?.memo, memo, 'a terminal memo is immutable (the settle guards on reserved + memo IS NULL)')

      // releaseHeldClaimAsync (the PG twin the retry route needs at cutover): a held claim releases with its
      // lineage audit row; a terminal memo claim refuses and survives.
      const { releaseHeldClaimAsync } = await import('../lib/connectors/store.ts')
      const key6 = { ...key, lookup: 'step:people Memo Co (memo.example)' }
      const w6 = await writeTryReserve(a, key6)
      assert.ok('id' in w6)
      assert.equal(await releaseHeldClaimAsync(a, { tenantId: 't1', connector: 'enrich:pdl', jobId: 'j1', lookup: key6.lookup }, 'owner retry: test'), true, 'the held claim releases')
      assert.equal(await readOutcomeAsync(a, { tenantId: 't1', connector: 'enrich:pdl', jobId: 'j1', lookup: key6.lookup }, { legacyAudit: false }), null, 'the released claim row is gone')
      assert.equal(await releaseHeldClaimAsync(a, { tenantId: 't1', connector: 'enrich:pdl', jobId: 'j1', lookup: key5.lookup }, 'owner retry: test'), false, 'a terminal memo claim refuses release')
      const still = await readOutcomeAsync(a, { tenantId: 't1', connector: 'enrich:pdl', jobId: 'j1', lookup: key5.lookup }, { legacyAudit: false })
      assert.equal(still?.memo, memo, 'the memo survives the refused release')
    }
  } finally { await a.close(); await b.close(); await s.drop() }
})
