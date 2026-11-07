// Production GET -> requireUser/cookies/getSessionUser -> explicit membership; production same-raw reap/read/after/kick.
// Synthetic separate control-plane store, raw SQLite domain and queue. PG engine here is CONTROL/QUEUE, NOT scan domain.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
// @ts-expect-error captured after() test shim
import { flushAfter } from 'next/server'
import { bothEngines } from './engines.ts'
import { withJar } from './pg-session-headers.ts'
import { setDomain, domainOpens } from './status-boundary-sqlite.ts'
import { createSession } from '../../lib/auth-db.ts'
import { setDb, sqliteDb } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { GET } from '../../app/api/scan/status/route.ts'
import { hasInFlight } from '../../lib/scan/runner.ts'
import { readFileSync } from 'node:fs'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const A = 'a'.repeat(32), B = 'b'.repeat(32), ACTOR = 'c'.repeat(32)
const input = { business_name: 'Domain', industry: 'software', location: 'Austin' }
const sleep = () => new Promise(r => setTimeout(r, 10))

bothEngines('actual status HTTP: real session tenant, divergent control/domain, mode matrix and no-rebill fences', async ({ db: control, kind }) => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setDomain(raw)
  const env = { url: process.env.DATABASE_URL, shared: process.env.DAZL_SCAN_SHARED_QUEUE, tenants: process.env.DAZL_QUEUE_TENANTS }
  // setDb substitutes only the already-selected control/queue store. It does not replace authentication or read logic.
  setDb(control)
  try {
    for (const [id, email] of [[A, 'owner'], [B, 'other'], [ACTOR, 'member']]) await control.run('INSERT INTO users (id,email,password_hash,salt,business_name) VALUES (?,?,?,?,?)', [id, `${email}@example.test`, 'x', 'x', email])
    await control.run("INSERT INTO organizations (id,name,kind,created_by,created_at) VALUES (?, 'Workspace', 'personal', 'fixture', 1)", [A])
    await control.run("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'operator',1)", [A, ACTOR])
    await control.run("INSERT INTO tenant_plans (tenant_id,plan) VALUES (?, 'pro')",[A])
    const planBefore = await control.get('SELECT * FROM tenant_plans WHERE tenant_id=?',[A])
    const token = await createSession(ACTOR, control)
    await control.run('UPDATE sessions SET active_tenant_id = ? WHERE user_id = ?', [A, ACTOR])
    const jar = new Map([['dazl_session', token]])
    const own = createJob(raw, A, input, '{"first5":true}')
    const foreign = createJob(raw, B, input)
    // Same ID in the selected control store: if status reacquires getDb, this is the wrong payload/domain.
    await control.run("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,query) VALUES (?,?,'POISON','x','x','failed','POISON')", [own, A])
    const poisonBefore = await control.get('SELECT * FROM scan_jobs WHERE id = ?', [own])
    const request = (id: string, passive = true, cookies = jar) => withJar(cookies, () => GET(new NextRequest(`http://localhost/api/scan/status?job_id=${id}${passive ? '&passive=1' : ''}`)))
    for (const cookies of [new Map<string, string>(), new Map([['dazl_session','malformed']]), new Map([['dazl_session','f'.repeat(64)]])]) {
      const before = domainOpens(); assert.equal((await request(own, true, cookies)).status, 401); assert.equal(domainOpens(), before, 'unauthenticated never opens domain')
    }
    assert.equal((await request('bad')).status, 404)
    assert.equal((await request('e'.repeat(24))).status, 404)
    assert.equal((await request(foreign)).status, 404, 'membership tenant, not actor id or other domain owner')
    // Configured URL means shared control-plane PG, NOT a PG domain switch. SQLite runs absent/empty + configured-injection controls.
    const urls = kind === 'pg' ? ['postgres://selected-test-control/fixture'] : [undefined, '', 'postgres://selected-test-control/fixture']
    for (const url of urls) for (const mode of ['legacy', 'canary', 'shared'] as const) {
      if (url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = url
      process.env.DAZL_SCAN_SHARED_QUEUE = mode === 'shared' ? '1' : '0'
      process.env.DAZL_QUEUE_TENANTS = mode === 'canary' ? A : ''
      raw.prepare("UPDATE scan_jobs SET status='running',attempts=1,claimed_at=1,error=NULL WHERE id=?").run(own)
      const response = await request(own); assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.status, 'pending', 'passive reap is preserved in every mode'); assert.equal(payload.attempts, 1)
      assert.equal(payload.query, null, 'never the same-ID control poison')
      await flushAfter()
      assert.equal(raw.prepare<[string], { attempts: number }>('SELECT attempts FROM scan_jobs WHERE id=?').get(own)?.attempts, 1, 'passive schedules no kick')
    }
    // Foreign lookup still runs legacy global reap BEFORE owner lookup. Characterize, do not silently change it.
    raw.prepare("UPDATE scan_jobs SET status='running',attempts=1,claimed_at=1 WHERE id=?").run(own)
    assert.equal((await request(foreign)).status, 404)
    assert.equal(raw.prepare<[string], { status: string }>('SELECT status FROM scan_jobs WHERE id=?').get(own)?.status, 'pending')
    raw.prepare("UPDATE scan_jobs SET status='running',claimed_at=? WHERE id=?").run(Math.floor(Date.now()/1000),own)
    for (const id of ['visible','held']) raw.prepare("INSERT INTO leads (id,scan_job_id,company,signal,source_url,confidence,fit) VALUES (?,?,'Co','s','https://example.test',80,4)").run(id,own)
    raw.prepare("INSERT INTO lead_enrichments (id,lead_id,tenant_id,connector,kind,value,source_url,source_date,retrieved_at) VALUES ('hold','held',?,'scan:gate','gate_failed','sales_hiring_check_failed','https://invalid.example','2026-11-07',1)").run(A)
    const now = Math.floor(Date.now()/1000)
    raw.prepare("UPDATE scan_jobs SET status='done',enrich_started_at=?,enrich_finished_at=NULL WHERE id=?").run(now,own)
    const provisional = await (await request(own)).json()
    assert.equal(provisional.status,'enriching'); assert.equal(provisional.enrichment.state,'running'); assert.equal(provisional.first5.verified,0)
    assert.deepEqual(provisional.first5.leads.map((l: {id:string})=>l.id),['visible']); assert.equal(provisional.first5.leads[0].provisional,true)
    raw.prepare('UPDATE scan_jobs SET enrich_finished_at=? WHERE id=?').run(now+1,own)
    const terminal = await (await request(own)).json()
    assert.equal(terminal.status,'done'); assert.equal(terminal.enrichment.state,'finished'); assert.equal(terminal.first5.verified,1)
    assert.equal(terminal.first5.leads[0].provisional,false)
    // Even a non-passive request cannot rebill a pending job with an EARLIER attempt's reserved call.
    const reserved = createJob(raw,A,input)
    raw.prepare('UPDATE scan_jobs SET attempts=2 WHERE id=?').run(reserved)
    raw.prepare("INSERT INTO scan_spend_calls (id,user_id,scan_job_id,attempt,kind,reserve_usd,status,created_at) VALUES ('reserved',?,?,1,'llm.anthropic',0.01,'reserved',1)").run(A,reserved)
    const reserveBefore = raw.prepare('SELECT * FROM scan_spend_calls').all()
    const uncertain = await (await request(reserved,false)).json()
    assert.equal(uncertain.status,'failed'); assert.equal(uncertain.error,'accounting_uncertain')
    await flushAfter(); assert.equal(raw.prepare<[string], { attempts: number }>('SELECT attempts FROM scan_jobs WHERE id=?').get(reserved)?.attempts,2)
    assert.deepEqual(raw.prepare('SELECT * FROM scan_spend_calls').all(),reserveBefore)
    // Real post-response dispatch: queue uses shared store only for configured+shared, domain always this raw handle.
    for (const mode of ['legacy','canary','shared'] as const) {
      process.env.DAZL_SCAN_SHARED_QUEUE=mode==='shared'?'1':'0'; process.env.DAZL_QUEUE_TENANTS=mode==='canary'?A:''
      if(kind==='pg') process.env.DATABASE_URL='postgres://selected-test-control/fixture'; else delete process.env.DATABASE_URL
      const id=createJob(raw,A,input); saveKey(raw,A,'anthropic','sk-ant-synthetic-test-key')
      const response=await request(id,false); assert.equal(response.status,200)
      assert.equal(raw.prepare<[string], { attempts: number }>('SELECT attempts FROM scan_jobs WHERE id=?').get(id)?.attempts,0,'after not flushed yet')
      await flushAfter()
      for(let i=0;i<800 && (hasInFlight() || raw.prepare<[string], { status: string }>('SELECT status FROM scan_jobs WHERE id=?').get(id)?.status!=='failed');i++) await sleep()
      const row=raw.prepare('SELECT status,error,attempts,claimed_at FROM scan_jobs WHERE id=?').get(id)
      assert.deepEqual(row,{status:'failed',error:'budget_stopped',attempts:1,claimed_at:null})
      const queue=kind==='pg'?control:sqliteDb(raw)
      const item=await queue.get('SELECT status,tenant_id FROM work_queue WHERE id=?',[id])
      if(mode==='legacy') assert.equal(item,undefined)
      else assert.deepEqual(item,{status:'failed',tenant_id:A})
      if(kind==='pg') assert.equal(raw.prepare('SELECT id FROM work_queue WHERE id=?').get(id),undefined,'PGqueue never mirrored onto raw domain')
    }
    assert.deepEqual(await control.get('SELECT * FROM scan_jobs WHERE id=?',[own]),poisonBefore,'selected shared store never used as domain')
    assert.deepEqual(await control.get('SELECT * FROM tenant_plans WHERE tenant_id=?',[A]),planBefore,'status never mutates plan')
    await control.run('UPDATE sessions SET revoked_at=1 WHERE user_id=?',[ACTOR])
    const opensBeforeRevoked=domainOpens(); assert.equal((await request(own)).status,401); assert.equal(domainOpens(),opensBeforeRevoked)
    assert.equal(hasInFlight(),false)
    const service=readFileSync(new URL('../../lib/scan/service.ts',import.meta.url),'utf8')
    assert.match(service,/getSessionUser\(/); assert.match(service,/const db = getAuthDb\(\)/)
  } finally {
    await flushAfter(); setDb(null); raw.close()
    for(const [k,v] of Object.entries({DATABASE_URL:env.url,DAZL_SCAN_SHARED_QUEUE:env.shared,DAZL_QUEUE_TENANTS:env.tenants})) { if(v===undefined)delete process.env[k];else process.env[k]=v }
  }
})
