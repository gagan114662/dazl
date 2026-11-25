import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runWithScanSpend, scanCapConfig } from '../lib/scan/spend-cap.ts'
import { runClaudeWebSearch, CLAUDE_SEARCH_MODEL } from '../lib/llm/claude-web-search.ts'
import { createSearchBudget } from '../lib/discover/search-budget.ts'
import { asStreaming } from './helpers/claude-sse.ts'

async function scenario(kind: string) {
 const db = new Database(':memory:'); migrateAllSqlite(db)
 db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,attempts) VALUES('one','a','Fixture','Test','Test','running',1)").run()
 const ctx = { db, jobId:'one', tenantId:'a', attempt:1, cap:scanCapConfig({}), accountLimits:null, nativeSearch:true }
 const marks: unknown[] = []; const calls: string[] = []; let maxUses: number | undefined; let error: { name?: string; code?: string; message?: string } | undefined
 try {
 await runWithScanSpend(ctx, async () => {
  if(kind === 'over-partial') {const previous=await createSearchBudget().reserve(15);await previous.settle(14)}
  try { await runClaudeWebSearch('synthetic-fixture','Find buyers.', () => {
    marks.push('reserve'); if(kind==='reserve-throw') throw Error('fixture reserve refusal')
    if(kind==='reserve-null') return null
    return {settle:(usd,usage)=>{marks.push(['settle',Math.round(usd * 1e9) / 1e9,usage.searches])},uncertain:()=>{marks.push('uncertain')},rejected:(status)=>{marks.push(['rejected',status])}}
   }, asStreaming(async (url,init)=>{
    if(String(url).endsWith('/count_tokens')) {calls.push('count');if(kind==='count-fail')throw Error('offline count failure');return Response.json({input_tokens:100})}
    calls.push('messages');maxUses=JSON.parse(String(init?.body)).tools[0].max_uses
    if(kind==='uncertain')throw Error('offline transport uncertainty')
    if(kind==='429')return Response.json({type:'error',error:{type:'rate_limit_error',message:'Fixture rate limit'},request_id:'req_fixture'},{status:429,headers:{'request-id':'req_fixture'}})
    if(kind==='ambiguous-429')return new Response(null,{status:429})
    if(kind==='401')return new Response(null,{status:401})
    return Response.json({model:CLAUDE_SEARCH_MODEL,type:'message',role:'assistant',stop_reason:'end_turn',content:[],usage:{input_tokens:100,output_tokens:10,server_tool_use:{web_search_requests:kind==='over-full'?3:kind==='over-partial'?2:1}}})
   })) } catch(e){error=e as typeof error}
 })
 const rows=db.prepare('SELECT allowance,used FROM scan_native_search_calls ORDER BY rowid').all()
 const remaining=await runWithScanSpend(ctx,()=>createSearchBudget().reserve(15))
 const result={kind,calls,maxUses,marks,error:error?{name:error.name,code:error.code,message:error.message}:null,rows,remaining:remaining.allowance}
 console.log('OBSERVATION '+JSON.stringify(result));return result
 } finally {db.close()}
}
for(const kind of ['over-full','over-partial'])test('A known actual must settle dollars and return typed violation '+kind,async()=>{
 const r=await scenario(kind)
 assert.deepEqual(r.calls,['count','messages'])
 assert.equal(r.maxUses,kind==='over-partial'?1:2)
 assert.deepEqual(r.marks,['reserve',['settle',kind==='over-partial'?0.02045:0.03045,kind==='over-partial'?2:3]],'known monetary actual must settle before rejecting the limit violation')
 assert.equal(r.error?.code,'provider_limit_violation')
 assert.deepEqual(r.rows,kind==='over-partial'?[{allowance:15,used:14},{allowance:1,used:null}]:[{allowance:2,used:null}])
 assert.equal(r.remaining,kind==='over-partial'?0:13)
})
for(const kind of ['count-fail','reserve-throw','reserve-null','429'])test('B proven unsent/refused releases persisted searches '+kind,async()=>{
 const r=await scenario(kind);assert.deepEqual(r.calls,kind==='429'||kind==='401'?['count','messages']:['count']);assert.equal(r.remaining,15,'no searches billed: persisted quota must be fully reusable');assert.deepEqual(r.rows,[{allowance:2,used:0}])
})
test('control valid actual settles both ledgers',async()=>{const r=await scenario('valid');assert.equal(r.error,null);assert.deepEqual(r.rows,[{allowance:2,used:1}]);assert.equal(r.remaining,14);assert.deepEqual(r.marks,['reserve',['settle',0.01045,1]])})
// Authentication refusal is not documented proof of zero billing in this transport.
for (const kind of ['401','ambiguous-429']) test('control unproven zero billing retains searches '+kind, async()=>{
 const r=await scenario(kind)
 assert.deepEqual(r.calls,['count','messages'])
 assert.deepEqual(r.rows,[{allowance:2,used:null}])
 assert.equal(r.remaining,13)
 assert.deepEqual(r.marks,kind==='401'?['reserve',['rejected',401]]:['reserve','uncertain'])
})
test('control uncertain transport retains allowance',async()=>{const r=await scenario('uncertain');assert.equal(r.error?.code,'request_uncertain');assert.deepEqual(r.rows,[{allowance:2,used:null}]);assert.equal(r.remaining,13);assert.deepEqual(r.marks,['reserve','uncertain'])})
