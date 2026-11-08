// #871: crawl_pages on Postgres itself - the production Db writer records each fetched page with its exact URL
// and own fetch time, the conflict rule makes concurrent re-reads idempotent, and an over-bound URL is refused
// (never truncated into an alias). (The sqlite twin is in crawl-pages-budget-871.test.ts.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'
import { recordCrawlPageDb } from '../lib/connectors/store.ts'

test('crawl_pages PG writer: exact URL + per-page time, idempotent conflict, explicit over-bound refusal', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const a = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  const b = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    await runPgMigrations(a.pool)
    assert.equal(await recordCrawlPageDb(a, 't1', 'j1', 'acme.example', 'https://acme.example/', 200, 1000), true)
    assert.equal(await recordCrawlPageDb(a, 't1', 'j1', 'acme.example', 'https://acme.example/contact', 200, 1002), true, 'the second page carries its own later time')
    // A concurrent re-read of the same page on another connection: exactly one row, the first fetch's time stands.
    const [r1, r2] = await Promise.all([
      recordCrawlPageDb(a, 't1', 'j1', 'acme.example', 'https://acme.example/', 200, 2000),
      recordCrawlPageDb(b, 't1', 'j1', 'acme.example', 'https://acme.example/', 200, 2000),
    ])
    assert.deepEqual([r1, r2], [true, true])
    const rows = await a.all<{ url: string; status: number; fetched_at: number }>('SELECT url, status, fetched_at FROM crawl_pages ORDER BY fetched_at, url')
    assert.equal(rows.length, 2, 'the re-read never duplicates the page')
    assert.deepEqual(rows.map(r => [r.url, r.status, Number(r.fetched_at)]), [
      ['https://acme.example/', 200, 1000],
      ['https://acme.example/contact', 200, 1002],
    ], 'exact URLs with each page’s own fetch time')
    // Exact provenance or none: distinct over-bound URLs are refused, never truncated into one alias row.
    const prefix = 'https://example.test/' + 'a'.repeat(490)
    assert.equal(await recordCrawlPageDb(a, 't1', 'j1', 'example.test', prefix + 'one', 200, 1003), false)
    assert.equal(await recordCrawlPageDb(a, 't1', 'j1', 'example.test', prefix + 'two', 200, 1004), false)
    assert.equal((await a.all<{ c: number }>("SELECT COUNT(*)::int AS c FROM crawl_pages WHERE site = 'example.test'"))[0].c, 0)
  } finally {
    await a.close(); await b.close(); await s.drop()
  }
})
