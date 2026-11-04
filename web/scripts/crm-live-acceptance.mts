// #569 live-provider acceptance: one synthetic contact pushed to a SANDBOX CRM through the real pushLead, read back from
// the provider, re-pushed (HubSpot: the verified 409 path), then deleted and confirmed gone. See lib/crm/acceptance.ts.
// Free API calls on a free sandbox account; no paid provider, no real person, no tenant data.
//
//   CRM_ACCEPTANCE=sandbox CRM_ACCEPTANCE_PROVIDER=hubspot CRM_ACCEPTANCE_KEY=<sandbox private-app token> \
//     node --experimental-strip-types scripts/crm-live-acceptance.mts [--out report.json]
//   Pipedrive: CRM_ACCEPTANCE_PROVIDER=pipedrive CRM_ACCEPTANCE_KEY=<sandbox api token> CRM_ACCEPTANCE_PIPEDRIVE_DOMAIN=<sandbox company domain>
//
// Refuses (exit 2, no network) unless CRM_ACCEPTANCE=sandbox, the provider is hubspot|pipedrive and a key is set. The
// key is read from the environment only and never printed. Exit 1 when any step fails; the report says which.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runCrmAcceptance, type AcceptanceProvider } from '../lib/crm/acceptance.ts'

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
  const report = await runCrmAcceptance({ ...cfg, runId: randomBytes(4).toString('hex') })
  const out = process.argv.indexOf('--out') > 0 ? process.argv[process.argv.indexOf('--out') + 1] : undefined
  const text = JSON.stringify(report, null, 2)
  if (out) writeFileSync(out, text + '\n')
  console.log(text)
  for (const s of report.steps) console.error(`${s.skipped ? 'SKIP' : s.ok ? 'PASS' : 'FAIL'} ${s.step}: ${s.detail}`)
  process.exit(report.ok ? 0 : 1)
}
