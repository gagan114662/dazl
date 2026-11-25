import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runWithScanSpend, scanCapConfig, type ScanSpendCtx } from '../lib/scan/spend-cap.ts'
import { runClaudeWebSearch } from '../lib/llm/claude-web-search.ts'
import { createSearchBudget } from '../lib/discover/search-budget.ts'

function fixture() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  for (const [id, tenant] of [['one','a'],['two','a'],['foreign','b']]) {
    db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts) VALUES (?,?,'Fixture','Test','Test','running',1)").run(id,tenant)
  }
  const context = (jobId='one',tenantId='a',attempt=1): ScanSpendCtx => ({db,jobId,tenantId,attempt,
    cap:scanCapConfig({}),accountLimits:null,nativeSearch:true})
  const inJob = <T>(fn:()=>Promise<T>,jobId='one',tenantId='a',attempt=1) => runWithScanSpend(context(jobId,tenantId,attempt),fn)
  return {db,inJob}
}

test('1725 parallel search reservations share a durable15 maximum across recreated contexts',async()=>{
  const f=fixture()
  try {
    const allocations=await f.inJob(()=>Promise.all(Array.from({length:8},()=>createSearchBudget().reserve(4))))
    assert.equal(allocations.reduce((n,r)=>n+r.allowance,0),15)
    assert.equal((await f.inJob(()=>createSearchBudget().reserve(15))).allowance,0,'new process context cannot reset')
    assert.equal((await f.inJob(()=>createSearchBudget().reserve(15),'two')).allowance,15,'different scan independent')
    assert.equal((await f.inJob(()=>createSearchBudget().reserve(15),'foreign','b')).allowance,15,'different tenant independent')
  } finally {f.db.close()}
})

test('1725 proven unused allowance released once, uncertain usage retained on retry',async()=>{
  const f=fixture()
  try {
    const r=await f.inJob(()=>createSearchBudget().reserve(15))
    await r.settle(14)
    await r.settle(0)
    const last=await f.inJob(()=>createSearchBudget().reserve(15))
    assert.equal(last.allowance,1)
    await assert.rejects(last.settle(undefined),/usage/)
    f.db.prepare("UPDATE scan_jobs SET attempts=2 WHERE id='one'").run()
    assert.equal((await f.inJob(()=>createSearchBudget().reserve(15),'one','a',2)).allowance,0)
  } finally {f.db.close()}
})

test('1725 separate worker processes cannot reset or race the same scan allowance',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dazl-quota1725-'))
  const file=join(dir,'quota.db')
  try {
    const db=new Database(file)
    migrateAllSqlite(db)
    db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts) VALUES ('one','a','Fixture','Test','Test','running',1)").run()
    db.close()
    const child=()=>promisify(execFile)(process.execPath,['--experimental-strip-types',
      '--import','./test/helpers/net-fence.ts','./test/helpers/search-quota-1725-child.mts',file,'one','a'])
    const replies=await Promise.all(Array.from({length:8},child))
    assert.equal(replies.reduce((n,r)=>n+Number(r.stdout.trim()),0),15)
    assert.equal(Number((await child()).stdout.trim()),0,'subsequent process has no new allowance')
  } finally {rmSync(dir,{recursive:true,force:true})}
})

test('1725 legacy native research cannot bypass a scan already holding15 searches',async()=>{
  const f=fixture()
  let sends=0
  try {
    await f.inJob(()=>createSearchBudget().reserve(15))
    await assert.rejects(f.inJob(()=>runClaudeWebSearch('synthetic-fixture','Find buyers.',
      ()=>({settle:async()=>{},uncertain:()=>{},rejected:async()=>{}}),
      async()=>{sends++;return new Response('Fixture unavailable',{status:503})})))
    assert.equal(sends,0,'exhausted scan must not dispatch another native transport')
  } finally {f.db.close()}
})

test('1725 wrong tenant and stale attempt cannot reserve or release another scan allowance',async()=>{
  const f=fixture()
  try {
    await assert.rejects(f.inJob(()=>createSearchBudget().reserve(1),'one','b'),/ownership/)
    const r=await f.inJob(()=>createSearchBudget().reserve(15))
    f.db.prepare("UPDATE scan_jobs SET attempts=2 WHERE id='one'").run()
    await assert.rejects(r.settle(0),/ownership/)
    assert.equal((await f.inJob(()=>createSearchBudget().reserve(15),'one','a',2)).allowance,0)
  } finally {f.db.close()}
})
