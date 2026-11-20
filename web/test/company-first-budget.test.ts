import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measuredQuote, runBudgetedCompanyQueries, type Dependencies, type Lease, type Query, type Settlement } from '../lib/company-first/budget.ts'

const fixtureCohort='anthropic:messages:model-pinned:tool-dynamic:standard:USD:uncached:shape-1'
const query=(id:string, maxUses=1):Query=>({id,prompt:'different company intent '+id,cohort:fixtureCohort,fallbackMicros:100_000,maxUses})
const plan=(batches:Query[][])=>({enabled:true,payer:'own_key' as const,scope:{caseId:'case1',attempt:1},effectiveCapMicros:500_000,now:1_800_000_000,batches})
const frozen=()=>{ const trace:string[]=[]; let used=0; let reservedSearches=0; let serial=0; const held=new Map<string,Lease>()
  const deps:Dependencies<string>={approvedCohorts:new Set([fixtureCohort]),recent:async()=>[],
    async reserveBatch(scope,cap,quotes){const sum=quotes.reduce((n,q)=>n+q.reserveMicros,0), uses=quotes.reduce((n,q)=>n+q.maxUses,0);if(held.size||used+sum>cap||reservedSearches+uses>20)return null
      reservedSearches+=uses
      const lease:Lease={id:'lease'+ ++serial,scope,chargedTo:'shared_case_budget',totalMicros:sum,caseAuthorizedSearches:reservedSearches,quotes}
      held.set(lease.id,lease);used+=sum;trace.push('reserve:'+sum);return lease},
    async call(q,lease){assert.equal(held.get(lease.id),lease);trace.push('paid:'+q.id);return {state:'settled',actualMicros:75_000,searches:1,evidence:q.id}},
    async settleBatch(lease,rows){assert.equal(held.get(lease.id),lease);trace.push('settle');held.delete(lease.id)
      for(const r of rows) if(r.state==='known') used+=r.actualMicros-lease.quotes.find(q=>q.id===r.id)!.reserveMicros
      return true},
  }
  const bookOtherEngine=(micros:number)=>{used+=micros}
  return {deps,trace,bookOtherEngine,get used(){return used}}
}

test('flag off by default contract; trial is ineligible; planned uses validated before any dependency work',async()=>{
  const f=frozen(), p=plan([[query('one')]])
  assert.equal((await runBudgetedCompanyQueries({...p,enabled:false},f.deps)).reason,'disabled')
  assert.equal((await runBudgetedCompanyQueries({...p,payer:'trial'},f.deps)).reason,'ineligible')
  assert.equal((await runBudgetedCompanyQueries(plan([[query('one',4),query('two',2)]]),f.deps)).reason,'invalid_plan')
  assert.equal((await runBudgetedCompanyQueries(plan(Array.from({length:5},(_,i)=>[query('x'+i,5)])),f.deps)).reason,'invalid_plan')
  assert.deepEqual(f.trace,[])
})

test('shared old/new/judge cap rejects the whole parallel batch, never sends one sibling alone',async()=>{
  const f=frozen(); f.bookOtherEngine(250_000)
  const r=await runBudgetedCompanyQueries(plan([[query('one'),query('two')]]),f.deps)
  assert.equal(r.reason,'reservation_refused');assert.equal(f.used,250_000);assert.deepEqual(f.trace,[])
})

test('atomic reserve includes both siblings before they can start, settles before next batch',async()=>{
  const f=frozen(); f.bookOtherEngine(100_000)
  const result=await runBudgetedCompanyQueries(plan([[query('one'),query('two')],[query('three')]]),f.deps)
  assert.deepEqual(f.trace,['reserve:300000','paid:one','paid:two','settle','reserve:150000','paid:three','settle'])
  assert.deepEqual(result.evidence,['one','two','three']);assert.equal(f.used,325_000)
})

test('one unknown sibling keeps its entire reserve, settles known sibling, no later dispatch or failed-batch evidence',async()=>{
  const f=frozen(); const captured:Settlement[][]=[]
  const r=await runBudgetedCompanyQueries(plan([[query('one'),query('two')],[query('later')]]),{...f.deps,
    async call(q,l){if(q.id==='two') throw Error('unknown network disposition');return f.deps.call(q,l)},
    async settleBatch(lease,rows){captured.push([...rows]);return f.deps.settleBatch(lease,rows)},
  })
  assert.equal(r.reason,'accounting_uncertain');assert.deepEqual(r.evidence,[])
  assert.deepEqual(captured,[[{id:'one',state:'known',actualMicros:75_000},{id:'two',state:'uncertain'}]])
  assert.equal(f.used,225_000);assert.deepEqual(f.trace,['reserve:300000','paid:one','settle'])
})

test('use last 20 exact cohort/maxUses at 1.5x; never mix older or mismatched transport',()=>{
  const p=plan([[query('one')]])
  const samples=Array.from({length:21},(_,i)=>({id:'s'+i,maxUses:1,cohort:fixtureCohort,status:'production_settled' as const,
    settledAt:p.now-i,actualMicros:i===20?900_000:i===19?240_001:80_000}))
  samples.push({...samples[0],id:'other',cohort:'different-tier',actualMicros:900_000})
  assert.equal(measuredQuote(query('one'),p.now,samples).reserveMicros,360_002)
  assert.equal(measuredQuote(query('one'),p.now,[]).reserveMicros,150_000)
})

test('two concurrent adapters share one case lifetime search ledger, including across attempts',async()=>{
  const f=frozen()
  const heavy=(id:string)=>Array.from({length:4},(_,i)=>[query(id+i,5)])
  const [a,b]=await Promise.all([
    runBudgetedCompanyQueries({...plan(heavy('a')),effectiveCapMicros:4_000_000},f.deps),
    runBudgetedCompanyQueries({...plan(heavy('b')),effectiveCapMicros:4_000_000,scope:{caseId:'case1',attempt:2}},f.deps),
  ])
  assert.equal(a.authorizedSearches+b.authorizedSearches,20)
  assert.equal(f.trace.filter(x=>x.startsWith('paid:')).length,4)
})

test('settles authenticated overshoot, then stops rather than releasing or dispatching again',async()=>{
  const f=frozen()
  const r=await runBudgetedCompanyQueries(plan([[query('one')],[query('later')]]),{...f.deps,
    async call(q,l){const result=await f.deps.call(q,l); return {...result,actualMicros:180_000}},
  })
  assert.equal(r.reason,'estimate_exceeded');assert.deepEqual(r.evidence,[])
  assert.equal(f.used,180_000);assert.deepEqual(f.trace,['reserve:150000','paid:one','settle'])
})
