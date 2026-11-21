import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { AUDIT_DDL } from '../lib/audit.ts'
import {issueWebsiteApproval,issueWebsiteDraftReceipt,readQueuedWebsiteApproval,recordQueuedWebsiteApproval,verifyWebsiteApproval} from '../lib/scan/website-profile-provenance.ts'

test('an authenticated website review is same-site, same actor, exact snapshot, one-use and atomic with the job',()=>{
  const k=Buffer.alloc(32,9), scope={tenantId:'a',actorId:'one'}, now=Date.now()
  const src=issueWebsiteDraftReceipt(k,scope,'https://fixture.example/about',now)!
  const s={query:'Find prospects',offer:'Fixture offer',icpJson:JSON.stringify({research:{site:'fixture.example'},who:['operator']})}
  assert.equal(issueWebsiteApproval(k,{...scope,actorId:'two'},src,s,now),null)
  assert.equal(issueWebsiteApproval(k,scope,src,{...s,icpJson:'{"research":{"site":"foreign.example"}}'},now),null)
  const token=issueWebsiteApproval(k,scope,src,s,now)!
  for (const bad of [{...s,query:'different'},{...s,offer:'different'},{...s,icpJson:'{}'}])
    assert.equal(verifyWebsiteApproval(k,scope,token,bad,now),null)
  assert.equal(verifyWebsiteApproval(k,scope,src,s,now),null)
  assert.equal(verifyWebsiteApproval(k,{...scope,tenantId:'b'},token,s,now),null)
  assert.equal(verifyWebsiteApproval(k,scope,token,s,now+300001),null)
  const proof=verifyWebsiteApproval(k,scope,token,s,now)!
  const db=new Database(':memory:')
  db.exec(AUDIT_DDL+'CREATE TABLE scan_jobs(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,query TEXT,offer TEXT,icp TEXT)')
  const add=(id:string)=>db.prepare("INSERT INTO scan_jobs VALUES (?,?,'pending',?,?,?)").run(id,scope.tenantId,s.query,s.offer,s.icpJson)
  assert.throws(db.transaction(()=>{add('rolled');assert.equal(recordQueuedWebsiteApproval(db,proof,'rolled',now),true);throw Error('rollback')}),/rollback/)
  assert.equal(readQueuedWebsiteApproval(db,scope.tenantId,'rolled'),false)
  db.transaction(()=>{add('good');assert.equal(recordQueuedWebsiteApproval(db,proof,'good',now),true)})()
  assert.equal(readQueuedWebsiteApproval(db,scope.tenantId,'good'),true)
  assert.equal(readQueuedWebsiteApproval(db,'b','good'),false)
  db.transaction(()=>{add('dup');assert.equal(recordQueuedWebsiteApproval(db,proof,'dup',now),false)})()
  assert.equal(readQueuedWebsiteApproval(db,scope.tenantId,'dup'),false)
  db.prepare("UPDATE scan_jobs SET offer='changed against approved choice' WHERE id='good'").run()
  assert.equal(readQueuedWebsiteApproval(db,scope.tenantId,'good'),false)
  assert.equal(db.prepare("SELECT count(*) n FROM audit_events").pluck().get(),1)
  db.close()
})

test('real estimate, queue and readonly status handlers exercise website-review admission',()=>{
  const cwd=fileURLToPath(new URL('..',import.meta.url))
  const env={...process.env};delete env.NODE_TEST_CONTEXT
  const out=spawnSync(process.execPath,['--experimental-strip-types','--import','./test/helpers/net-fence.ts',
    '--loader','./test/helpers/scan-route-loader.mjs','--test','--test-reporter=tap',
    './test/helpers/website-profile-provenance-runtime.mts'],{cwd,env,encoding:'utf8',timeout:60_000})
  assert.equal(out.status,0,out.stdout+out.stderr)
  assert.match(out.stdout,/# pass 1\b/)
})
