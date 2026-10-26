import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent } from '../lib/advanced/index.ts'
import { migrateCompetitors, setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { collectLinkedInPeople, linkedinQueries } from '../lib/signals/linkedin-people.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { Provider } from '../lib/llm/provider.ts'

// LinkedIn person-level signals through the tenant's own session (owner decision 2026-10-26). Worker stubbed.
const master = randomBytes(32)
const ICP = { summary: 'Ohio employers that need payroll help', who: ['HR manager'], industries: ['logistics'], sizes: [], where: ['Ohio'], signals: [], exclude: [] }
const ENV = { ADVANCED_CONNECTORS: '1', ADVANCED_LINKEDIN: '1', ADVANCED_WORKER_URL: 'http://w', ADVANCED_WORKER_TOKEN: 't' }
const person = (id: string, quote: string) => ({ url: `https://www.linkedin.com/in/${id}/`, title: id, quote, date: '2026-10-20', login_walled: true })

function setup(consent = true, session = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migrateConnectors(db); migrateAdvanced(db); migrateCompetitors(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  if (consent) acceptConsent(db, 'A', 'linkedin')
  if (session) saveCredential(db, 'A', 'adv:linkedin', 'li_at=abc; JSESSIONID="ajax:1"', master)
  setCompetitors(db, 'A', ['Rippling', 'Gusto'])
  return db
}

test('queries: one people search first, then competitor engagers, within the hourly budget', () => {
  assert.deepEqual(linkedinQueries(ICP, ['Rippling', 'Gusto'], 3), ['people:HR manager Ohio', 'engagers:Rippling', 'engagers:Gusto'])
  assert.deepEqual(linkedinQueries(ICP, ['Rippling', 'Gusto'], 1), ['people:HR manager Ohio'])
  assert.deepEqual(linkedinQueries({ ...ICP, who: [] }, ['Rippling'], 3), ['engagers:Rippling'])
})

test('gates: flag, consent and the tenant session are all required; nothing reaches the worker otherwise', async () => {
  let calls = 0
  const worker = async () => { calls++; return [] }
  assert.deepEqual(await collectLinkedInPeople(setup(), 'A', 'j', ICP, { worker, master, env: { ...ENV, ADVANCED_LINKEDIN: '0' } }), [])
  assert.deepEqual(await collectLinkedInPeople(setup(false), 'A', 'j', ICP, { worker, master, env: ENV }), [])
  assert.deepEqual(await collectLinkedInPeople(setup(true, false), 'A', 'j', ICP, { worker, master, env: ENV }), [])
  assert.equal(calls, 0)
})

test('the hourly LinkedIn budget is shared and enforced across scans', async () => {
  const db = setup(); const sent: string[] = []
  const worker = async (r: { query: string }) => { sent.push(r.query); return [] }
  await collectLinkedInPeople(db, 'A', 'j1', ICP, { worker, master, env: ENV })
  await collectLinkedInPeople(db, 'A', 'j2', ICP, { worker, master, env: ENV })
  assert.deepEqual(sent, ['people:HR manager Ohio', 'engagers:Rippling', 'engagers:Gusto']) // 3/hour, second scan gets none
})

test('a scan turns LinkedIn people into review-lane leads (login_required), never verified', async () => {
  const db = setup()
  const saved = { ...process.env }; Object.assign(process.env, ENV)
  try {
    const id = createQueryJob(db, 'A', { query: 'Ohio employers that need payroll help', icp: JSON.stringify(ICP) } as never)
    const worker = async (r: { query: string }) => r.query.startsWith('engagers:Rippling')
      ? [person('jane-doe-1', 'Jane Doe, HR Manager at Acme Logistics. Commented on a LinkedIn post about Rippling: https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/')]
      : []
    const prov: Record<'anthropic' | 'openai', Provider> = {
      anthropic: {
        research: async () => ({ text: '[]', citedUrls: [] }),
        complete: async (_k, p) => p.includes('jane-doe-1')
          ? JSON.stringify([{ name: 'Jane Doe', company: 'Acme Logistics', contact: null, signal: 'Commented on a LinkedIn post about Rippling', source_url: 'https://www.linkedin.com/in/jane-doe-1/', excerpt: 'Jane Doe, HR Manager at Acme Logistics. Commented on a LinkedIn post about Rippling', event_date: '2026-10-20', score: 80 }])
          : '[]',
      },
      openai: { research: async () => ({ text: '', citedUrls: [] }) },
    }
    await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, fetchPage: async () => null, advancedWorker: worker, score: false, judge: null })
    const leads = listLeads(db, 'A', id, 200, true) as { name: string; company: string; review_reason: string | null; source_url: string }[]
    const jane = leads.find(l => l.name === 'Jane Doe')
    assert.ok(jane, JSON.stringify(leads))
    assert.equal(jane!.review_reason, 'login_required'); assert.equal(jane!.company, 'Acme Logistics')
    assert.equal(jane!.source_url, 'https://www.linkedin.com/in/jane-doe-1/')
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved) }
})
