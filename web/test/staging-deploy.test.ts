// ops/staging/deploy.sh refuses an env file that is not a staging one (docs/STAGING.md):
// - DAZL_ENV must be staging, and DATABASE_URL must be unset;
// - DB_PATH is never production's database, compared by canonical path (symlinks and .. resolved), by the
//   production database's directory, and by device:inode (a hard link);
// - Stripe test mode only, the staging URL, and no Google credentials.
// Production's DB path must be given (PROD_DB_PATH or PROD_ENV_FILE), or the check fails closed. Only the --check-env
// mode runs here: nothing is cloned, built or restarted. The full deploy is exercised by ops/staging/e2e-test.sh.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../ops/staging/deploy.sh', import.meta.url))
const example = readFileSync(new URL('../../ops/staging/env.example', import.meta.url), 'utf8')
const dir = mkdtempSync(path.join(tmpdir(), 'staging-env-'))
// a production database and a staging directory, with an alias (symlink) and a hard link of production's file
const prodDir = path.join(dir, 'prod-data'), stagingDir = path.join(dir, 'staging-data')
mkdirSync(prodDir); mkdirSync(stagingDir)
const prodDb = path.join(prodDir, 'app.db')
writeFileSync(prodDb, 'production')
symlinkSync(prodDir, path.join(dir, 'alias'))
linkSync(prodDb, path.join(stagingDir, 'hardlink.db'))
const prodEnv = path.join(dir, 'prod.env'); writeFileSync(prodEnv, `DB_PATH=${prodDb}\n`)
const check = (body: string, prod: Record<string, string> = { PROD_DB_PATH: prodDb }) => {
  const f = path.join(dir, `env${Math.random().toString(36).slice(2)}`)
  writeFileSync(f, body)
  const r = spawnSync('bash', [script, '--check-env', f], { encoding: 'utf8', env: { PATH: process.env.PATH, ...prod } as unknown as NodeJS.ProcessEnv })
  return { ok: r.status === 0, out: r.stdout + r.stderr }
}
const good = example.replace('DAZL_MASTER_KEY=', 'DAZL_MASTER_KEY=AAAA').replace('STRIPE_SECRET_KEY=sk_test_', 'STRIPE_SECRET_KEY=sk_test_abc')
  .replace('DB_PATH=/var/lib/dazl-staging/app.db', `DB_PATH=${stagingDir}/app.db`)
const db = (p: string) => good.replace(`DB_PATH=${stagingDir}/app.db`, `DB_PATH=${p}`)

test('deploy.sh is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', script]).status, 0)
})

test('a staging env file passes; anything that could touch production or send for real is refused', () => {
  assert.deepEqual(check(good), { ok: true, out: 'env ok\n' })
  assert.deepEqual(check(good, { PROD_ENV_FILE: prodEnv }), { ok: true, out: 'env ok\n' }, 'production path read from its env file')
  // production's path unknown, or its env file unreadable: fail closed
  assert.match(check(good, {}).out, /production's DB_PATH is unknown/)
  assert.equal(check(good, {}).ok, false)
  assert.equal(check(good, { PROD_ENV_FILE: path.join(dir, 'missing.env') }).ok, false)
  // the same file reached by another name
  for (const [p, why] of [
    [prodDb, /is the production database/],
    [path.join(dir, 'alias', 'app.db'), /is the production database/],                   // through a symlinked directory
    [path.join(stagingDir, '..', 'prod-data', 'app.db'), /is the production database/], // through ..
    [path.join(dir, 'alias', 'other.db'), /inside the production database's directory/],
    [path.join(prodDir, 'sub', 'x.db'), /inside the production database's directory/],
    [path.join(stagingDir, 'hardlink.db'), /same file/],                                  // a hard link of production's file
    [dir + '/app.db', /production's database is inside/],                               // a parent of production's directory
    ['relative/app.db', /must be absolute/],
  ] as const) {
    const r = check(db(p))
    assert.equal(r.ok, false, p); assert.match(r.out, why)
  }
  const refused: [string, RegExp][] = [
    [good.replace('DAZL_ENV=staging', 'DAZL_ENV=production'), /DAZL_ENV must be staging/],
    [good.replace(/^DAZL_ENV=staging\n/m, ''), /DAZL_ENV must be staging/],
    [good.replace(/^DB_PATH=.*\n/m, ''), /DB_PATH is required/],
    [good + 'DATABASE_URL=postgres://u:p@db.example.test/dazl\n', /no DATABASE_URL/],
    [good.replace('STRIPE_SECRET_KEY=sk_test_abc', 'STRIPE_SECRET_KEY=sk_live_abc'), /test-mode key/],
    [good.replace('STRIPE_SECRET_KEY=sk_test_abc', 'STRIPE_SECRET_KEY="rk_live_abc"'), /test-mode key/],
    [good.replace('PUBLIC_BASE_URL=https://staging.dazl.ai', 'PUBLIC_BASE_URL=https://dazl.ai'), /staging URL/],
    [good + 'GOOGLE_CLIENT_SECRET=abc\n', /no Google credentials/],
  ]
  for (const [body, why] of refused) {
    const r = check(body)
    assert.equal(r.ok, false, String(why))
    assert.match(r.out, why)
    assert.ok(!r.out.includes('sk_live_abc') && !r.out.includes('AAAA'), 'values are never printed')
  }
})
