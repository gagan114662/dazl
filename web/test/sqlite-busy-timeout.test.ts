import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const check = `
  import { getDb } from './lib/db/client.ts'
  import { getAuthDb } from './lib/db/sqlite-store.ts'
  const app = await getDb()
  const raw = getAuthDb()
  console.log(JSON.stringify([await app.get('PRAGMA busy_timeout'), raw.pragma('busy_timeout', { simple: true })]))
`

function openApp(timeout: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-timeout-'))
  const env = { ...process.env, DB_PATH: join(dir, 'app.db') }
  delete env.DATABASE_URL
  if (timeout === undefined) delete env.DAZL_SQLITE_BUSY_TIMEOUT_MS
  else env.DAZL_SQLITE_BUSY_TIMEOUT_MS = timeout
  try {
    return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', check], {
      cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 15_000,
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('both application SQLite accessors share the configured busy timeout', () => {
  for (const [value, expected] of [[undefined, 5000], ['125', 125], ['0', 0]] as const) {
    const result = openApp(value)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), [{ timeout: expected }, expected])
  }
})

test('invalid SQLite busy timeout is rejected before opening the store', () => {
  for (const value of ['-1', '1.5', '2147483648']) {
    const result = openApp(value)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /DAZL_SQLITE_BUSY_TIMEOUT_MS/)
  }
})
