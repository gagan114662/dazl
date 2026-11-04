// #569 live-provider acceptance: one synthetic contact pushed to a SANDBOX CRM through the real pushLead, read back from
// the provider, re-pushed (HubSpot: the verified 409 path), then deleted and confirmed gone. See lib/crm/acceptance.ts.
// Free API calls on a free sandbox account; no paid provider, no real person, no tenant data.
//
//   CRM_ACCEPTANCE=sandbox CRM_ACCEPTANCE_PROVIDER=hubspot CRM_ACCEPTANCE_KEY=<sandbox private-app token> \
//     node --experimental-strip-types scripts/crm-live-acceptance.mts [--out report.json] [--record fixture.json]
//   --record writes every provider exchange of the pushLead steps as replayable fixture cases (no headers, no query
//   string, the key redacted). Copy the file into test/fixtures/crm/recorded/ and test/crm-recorded-fixtures.test.ts
//   replays it through pushLead on every run.
//   Pipedrive: CRM_ACCEPTANCE_PROVIDER=pipedrive CRM_ACCEPTANCE_KEY=<sandbox api token> CRM_ACCEPTANCE_PIPEDRIVE_DOMAIN=<sandbox company domain>
//
// Refuses (exit 2, no network) unless CRM_ACCEPTANCE=sandbox, the provider is hubspot|pipedrive and a key is set. The
// key is read from the environment only and never printed. Exit 1 when any step fails; the report says which.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runCrmAcceptance, type AcceptanceProvider, type RecordedCase } from '../lib/crm/acceptance.ts'

export function acceptanceConfig(env: Record<string, string | undefined>): { provider: AcceptanceProvider; key: string; expectDomain?: string } | { refuse: string } {
  if (env.CRM_ACCEPTANCE !== 'sandbox') return { refuse: 'set CRM_ACCEPTANCE=sandbox to confirm the key belongs to a sandbox CRM account' }
  const provider = env.CRM_ACCEPTANCE_PROVIDER
  if (provider !== 'hubspot' && provider !== 'pipedrive') return { refuse: 'CRM_ACCEPTANCE_PROVIDER must be hubspot or pipedrive' }
  const key = (env.CRM_ACCEPTANCE_KEY ?? '').trim()
  if (!key || key.length > 500 || /\s/.test(key)) return { refuse: 'CRM_ACCEPTANCE_KEY is missing or malformed' }
  const expectDomain = (env.CRM_ACCEPTANCE_PIPEDRIVE_DOMAIN ?? '').trim() || undefined
  if (provider === 'pipedrive' && !expectDomain) return { refuse: 'CRM_ACCEPTANCE_PIPEDRIVE_DOMAIN is required for pipedrive (it has no sandbox flag to check)' }
  return { provider, key, expectDomain }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = acceptanceConfig(process.env)
  if ('refuse' in cfg) { console.error(`crm-live-acceptance: refused: ${cfg.refuse}`); process.exit(2) }
  const arg = (name: string) => process.argv.indexOf(name) > 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined
  const cases: RecordedCase[] = []
  const recordTo = arg('--record')
  const report = await runCrmAcceptance({ ...cfg, runId: randomBytes(4).toString('hex'), record: recordTo ? c => { cases.push(c) } : undefined })
  if (recordTo) writeFileSync(recordTo, JSON.stringify({ provenance: `recorded from a ${cfg.provider} sandbox account by scripts/crm-live-acceptance.mts, run ${report.runId} at ${report.at}`, cases }, null, 2) + '\n')
  const out = arg('--out')
  const text = JSON.stringify(report, null, 2)
  if (out) writeFileSync(out, text + '\n')
  console.log(text)
  for (const s of report.steps) console.error(`${s.skipped ? 'SKIP' : s.ok ? 'PASS' : 'FAIL'} ${s.step}: ${s.detail}`)
  process.exit(report.ok ? 0 : 1)
}
