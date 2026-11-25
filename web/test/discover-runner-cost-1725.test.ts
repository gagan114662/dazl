// Actual runner and canonical money ledger; only the initial discovery answer is synthetic.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'

test('1725 actual runner retains full money hold and records unknown cost after enrichment fails',async()=>{
  const db=new Database(':memory:')
  const master=randomBytes(32)
  try {
    migrateAllSqlite(db)
    saveKey(db,'fixture1725','anthropic','synthetic-fixture',master)
    const id=createQueryJob(db,'fixture1725',{query:'Businesses opening a new branch',seller:'Commercial fit-out services'})
    const job=claimKeyedJob(db,id)
    assert.ok(job)
    const evidence='Fictional Cedar is opening a new branch.'
    const result:DiscoverResult={
      leads:[{company:'Fictional Cedar',signal:evidence,evidence_url:'https://fixture.example/branch',
        domain:null,person:null,title:null,person_source_url:null,linkedin_url:null,email:null,email_source_url:null,
        signal_date:null,evidence_quote:evidence,confidence:'high',why:'Expanding'}],
      seen:[{url:'https://fixture.example/branch',text:evidence,title:'Fictional Cedar',page_age:null}],
      usage:{input_tokens:10,output_tokens:1,cache_read_tokens:0,cache_write_tokens:0,searches:1,requests:1,usd:0.01},
      stop:'end_turn',model:'claude-sonnet-5-5',note:null}
    let posts=0
    await runJob(db,job,{master,discover:true,discoverImpl:async()=>result,
      fetchImpl:async(_url,init)=>{if(init?.body) posts++;return new Response('Fixture unavailable',{status:503})}})
    assert.equal(posts,1,'one real SDK send, never retried')
    const row=db.prepare('SELECT reserve_usd,actual_usd,status FROM scan_spend_calls WHERE scan_job_id=?').get(id) as {reserve_usd:number;actual_usd:number|null;status:string}
    assert.equal(row.status,'kept')
    assert.equal(row.actual_usd,null)
    assert.ok(row.reserve_usd>=0.3,'full original reservation, not only the cheap initial pass')
    const report=db.prepare('SELECT report FROM scan_run_report WHERE job_id=?').get(id) as {report:string}
    const discovery=JSON.parse(report.report).discover
    assert.equal(discovery.stop,'accounting_uncertain')
    assert.equal(discovery.usd,null,'no invented actual bill')
    assert.match(discovery.note,/reservation remains held/)
    const saved=db.prepare('SELECT COUNT(*) AS n FROM leads WHERE scan_job_id=?').get(id) as {n:number}
    assert.equal(saved.n,1,'already collected lead remains available for review')
  } finally {db.close()}
})
