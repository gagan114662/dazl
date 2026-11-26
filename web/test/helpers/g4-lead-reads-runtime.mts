import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { storeEvidenceCopy } from '../../lib/scan/evidence-copies.ts'
import { companyKey } from '../../lib/scan/evidence.ts'
import { recordEmailGuesses } from '../../lib/people/email-pattern.ts'
import { saveCrmConfig } from '../../lib/crm/index.ts'
import { GET as evidence } from '../../app/api/leads/evidence/route.ts'
import { GET as recheck } from '../../app/api/leads/evidence-recheck/route.ts'
import { GET as signals } from '../../app/api/leads/page-signals/route.ts'
import { GET as preview } from '../../app/api/leads/qualify-preview/route.ts'
import { GET as feedback } from '../../app/api/leads/[lead]/feedback/route.ts'
import { GET as warm } from '../../app/api/leads/[lead]/warm-path/route.ts'
import { GET as emails, POST as email } from '../../app/api/leads/[lead]/work-email/route.ts'
import { POST as crm } from '../../app/api/crm/route.ts'

const id = () => randomBytes(12).toString('hex')
const request = (route: string, body?: Record<string, string>) => new NextRequest('http://localhost/api/' + route,
  body ? { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify(body) } : {})
const params = (lead: string) => ({ params: Promise.resolve({ lead }) })

test('#830 foreign and absent leads produce the same rejection and SQLite statement sequence', async t => {
  let trace: string[] = []
  const db = new Database(':memory:', { verbose: sql => trace.push(String(sql)) })
  t.after(() => db.close())
  let fetches = 0
  t.mock.method(globalThis, 'fetch', () => { fetches++; throw new Error('Unexpected fetch') })
  migrateAllSqlite(db)
  setScanDb(db)
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  const owner = id(), other = id(), lead = id(), buyerLead = id(), job = id()
  const company = 'Synthetic ' + id(), proof = 'Saved evidence ' + company
  const site = 'fixture-' + id() + '.example', bio = 'https://' + site + '/team'
  const now = Math.floor(Date.now() / 1000)
  for (const tenant of [owner, other]) saveCrmConfig(db, tenant, { provider: 'hubspot', key: id() })
  db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,icp) VALUES (?,?,?,'synthetic','fixture','running',?)")
    .run(job, owner, company, JSON.stringify({ who: ['Practice Manager'], where: ['New York, NY'] }))
  const copy = storeEvidenceCopy(db, owner, job, 1, { url: bio, title: company, text: proof, sha256: createHash('sha256').update(proof).digest('hex'), heldAt: now })
  const add = db.prepare("INSERT INTO leads (id,scan_job_id,name,company,signal,source_url,company_domain,evidence_copy_id) VALUES (?,?,'',?,'hiring',?,?,?)")
  add.run(lead, job, company, 'http://fixture.invalid/proof', null, copy)
  add.run(buyerLead, job, company, bio, site, null)
  const target = 'Dana Lee|Practice Manager', person = 'Dana Lee, Practice Manager', address = 'dana.lee@' + site
  const enrich = db.prepare("INSERT INTO lead_enrichments (id,lead_id,tenant_id,connector,kind,value,label,source_url,source_date,retrieved_at) VALUES (?,?,?,'sitecrawl',?,?,?,?,?,?)")
  const day = new Date().toISOString().slice(0, 10)
  enrich.run(id(), buyerLead, owner, 'domain', site + '|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', bio, day, now)
  enrich.run(id(), buyerLead, owner, 'person', person, null, bio, day, now)
  recordEmailGuesses(db, owner, buyerLead, site, [], [person], { homeText: '1 Main St, New York, NY 10001', seen: [{ address, url: bio }] })
  const feedbackId = id(), pathId = id(), externalId = id()
  db.prepare("INSERT INTO lead_feedback (id,tenant_id,version,verdict,level,company_key,lead_id,created_at) VALUES (?,?,1,'accept','account',?,?,?)")
    .run(feedbackId, owner, companyKey(company), lead, now)
  db.prepare("INSERT INTO warm_user_paths (id,tenant_id,lead_id,contact_url,mutual_name) VALUES (?,?,?,?,'Fixture mutual')")
    .run(pathId, owner, lead, 'linkedin.com/in/' + id())
  db.prepare("INSERT INTO crm_push_claims (tenant_id,destination,lead_id,status,external_id,attempt_id,claimed_at,updated_at) VALUES (?,'hubspot',?,'ok',?,?,?,?)")
    .run(owner, lead, externalId, id(), now, now)
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(job)

  const routes: { route: string; own: string; marker: string; call: (key: string) => Promise<Response> }[] = [
    ...([['evidence', evidence, proof], ['evidence-recheck', recheck, company], ['page-signals', signals, company], ['qualify-preview', preview, company]] as const)
      .map(([route, get, marker]) => ({ route, own: lead, marker, call: (key: string) => get(request('leads/' + route + '?lead_id=' + key)) })),
    ...([['feedback', feedback, lead, feedbackId], ['warm-path', warm, lead, pathId], ['work-email', emails, buyerLead, address]] as const)
      .map(([route, get, own, marker]) => ({ route, own, marker, call: (key: string) => get(request('leads/' + key + '/' + route), params(key)) })),
    { route: 'POST work-email', own: buyerLead, marker: address, call: key => email(request('leads/' + key + '/work-email', { target }), params(key)) },
    { route: 'POST crm status', own: lead, marker: externalId, call: key => crm(request('crm', { action: 'status', lead_id: key })) },
  ]
  for (const { route, own, marker, call } of routes) {
    setUser({ id: owner, business_name: company })
    const allowed = await call(own)
    assert.equal(allowed.status, 200, route)
    assert.ok((await allowed.text()).includes(marker), route + ' owner control')
    setUser({ id: other, business_name: 'Other fixture' })
    const rejected = async (key: string) => {
      trace = []
      const res = await call(key)
      const body = await res.text()
      assert.equal(res.status, 404, route)
      assert.deepEqual(JSON.parse(body), { error: route === 'POST work-email' ? 'Lead not found' : 'Not found' }, route)
      assert.ok(trace.some(sql => sql.includes(key)), route + ' exercised lookup')
      return { body, headers: Array.from(res.headers), work: trace.map(sql => sql.replaceAll(key, '<lead>').replace(/\b\d{10,13}\b/g, '<clock>')) }
    }
    assert.deepEqual(await rejected(own), await rejected(id()), route)
  }
  assert.equal(fetches, 0)
})
