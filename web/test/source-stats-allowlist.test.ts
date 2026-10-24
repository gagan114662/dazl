import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SearchTrace, summarizeTrace, writeSourceStats, sourceStats } from '../lib/search/trace.ts'

const mkdb = () => {
  const db = new Database(':memory:'); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE scan_jobs (id TEXT PRIMARY KEY, user_id TEXT)')
  db.prepare('INSERT INTO scan_jobs VALUES (?,?)').run('jo', 'owner-ohio'); db.prepare('INSERT INTO scan_jobs VALUES (?,?)').run('jx', 'owner-other')
  return db
}
const stats = () => { const t = new SearchTrace(); t.search({ query: 'q text', attempted: true, outcome: 'ok', hits: ['https://a.example/x'] }); return summarizeTrace(t) }
const tables = (db: Database.Database) => (db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='scan_source_stats'").get() as { n: number }).n

test('the global flag alone writes nothing for anyone: an empty or missing allowlist means nobody', () => {
  for (const env of [{ DAZL_SOURCE_STATS: '1' }, { DAZL_SOURCE_STATS: '1', DAZL_SOURCE_STATS_USERS: '' }, { DAZL_SOURCE_STATS: '1', DAZL_SOURCE_STATS_USERS: ' , ' }]) {
    const db = mkdb()
    assert.equal(writeSourceStats(db, 'jo', 1, 'search:tinyfish', stats(), env), false)
    assert.equal(tables(db), 0)
  }
})

test('an allowlisted owner is recorded; another owner is denied with no table effect when only the allowlisted one is named', () => {
  const env = { DAZL_SOURCE_STATS: '1', DAZL_SOURCE_STATS_USERS: 'owner-ohio' }
  const dbx = mkdb()
  assert.equal(writeSourceStats(dbx, 'jx', 1, 'search:tinyfish', stats(), env), false)
  assert.equal(tables(dbx), 0); assert.equal(sourceStats(dbx, 'owner-other', 'jx'), null)
  const db = mkdb()
  assert.equal(writeSourceStats(db, 'jo', 1, 'search:tinyfish', stats(), env), true)
  assert.equal(sourceStats(db, 'owner-ohio', 'jo')!.length, 1)
  assert.equal(writeSourceStats(db, 'jx', 1, 'search:tinyfish', stats(), env), false)
  assert.equal((db.prepare('SELECT count(*) n FROM scan_source_stats').get() as { n: number }).n, 1)
})

test('the allowlist does nothing without the global flag, matches exact ids only (no substring) and a missing job writes nothing', () => {
  const db = mkdb()
  assert.equal(writeSourceStats(db, 'jo', 1, 'search:tinyfish', stats(), { DAZL_SOURCE_STATS_USERS: 'owner-ohio' }), false)
  assert.equal(writeSourceStats(db, 'jo', 1, 'search:tinyfish', stats(), { DAZL_SOURCE_STATS: '1', DAZL_SOURCE_STATS_USERS: 'owner-oh' }), false)
  assert.equal(writeSourceStats(db, 'nojob', 1, 'search:tinyfish', stats(), { DAZL_SOURCE_STATS: '1', DAZL_SOURCE_STATS_USERS: 'owner-ohio' }), false)
  assert.equal(tables(db), 0)
})
