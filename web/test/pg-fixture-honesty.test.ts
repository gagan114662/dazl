// A 'pg' leg of a route runtime must prove its engine. The failure this guards: setDb(pg) followed by
// setScanDb(fixture) - tenant-route-db.setScanDb calls setDb(sqliteDb(v)), so getDb() silently returned the
// fixture SQLite store and the whole 'pg' leg ran on SQLite while printing a pg marker (billing-e2e,
// billing-events and stripe-endpoint all shipped this once). Two committed rules for every runtime fixture
// that points getDb() at Postgres:
//   1. after the first setDb(pg...) in the file, the only raw-handle call allowed is a trap (setScanDb(null) /
//      trapScanDb()); giving the route a fixture store after that line reintroduces the mask;
//   2. the file carries an engine canary asserting getDb().kind === 'pg' before its pg scenario runs, so a
//      future repoint fails the leg itself, not just this source scan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const HELPERS = new URL('./helpers/', import.meta.url).pathname

test('every Postgres route-runtime fixture traps the raw handle and proves its engine', () => {
  const candidates = readdirSync(HELPERS).filter((f) => f.endsWith('.mts') || f.endsWith('.ts'))
    .map((f) => ({ f, src: readFileSync(HELPERS + f, 'utf8') }))
    .filter((c) => /setDb\(pg/.test(c.src))
  assert.ok(candidates.length >= 5, `expected the known pg fixtures, found ${candidates.length}`)
  for (const cand of candidates) {
    const f = cand.f, src = cand.src
    const after = src.slice(src.search(/setDb\(pg/))
    const leak = after.match(/setScanDb\((?!null)/)
    assert.equal(leak, null, `${f}: setScanDb(fixture) after setDb(pg) repoints getDb() at SQLite - trap the raw handle instead`)
    assert.ok(src.includes("'engine canary"), `${f}: missing the engine canary (assert getDb().kind === 'pg' before the pg scenario)`)
  }
})
