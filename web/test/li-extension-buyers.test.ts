// #1122 step 3: a company's buyer from its LinkedIn People page (read in the user's browser), by the scan's own ICP role. Invented data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { chooseLinkedInBuyer, companyPeopleUrl, enqueueCompanyPeople, onCompanyPeopleResult } from '../lib/linkedin-tasks/buyers.ts'
import {completeTask, nextTask } from '../lib/linkedin-tasks/store.ts'
import { pairLinkedIn } from './helpers/li-pair.ts'
import { LINKEDIN_PEOPLE_LABEL, onCompanySite, siteContactFromRows } from '../lib/scan/site-contact.ts'
import type { Db } from '../lib/db/client.ts'

const P = (name: string, title: string, slug: string) => ({ name, title, profile_url: `https://www.linkedin.com/in/${slug}/` })
const TEN_AM = Date.UTC(2026, 10, 23, 15, 0, 0) / 1000

test('companyPeopleUrl: the one LinkedIn company page the homepage links; none or several is no page', () => {
  assert.equal(companyPeopleUrl('<a href="https://www.linkedin.com/company/acme-inc/">in</a>'), 'https://www.linkedin.com/company/acme-inc/people/')
  assert.equal(companyPeopleUrl('<a href="https://ca.linkedin.com/company/Acme-Inc?trk=x">in</a><a href=\'https://linkedin.com/company/acme-inc\'>x</a>'), 'https://www.linkedin.com/company/acme-inc/people/')
  assert.equal(companyPeopleUrl('<a href="https://www.linkedin.com/company/acme/">a</a><a href="https://www.linkedin.com/company/partner-co/">b</a>'), null)
  assert.equal(companyPeopleUrl('<a href="https://www.linkedin.com/in/someone/">me</a>'), null)
})

test('chooseLinkedInBuyer: the ICP role first; nobody matching or a tie is no buyer', () => {
  const people = [P('Ann Lee', 'Software Engineer', 'ann'), P('Raj Mehta', 'Head of Sales', 'raj'), P('Tom Ford', 'Account Executive', 'tom')]
  assert.equal(chooseLinkedInBuyer(people, 'Head of Sales')?.name, 'Raj Mehta')
  assert.equal(chooseLinkedInBuyer(people, 'Head of Marketing'), null)
  assert.equal(chooseLinkedInBuyer([P('Raj Mehta', 'Head of Sales', 'raj'), P('Lia Wong', 'Head of Sales', 'lia')], 'Head of Sales'), null)
})

test('the buyer bar: a LinkedIn-read person counts only with a profile source and a title meeting the role', () => {
  const row = { connector: 'sitecrawl', kind: 'person', value: 'Raj Mehta, Head of Sales', source_url: 'https://www.linkedin.com/in/raj/', label: LINKEDIN_PEOPLE_LABEL }
  assert.equal(onCompanySite(row, 'acme.com'), true)
  assert.equal(onCompanySite({ ...row, source_url: 'https://evil.example/in/raj/' }, 'acme.com'), false)
  assert.equal(siteContactFromRows('acme.com', true, 'Head of Sales', [row]).person?.value, 'Raj Mehta, Head of Sales')
  // The role check at display time is the shared word-overlap rule (lib/people/rank.ts), which lets 'Head of Sales' through for a
  // 'Head of Marketing' request. The strict choice happens when the person is stored (chooseLinkedInBuyer, tested above).
  assert.equal(siteContactFromRows('acme.com', true, 'Office Manager', [row]).person, null)
})

async function seed(db: Db) {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, icp) VALUES ('j1', 'A', 'b', 'i', 'l', 'running', ?)", [JSON.stringify({ who: ['Head of Sales'] })])
  await db.run("INSERT INTO leads (id, scan_job_id, company, company_domain, signal, source_url) VALUES ('l1', 'j1', 'Acme', 'acme.com', 'hiring', 'https://acme.com/jobs')")
}
const people = async (db: Db) => db.all<{ value: string; label: string; source_url: string }>("SELECT value, label, source_url FROM lead_enrichments WHERE lead_id = 'l1' AND kind = 'person'")

bothEngines('no extension token: nothing is queued', async ({ db }) => {
  await seed(db)
  assert.equal(await enqueueCompanyPeople(db, 'A', 'j1', 'l1', 'https://www.linkedin.com/company/acme/people/', TEN_AM), null)
})

bothEngines('queued read -> extension result -> the ICP buyer stored with name, title and LinkedIn URL; a second result names no one else', async ({ db }) => {
  await seed(db)
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  const id = await enqueueCompanyPeople(db, 'A', 'j1', 'l1', 'https://www.linkedin.com/company/acme/people/', TEN_AM)
  assert.ok(id)
  const n = await nextTask(db, 'A', TEN_AM, () => 0.5)
  assert.ok('task' in n && n.task.id === id)
  assert.equal(await completeTask(db, 'A', id!, { people: [P('Ann Lee', 'Software Engineer', 'ann'), P('Raj Mehta', 'Head of Sales', 'raj')] }, TEN_AM + 30), 'stored')
  assert.equal(await onCompanyPeopleResult(db, 'B', id!), 'not_a_lead_task')
  assert.equal(await onCompanyPeopleResult(db, 'A', id!), 'stored')
  assert.deepEqual(await people(db), [{ value: 'Raj Mehta, Head of Sales', label: LINKEDIN_PEOPLE_LABEL, source_url: 'https://www.linkedin.com/in/raj/' }])
  assert.equal(await onCompanyPeopleResult(db, 'A', id!), 'already_named')
})

bothEngines('nobody meeting the role: nothing stored', async ({ db }) => {
  await seed(db)
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  const id = await enqueueCompanyPeople(db, 'A', 'j1', 'l1', 'https://www.linkedin.com/company/acme/people/', TEN_AM)
  await nextTask(db, 'A', TEN_AM, () => 0.5)
  await completeTask(db, 'A', id!, { people: [P('Ann Lee', 'Software Engineer', 'ann')] }, TEN_AM + 30)
  assert.equal(await onCompanyPeopleResult(db, 'A', id!), 'no_buyer')
  assert.deepEqual(await people(db), [])
})
