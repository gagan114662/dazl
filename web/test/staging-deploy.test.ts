// ops/staging/deploy.sh refuses an env file that is not a staging one (docs/STAGING.md): DAZL_ENV must be staging,
// DB_PATH never production's database, Stripe test mode only, the staging URL, and no Google credentials. Only the
// --check-env mode runs here: nothing is cloned, built or restarted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../ops/staging/deploy.sh', import.meta.url))
const example = readFileSync(new URL('../../ops/staging/env.example', import.meta.url), 'utf8')
const dir = mkdtempSync(path.join(tmpdir(), 'staging-env-'))
const check = (body: string) => {
  const f = path.join(dir, `env${Math.random().toString(36).slice(2)}`)
  writeFileSync(f, body)
  const r = spawnSync('bash', [script, '--check-env', f], { encoding: 'utf8', env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv })
  return { ok: r.status === 0, out: r.stdout + r.stderr }
}
const good = example.replace('DAZL_MASTER_KEY=', 'DAZL_MASTER_KEY=AAAA').replace('STRIPE_SECRET_KEY=sk_test_', 'STRIPE_SECRET_KEY=sk_test_abc')

test('deploy.sh is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', script]).status, 0)
})

test('a staging env file passes; anything that could touch production or send for real is refused', () => {
  assert.deepEqual(check(good), { ok: true, out: 'env ok\n' })
  const refused: [string, RegExp][] = [
    [good.replace('DAZL_ENV=staging', 'DAZL_ENV=production'), /DAZL_ENV must be staging/],
    [good.replace(/^DAZL_ENV=staging\n/m, ''), /DAZL_ENV must be staging/],
    [good.replace('DB_PATH=/var/lib/dazl-staging/app.db', 'DB_PATH=/var/lib/dazl-next/app.db'), /production database/],
    [good.replace('DB_PATH=/var/lib/dazl-staging/app.db', 'DB_PATH=/var/lib/dazl-next/other.db'), /production data directory/],
    [good.replace('DB_PATH=/var/lib/dazl-staging/app.db', 'DB_PATH=/home/app/dazl-data/app.db'), /production data directory/],
    [good.replace(/^DB_PATH=.*\n/m, ''), /DB_PATH is required/],
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
