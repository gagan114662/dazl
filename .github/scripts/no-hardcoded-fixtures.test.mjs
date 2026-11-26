import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectChanges } from './no-hardcoded-fixtures.mjs'

const bench = {
  cases: [{ company: 'Fixture Manufacturing Group', domain: 'fixture-maker.example', query: 'Find manufacturers opening a factory' }],
}
const results = ['Proof: https://observed-buyer.example/evidence']
const product = 'web/lib/discover/guard-example.ts'
const spec = 'web/test/guard-example.test.ts'
const inspect = (path, after, before = '', body = '') => inspectChanges([{ path, before, after }], bench, results, body)
const rules = result => result.errors.map(finding => finding.rule)

test('bench company, domain, and full query cannot enter product literals', () => {
  const after = `const company = 'Fixture Manufacturing Group'
const domain = 'https://fixture-maker.example/team'
const query = 'Find manufacturers opening a factory'
const result = 'https://observed-buyer.example/contact'`
  assert.deepEqual(rules(inspect(product, after)), Array(4).fill('bench-fixture'))
  assert.deepEqual(rules(inspect(product, `const query = 'Find suppliers opening an office'`)), [])
  assert.deepEqual(rules(inspect('web/lib/landing-examples.ts', after)), [])
  assert.deepEqual(rules(inspect(spec, after)), [])
  assert.deepEqual(rules(inspect(product, `const url = 'https://not-fixture-maker.example/contact'`)), [])
})

test('test and CI environment selectors cannot control product behavior', () => {
  assert.deepEqual(rules(inspect(product, `
    if (process.env.NODE_ENV === 'test') shortcut()
    const url = process.env['CI'] ? testUrl : liveUrl
    if (import.meta.env.VITEST) shortcut()
    const skip = process.env.NODE_TEST_CONTEXT && shortcut()
    const { CI: inCi } = process.env
    if (inCi) shortcut()
  `)), Array(5).fill('test-environment'))
  assert.deepEqual(rules(inspect(product, `if (process.env.NODE_ENV === 'production' && process.env.DAZL_FEATURE) run()`)), [])
})

test('test modifiers fail and the gate-check fixtures stay usable', () => {
  const after = `import { test as check } from 'node:test'
check.skip('skipped', () => {})
describe['only']('focused', () => {})
test.todo('unfinished')
test('unfinished by option', { todo: true }, () => {})`
  assert.deepEqual(rules(inspect(spec, after)), Array(4).fill('test-modifier'))
  assert.deepEqual(rules(inspect(spec, `test('normal', () => { assert.equal(body.todo, 1) })`)), [])
  assert.deepEqual(rules(inspect('web/test/fixtures/gate-check/example.test.mjs', after)), [])
})

test('assertion removal and replacement warn, additions and documented changes do not', () => {
  const before = "test('checks status', () => { assert.equal(result.status, 200); assert.deepEqual(result.body, expected) })"
  const weakened = "test('checks status', () => { assert.ok(result.status) })"
  const report = inspect(spec, weakened, before)
  assert.equal(report.warnings.length, 2)
  assert.deepEqual(report.errors, [])
  assert.deepEqual(inspect(spec, before + '\nassert.ok(extra)', before).warnings, [])
  assert.deepEqual(inspect(spec, weakened, before, 'Superseded assertion: exact status and body\nDecision: accepted statuses now share a schema').warnings, [])
  assert.equal(inspect(spec, weakened, before, 'Decision: shared schema').warnings.length, 2)
})

test('new benchmark results are checked against unchanged product files', () => {
  const source = "const website = 'https://observed-buyer.example/team'"
  assert.deepEqual(rules(inspectChanges([{ path: product, before: source, after: source }], bench, results, '', bench, [])),
    ['bench-fixture'])
  assert.deepEqual(rules(inspectChanges([{ path: product, before: source, after: source }], bench, results, '', bench, results)), [])
})

test('a source filename cited in a benchmark report is distinct from a bare domain', () => {
  const report = ['The reader uses lib/outreach/read-provider.ts. Published source: buyer-company.org']
  const after = "import { read } from '../outreach/read-provider.ts'; const origin = 'buyer-company.org'"
  const result = inspectChanges([{ path: product, after }], bench, report)
  assert.deepEqual(result.errors.map(finding => finding.identity), ['buyer-company.org'])
})
