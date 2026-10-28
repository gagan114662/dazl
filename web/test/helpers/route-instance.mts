// One app instance for test/two-instance-scan.test.ts's route check: the real route handlers on the Db layer, on the
// shared Postgres schema, signed in as RI_TENANT. It reads its own data and then tries the OTHER tenant's job and lead
// ids (written by the other instance) through every read, export and action route. The SQLite handle is a trap:
// getScanDb() throws and DB_PATH cannot be opened, so a route still on raw SQLite fails here. Prints the outcomes.
import { NextRequest } from 'next/server'
import { setUser } from './tenant-route-db.ts'
import { pgDb, setDb } from '../../lib/db/client.ts'

process.env.DB_PATH = '/nonexistent-dazl-dir/app.db'
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${String(u)}`) }) as typeof fetch
const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.RI_SCHEMA, max: 2 })
setDb(db)
const me = process.env.RI_TENANT!, other = JSON.parse(process.env.RI_OTHER!) as { job: string; lead: string }
setUser({ id: me, business_name: 'Co' })

const jobs = await import('../../app/api/scan/jobs/route.ts')
const campaign = await import('../../app/api/campaigns/[id]/route.ts')
const exportRoute = await import('../../app/api/leads/export/route.ts')
const confirm = await import('../../app/api/leads/[lead]/confirm/route.ts')
const quarantine = await import('../../app/api/leads/[lead]/quarantine/route.ts')
const cancel = await import('../../app/api/scan/cancel/route.ts')

const req = (url: string, method = 'GET', body?: unknown) => new NextRequest(`https://app.dazl.test${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test', 'x-forwarded-for': '203.0.113.9' },
  body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = <T extends object>(p: T) => ({ params: Promise.resolve(p) })
const res = async (r: Response | Promise<Response>) => { const x = await r; const t = await x.text(); return { status: x.status, text: t } }

const own = await res(jobs.GET())
const result = {
  ownJobs: (JSON.parse(own.text) as { jobs: { id: string }[] }).jobs.map(j => j.id),
  ownExport: (await res(exportRoute.GET(req('/api/leads/export')))).text,
  otherCampaign: (await res(campaign.GET(new Request('https://x'), ctx({ id: other.job })))).status,
  otherExport: (await res(exportRoute.GET(req(`/api/leads/export?job_id=${other.job}`)))).text,
  otherConfirm: (await res(confirm.POST(req(`/api/leads/${other.lead}/confirm`, 'POST', {}), ctx({ lead: other.lead })))).status,
  otherQuarantine: (await res(quarantine.POST(req(`/api/leads/${other.lead}/quarantine`, 'POST', { reason: 'not mine' }), ctx({ lead: other.lead })))).status,
  otherCancel: (await res(cancel.POST(req('/api/scan/cancel', 'POST', { job_id: other.job })))).status,
}
await db.close()
process.stdout.write('\n' + JSON.stringify(result) + '\n')
