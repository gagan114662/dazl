// The executable evaluation contract (#394): strict validation (missing constraints cannot be silently inferred),
// per-field pass/fail/unknown/contradicted verdicts with evidence, as_of and scorer identity, the four lead tiers,
// unknown != pass with unknowns and contradicted counted as not-validated in the denominators, and byte-level
// determinism of the whole evaluation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { validateContract, evaluateLead, ContractError } from '../lib/evals/contract.ts'
import { loadCase } from '../lib/evals/case.ts'

const CONTRACT_PATH = 'test/fixtures/evals/contract/toronto-office.contract.json'
const LEADS_PATH = 'test/fixtures/evals/contract/toronto-office.leads.json'
const contract = validateContract(JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')))
const leads = JSON.parse(readFileSync(LEADS_PATH, 'utf8'))
const [full, dateless, recruiting, pageConflict] = leads

test('a constraint with no value is rejected - it cannot be silently inferred', () => {
  const broken = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'))
  broken.constraints[0].value = ''
  assert.throws(() => validateContract(broken), ContractError)
  const empty = { ...JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')), constraints: [] }
  assert.throws(() => validateContract(empty), /at least one hard constraint/)
})

test('unknown is not pass: missing outcome keeps the lead actionable, not outcome-qualified', () => {
  const r = evaluateLead(contract, full)
  assert.equal(r.tier, 'actionable_opportunity')
  assert.equal(r.status, 'unknown')
  const outcome = r.verdicts.find(v => v.field === 'outcome.evidence')!
  assert.equal(outcome.status, 'unknown')
  assert.equal(r.unknown_rate! > 0, true)
  assert.ok(r.validated_rate! < 1)   // unknowns sit in the denominator as not-validated
})

test('a missing event date blocks even source_checked and stays unknown', () => {
  const r = evaluateLead(contract, dateless)
  assert.equal(r.tier, null)
  assert.equal(r.status, 'unknown')
  assert.equal(r.verdicts.find(v => v.field === 'event.date_real')!.status, 'unknown')
})

test('a recruiting-inbox contact fails contact.usable and caps the tier at plausible_buyer', () => {
  const r = evaluateLead(contract, recruiting)
  assert.equal(r.verdicts.find(v => v.field === 'contact.usable')!.status, 'fail')
  assert.equal(r.tier, 'plausible_buyer')
  assert.equal(r.status, 'fail')
})

test('evidence the cited page contradicts is contradicted - not pass, not merely fail', () => {
  const r = evaluateLead(contract, pageConflict)
  const place = r.verdicts.find(v => v.field === 'place.matches')!
  assert.equal(place.status, 'contradicted')
  assert.equal(r.tier, 'source_checked')        // contradicted blocks plausible_buyer
  assert.equal(r.status, 'fail')                // contradicted counts against the lead
  assert.ok(r.contradicted_rate! > 0)
  assert.ok(place.rationale.includes('Montreal'))
})

test('every verdict carries evidence pointers, the contract as_of and the scorer identity', () => {
  const r = evaluateLead(contract, full)
  for (const v of r.verdicts) {
    assert.equal(v.as_of, contract.as_of)
    assert.deepEqual(v.scorer, contract.scorer)
    assert.ok(Array.isArray(v.evidence))
    assert.ok(v.rationale.length > 0)
  }
})

test('evaluation is byte-deterministic: the script produces the committed golden', () => {
  // report mode exits 1 when a lead fails by design; the golden still must match byte-for-byte
  const run = () => spawnSync('node', ['--experimental-strip-types', 'scripts/eval-contract.mts', CONTRACT_PATH, LEADS_PATH], { encoding: 'utf8' }).stdout
  const a = run(), b = run()
  assert.equal(a, b)
  assert.equal(a, readFileSync('test/fixtures/evals/contract/toronto-office.expected.json', 'utf8'))
})

test('a case naming its contract shares the validated artifact; a broken reference fails the load', () => {
  const abs = (p: string) => new URL(p, import.meta.url).pathname
  const withContract = { ...JSON.parse(readFileSync('test/fixtures/evals/cases/scan-toronto-office-traps.case.json', 'utf8')), world: abs('fixtures/evals/worlds/scan-toronto-office-traps.world.json'), contract: abs('fixtures/evals/contract/toronto-office.contract.json') }
  const dir = mkdtempSync('/tmp/case-contract-')
  writeFileSync(`${dir}/c.case.json`, JSON.stringify(withContract))
  const { contract } = loadCase(`${dir}/c.case.json`)
  assert.equal(contract!.id, 'eval-contract-toronto-office-v1')
  const broken = { ...withContract, contract: `${dir}/does-not-exist.contract.json` }
  writeFileSync(`${dir}/b.case.json`, JSON.stringify(broken))
  assert.throws(() => loadCase(`${dir}/b.case.json`))
  const invalid = { ...withContract, contract: abs('fixtures/evals/contract/toronto-office.leads.json') }
  writeFileSync(`${dir}/i.case.json`, JSON.stringify(invalid))
  assert.throws(() => loadCase(`${dir}/i.case.json`), ContractError)
})
