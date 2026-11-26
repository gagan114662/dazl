import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

function dryWithCap(cap: string, ...args: string[]) {
  return spawnSync(process.execPath, [
    '--experimental-strip-types', 'scripts/matrix-local.mts', '--dry', '--matrix', '../bench/prompts.json', ...args,
  ], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      MATRIX_ENV_FILE: '',
      TINYFISH_API_KEY: 'dry-fixture',
      MATRIX_ANTHROPIC_KEY: 'dry-fixture',
      MATRIX_APOLLO_KEY: 'dry-fixture',
      APOLLO_CREDIT_CAP: cap,
    },
  })
}

const dry = (...args: string[]) => dryWithCap('50', ...args)

test('matrix refuses Apollo without both explicit opt-ins', () => {
  const contactsOnly = dry('--contacts')
  assert.equal(contactsOnly.status, 0, contactsOnly.stderr)
  assert.match(contactsOnly.stdout, /Apollo off/)
  const budgetOnly = dry('--apollo-budget', '2')
  assert.equal(budgetOnly.status, 2)
  assert.match(budgetOnly.stderr, /requires --contacts/)
  assert.equal(dry('--contacts', '--apollo-budget', '1.5').status, 2)
  assert.equal(dryWithCap('51', '--contacts', '--apollo-budget', '2').status, 2)
  const both = dry('--contacts', '--apollo-budget', '2')
  assert.equal(both.status, 0, both.stderr)
  assert.match(both.stdout, /Apollo budget 2/)
})

test('matrix dry mode reports the bounded call count from an evidence snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apollo-dry-'))
  try {
    const dbPath = join(dir, 'ledger.sqlite')
    new Database(dbPath).close()
    const input = join(dir, 'scan.json')
    const evidence = { first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
      dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published' }
    writeFileSync(input, JSON.stringify({ tenantId: 'tenant', scanId: 'scan', scanLimit: 1, candidates: [
      { leadId: 'eligible', evidence },
      { leadId: 'eligible', evidence },
      { leadId: 'held', evidence: { ...evidence, otherwiseReady: false } },
    ] }))
    const result = dry('--contacts', '--apollo-budget', '2', '--apollo-plan-db', dbPath, '--apollo-plan-input', input)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Apollo calls planned: 1/)
    const db = new Database(dbPath, { readonly: true })
    try {
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'apollo_credit_ledger'").get(), undefined)
    } finally { db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
