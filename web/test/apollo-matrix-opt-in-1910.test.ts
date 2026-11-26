import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function dry(...args: string[]) {
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
      APOLLO_CREDIT_CAP: '75',
    },
  })
}

test('matrix refuses Apollo without both explicit opt-ins', () => {
  const contactsOnly = dry('--contacts')
  assert.equal(contactsOnly.status, 0, contactsOnly.stderr)
  assert.match(contactsOnly.stdout, /Apollo off/)
  const budgetOnly = dry('--apollo-budget', '2')
  assert.equal(budgetOnly.status, 2)
  assert.match(budgetOnly.stderr, /requires --contacts/)
  assert.equal(dry('--contacts', '--apollo-budget', '1.5').status, 2)
  const both = dry('--contacts', '--apollo-budget', '2')
  assert.equal(both.status, 0, both.stderr)
  assert.match(both.stdout, /Apollo budget 2/)
})
