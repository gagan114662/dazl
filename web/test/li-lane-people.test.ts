// #1571 Part C: a scan through the discovery lane queues a company People page read for a lead whose person has no LinkedIn profile, and
// the read attaches that same person's profile. Invented data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { onCompanyPeopleResult } from '../lib/linkedin-tasks/buyers.ts'
import { enqueueLanePeople, MAX_COMPANY_READS_PER_SCAN } from '../lib/linkedin-tasks/lane-people.ts'
import { completeTask, createExtensionToken, nextTask } from '../lib/linkedin-tasks/store.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import type { Db } from '../lib/db/client.ts'

const TEN_AM = Date.UTC(2026, 10, 23, 15, 0, 0) / 1000
const P = (name: string, title: string, slug: string) => ({ name, title, profile_url: `https://www.linkedin.com/in/${slug}/` })
const home = async (url: string) => url === 'https://acme.example/' ? '<a href="https://www.linkedin.com/company/acme-inc/">LinkedIn</a>' : '<p>no link</p>'
async function seed(db: Db) {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')")
  await db.run("INSERT INTO leads (id, scan_job_id, company, company_domain, signal, source_url, source_kind) VALUES ('l1', 'j1', 'Acme', 'acme.example', 'expanding', 'https://news.example/acme', 'discover')")
}
const queued = async (db: Db) => (await db.all<{ url: string }>("SELECT url FROM li_tasks WHERE tenant_id = 'A' ORDER BY created_at, id")).map(r => r.url)
const leads = [{ id: 'l1', domain: 'acme.example', hasProfile: false }, { id: 'l2', domain: 'nolink.example', hasProfile: false }, { id: 'l3', domain: 'acme.example', hasProfile: true }, { id: 'l4', domain: null, hasProfile: false }]

test('the cap is a few pages a scan', () => assert.ok(MAX_COMPANY_READS_PER_SCAN <= 5))

bothEngines('a workspace that has not connected LinkedIn queues nothing and reads no homepage', async ({ db }) => {
  await seed(db)
  let reads = 0
  assert.equal(await enqueueLanePeople(db, 'A', 'j1', leads, async u => { reads++; return home(u) }, TEN_AM), 0)
  assert.equal(reads, 0)
})

bothEngines('connected: the one company page the homepage links is queued, read, and the named person gets their profile', async ({ db }) => {
  await seed(db)
  await createExtensionToken(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  assert.equal(await enqueueLanePeople(db, 'A', 'j1', leads, home, TEN_AM), 1)
  assert.deepEqual(await queued(db), ['https://www.linkedin.com/company/acme-inc/people/'])
  await db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('e1', 'l1', 'A', 'discover', 'person', 'Dana Ruiz, Chief Executive', 'named on a public page', NULL, 'https://acme.example/team', '2026-11-22', ?)", [TEN_AM])
  const n = await nextTask(db, 'A', TEN_AM, () => 0.5)
  assert.ok('task' in n)
  const id = 'task' in n ? n.task.id : ''
  assert.equal(await completeTask(db, 'A', id, { people: [P('Ann Lee', 'Engineer', 'ann'), P('Dana  ruiz', 'CEO', 'dana-ruiz')] }, TEN_AM + 30), 'stored')
  assert.equal(await onCompanyPeopleResult(db, 'B', id), 'not_a_lead_task')
  assert.equal(await onCompanyPeopleResult(db, 'A', id), 'stored')
  const rows = await db.all<{ connector: string; kind: string; value: string; source_url: string }>("SELECT connector, kind, value, source_url FROM lead_enrichments WHERE lead_id = 'l1' ORDER BY kind")
  assert.deepEqual(rows.find(r => r.kind === 'linkedin'), { connector: 'discover', kind: 'linkedin', value: 'https://www.linkedin.com/in/dana-ruiz/', source_url: 'https://www.linkedin.com/in/dana-ruiz/' })
  assert.equal(leadPerson(rows, '')?.linkedin, 'https://www.linkedin.com/in/dana-ruiz/')
  assert.equal(await onCompanyPeopleResult(db, 'A', id), 'already_named')
})
