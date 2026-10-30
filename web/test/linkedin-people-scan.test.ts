// #192 reworked, through the real scan: LinkedIn people reach a scan only via an injected transport and only with the flag + consent; they land in the review lane
// (login_required), never verified. With no transport (the default) nothing is requested and no lead appears. Invented people; stubs only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent } from '../lib/advanced/index.ts'
import { migrateCompetitors, setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { LinkedInTransport } from '../lib/signals/linkedin-people.ts'
import type { Provider } from '../lib/llm/provider.ts'

const master = randomBytes(32)
const ICP = { summary: 'Ohio employers that need payroll help', who: ['HR manager'], industries: ['logistics'], sizes: [], where: ['Ohio'], signals: [], exclude: [] }
async function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migrateConnectors(db); migrateAdvanced(db); migrateCompetitors(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  acceptConsent(db, 'A', 'linkedin'); await setCompetitors(sqliteDb(db), 'A', ['Rippling'])
  return db
}
const QUOTE = 'Jane Doe, HR Manager at Acme Logistics. Commented on a LinkedIn post about Rippling.'
const providers = (): Record<'anthropic' | 'openai', Provider> => ({
  anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k, p) => p.includes('jane-doe-1') ? JSON.stringify([{ name: 'Jane Doe', company: 'Acme Logistics', contact: null, signal: 'Commented on a LinkedIn post about Rippling', source_url: 'https://www.linkedin.com/in/jane-doe-1/', excerpt: QUOTE, score: 70, event_date: '2026-10-20' }]) : '[]' },
  openai: { research: async () => ({ text: '', citedUrls: [] }) },
})
const run = async (flag: boolean, transport?: LinkedInTransport) => {
  const db = await setup(); const saved = { ...process.env }; if (flag) process.env.ADVANCED_LINKEDIN_PEOPLE = '1'; else delete process.env.ADVANCED_LINKEDIN_PEOPLE
  try {
    const id = createQueryJob(db, 'A', { query: 'Ohio employers that need payroll help', icp: JSON.stringify(ICP) } as never)
    await runJob(db, claimKeyedJob(db, id)!, { providers: providers(), master, fetchPage: async () => null, linkedinTransport: transport, score: false, judge: null })
    return { db, leads: listLeads(db, 'A', id, 200, true) as { name: string; company: string; review_reason: string | null; source_url: string }[] }
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved) }
}

test('with the flag, consent and an injected transport: LinkedIn people become review-lane leads (login_required), never verified', async () => {
  let asked = 0
  const t: LinkedInTransport = { fetch: async r => { asked++; return r.kind === 'engagers' ? { status: 'ok', items: [{ url: 'https://www.linkedin.com/in/jane-doe-1/', title: 'jane-doe-1', quote: QUOTE, date: '2026-10-20' }] } : { status: 'ok', items: [] } } }
  const { leads } = await run(true, t)
  const jane = leads.find(l => l.name === 'Jane Doe'); assert.ok(jane, JSON.stringify(leads))
  assert.equal(jane!.review_reason, 'login_required'); assert.equal(jane!.source_url, 'https://www.linkedin.com/in/jane-doe-1/'); assert.ok(asked > 0)
})

test('default: no transport, or the flag off, requests nothing and creates no LinkedIn lead', async () => {
  let asked = 0; const t: LinkedInTransport = { fetch: async () => { asked++; return { status: 'ok', items: [] } } }
  assert.ok(!(await run(true, undefined)).leads.some(l => l.source_url.includes('linkedin.com/in/')))
  const off = await run(false, t); assert.equal(asked, 0); assert.ok(!off.leads.some(l => l.source_url.includes('linkedin.com/in/')))
})

test('a throttled answer in a scan stops LinkedIn for that tenant and the scan still finishes', async () => {
  let asked = 0; const t: LinkedInTransport = { fetch: async () => { asked++; return { status: 'throttled' } } }
  const { db, leads } = await run(true, t); assert.equal(asked, 1); assert.ok(!leads.some(l => l.source_url.includes('linkedin.com/in/')))
  assert.ok((db.prepare("SELECT status FROM connector_audit WHERE connector = 'adv:linkedin'").all() as { status: string }[]).some(r => r.status === 'stopped_throttled'))
})
