import '../helpers/net-fence.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession } from '../../lib/auth-db.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { qaClaudeOnlyBudget } from '../../lib/scan/qa-provider-policy.ts'
import { periodOf, poolRows } from '../../lib/llm/spend-pool.ts'
import { confirmEmail } from '../helpers/confirmed.ts'
import { pickUiPort } from '../helpers/ui-port.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dazl-signed-icp-'))
const dbPath = join(dir, 'fixture.db'), wire = join(dir, 'wire.log')
const db = new Database(dbPath), d = sqliteDb(db)
const A = 'fixture-signed-icp', B = 'fixture-signed-other'
const key = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const marker = 'p:n123456789', held = 0.4
migrateAllSqlite(db)
for (const id of [A,B]) {
  await createPasswordUser({id,email:id+'@example.test',name:id,business_name:id,password_hash:'unused',salt:'unused'},d)
  await confirmEmail(d,id)
  saveKey(db,id,'anthropic',key,Buffer.alloc(32,42))
}
const token = await createSession(A,d), other = await createSession(B,d)
const port = pickUiPort()
const base = 'http://127.0.0.1:' + port
const mode = process.argv.includes('--production-build') ? 'start' : 'dev'
if (mode === 'start') assert.ok(existsSync('.next/BUILD_ID'), 'build the actual Next app before this smoke')
const app = spawn(process.execPath, ['--experimental-strip-types','--import','./test/manual/icp-signed-wire-preload.mjs','./node_modules/next/dist/bin/next',mode,'--hostname','127.0.0.1','--port',String(port)], {
  env:{ PATH:process.env.PATH, HOME:dir, DB_PATH:dbPath, DAZL_FIXTURE_WIRE:wire,
    NEXT_TELEMETRY_DISABLED:'1', DAZL_RUN_MAX_USD_USERS:A+':1,'+B+':1', DAZL_OWNER_MONTH_MAX_USD_USERS:A+':1,'+B+':1',
    DAZL_SPEND_BUSY_WAIT_MS:'0', DAZL_ANTHROPIC_MODEL:'claude-sonnet-4-5', SITECRAWL_ENABLED:'0', NEWS_SEARCH_ENABLED:'0' }, stdio:['ignore','pipe','pipe']
})
let output = ''
app.stdout.on('data',s => { output = (output+s).slice(-18000) })
app.stderr.on('data',s => { output = (output+s).slice(-18000) })
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms))
const calls = () => { try { return readFileSync(wire,'utf8').trim().split('\n').length } catch { return 0 } }
const post = async (cookie?: string) => { const r=await fetch(base+'/api/scan/icp',{method:'POST',headers:{'content-type':'application/json',origin:base,...(cookie?{cookie:'dazl_session='+cookie}:{})},body:JSON.stringify({query:'Find regional laboratory founders'}),signal:AbortSignal.timeout(60000)});return {status:r.status,body:await r.json()} }
try {
  for (let i=0; i<150 && !/Ready in/.test(output) && app.exitCode===null; i++) await sleep(200)
  assert.match(output,/Ready in/)
  assert.equal((await post()).status,401)
  const t = Math.floor(Date.now()/1000), stale=t-350
  const budget = JSON.stringify({...JSON.parse(qaClaudeOnlyBudget('{"first5":true}',true)),execution:'local_once_v1'})
  db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,funded_by,run_budget,created_at,spend_reserved_usd,spend_cap_reserved_usd) VALUES ('old',?,'Fixture','Test','Test','running',1,'user',?,?,?,?)").run(A,budget,stale,held,held)
  db.prepare("INSERT INTO scan_spend_calls (id,scan_job_id,user_id,attempt,kind,status,created_at,reserve_usd) VALUES ('n123456789','old',?,1,'llm.anthropic.web_search','reserved',?,?)").run(A,stale,held)
  const add=db.prepare("INSERT INTO tenant_spend_pools (tenant_id,period,reserved_usd,reported_usd,calls,updated_at) VALUES (?,?,?,0,0,?)")
  for (const w of new Set([periodOf('day',stale),periodOf('month',stale),periodOf('day',t),periodOf('month',t)])) add.run(A,w,held,stale)
  add.run(A,marker,held,t)
  assert.equal((await post(token)).body.error,'preview_spend_busy')
  db.prepare('UPDATE tenant_spend_pools SET updated_at=0 WHERE tenant_id=? AND period=?').run(A,marker)
  assert.equal((await post(token)).body.error,'preview_accounting_blocked')
  assert.equal(calls(),0)
  db.prepare("UPDATE scan_jobs SET status='failed', error='accounting_uncertain', claimed_at=NULL, finished_at=? WHERE id='old'").run(stale+1)
  add.run(A,'p:abcdef1234',0.001,0)
  assert.equal((await post(token)).body.error,'preview_accounting_blocked')
  assert.equal(calls(),0)
  // A second real signed session is unaffected by A's blocked accounting.
  assert.equal((await post(other)).status,200)
  assert.equal(calls(),1)
  db.prepare("DELETE FROM tenant_spend_pools WHERE tenant_id=? AND period='p:abcdef1234'").run(A)
  const before = await poolRows(d,A)
  const res=await post(token)
  assert.equal(res.status,200,JSON.stringify(res))
  assert.equal(res.body.inferred,true)
  assert.equal(calls(),2)
  const after = await poolRows(d,A)
  assert.deepEqual(after.find(r=>r.period===marker),before.find(r=>r.period===marker))
  assert.deepEqual(db.prepare("SELECT status,reserve_usd,actual_usd FROM scan_spend_calls WHERE id='n123456789'").get(),{status:'reserved',reserve_usd:held,actual_usd:null})
  for (const w of [periodOf('day',t),periodOf('month',t)]) {
    const r=after.find(r=>r.period===w)!
    assert.ok(Math.abs(r.reserved_usd-held-0.00018)<1e-9)
    assert.equal(r.reported_usd,0.00018)
  }
  console.log('PASS signed actual Next /api/scan/icp: 401 unsigned; fresh and active/stale/unattributed zero dispatch; two tenant-isolated synthetic completions; terminal hold still fully counted; no outbound transport.')
} catch(e) { console.error(output); throw e } finally {
  app.kill('SIGTERM')
  await Promise.race([new Promise(r=>app.once('exit',r)),sleep(5000)])
  if(app.exitCode===null) app.kill('SIGKILL')
  db.close()
  rmSync(dir,{recursive:true,force:true})
}
