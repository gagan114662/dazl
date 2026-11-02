// Offline contract evaluation (#394): score frozen lead evidence against the frozen contract, deterministically.
// Usage:
//   node --experimental-strip-types scripts/eval-contract.mts <contract.json> <leads.json>            # print report
//   node --experimental-strip-types scripts/eval-contract.mts <contract.json> <leads.json> --check <expected.json>
// The report is pure output of the two frozen files and the scorer version: run twice, the bytes are identical.
// Exit 1 when --check mismatches or any lead has a fail/contradicted verdict; exit 2 on invalid input.
import { readFileSync } from 'node:fs'
import { validateContract, evaluateLead, ContractError, type LeadEvidence } from '../lib/evals/contract.ts'

const [contractPath, leadsPath, checkFlag, expectedPath] = process.argv.slice(2)
if (!contractPath || !leadsPath) { console.error('usage: eval-contract.mts <contract.json> <leads.json> [--check expected.json]'); process.exit(2) }
let report: string
try {
  const contract = validateContract(JSON.parse(readFileSync(contractPath, 'utf8')))
  const leads = JSON.parse(readFileSync(leadsPath, 'utf8')) as LeadEvidence[]
  const evaluations = leads.map(l => evaluateLead(contract, l))
  report = JSON.stringify({ contract: contract.id, contract_v: contract.v, as_of: contract.as_of, scorer: contract.scorer, evaluations }, null, 2) + '\n'
} catch (e) {
  console.error(e instanceof ContractError ? e.message : String(e))
  process.exit(2)
}
if (checkFlag === '--check') {
  const expected = readFileSync(expectedPath, 'utf8')
  if (expected !== report) { console.error('contract eval output drifted from the committed golden'); process.exit(1) }
  console.log(`contract eval reproducible: ${expectedPath}`)
  process.exit(0)
}
process.stdout.write(report)
const parsed = JSON.parse(report)
process.exit(parsed.evaluations.some((e: { status: string }) => e.status === 'fail') ? 1 : 0)
