import assert from 'node:assert/strict'
import test from 'node:test'
import {runProtectedScorecardOnce as run,type ProtectedControllerPorts as Ports} from '../lib/company-first/scorecard-controller.ts'
const hex=(n:number,w=64)=>n.toString(16).padStart(w,'0')
const scope={run:hex(1),tenant:'fixture-tenant',actor:'fixture-actor',release:hex(2,40),workspaceRevision:hex(3)}
const inputs=Array.from({length:7},(_,i)=>({business:`private fixture business ${i}`,place:'fixture region',buyer:'fixture role'}))
function setup(){
 const trace:string[]=[],reviewedByOrdinal=new Map<number,unknown>()
 let consumed=false,serial=0
 const p:Ports={
  async loadPrivateCases(){return structuredClone(inputs)},
  async consumeReviewedRun(){if(consumed)return false;consumed=true;return true},
  async resolveReviewedIntent(_scope,ordinal,x){
   assert.deepEqual(x,inputs[ordinal-1]);assert.ok(Object.isFrozen(x))
   return {digest:hex(200+ordinal),query:'fixture normalized intent',icp:'{"scope":"private"}',event:'fixture reviewed event',
       sourcePolicy:'fixture reviewed policy',sources:'[]',seller:null,offer:null}
  },
  async authorizationStillCurrent(){return true},
  async reserveReviewedCase(binding,reviewed){reviewedByOrdinal.set(binding.ordinal,reviewed);return {binding,hold:hex(300+binding.ordinal),amounts:{old:80,new:60,judge:30}}},
  async armSignedJob(budget,arm,reviewed){
   assert.equal(reviewedByOrdinal.get(budget.binding.ordinal),reviewed);assert.ok(Object.isFrozen(reviewed))
   trace.push(`arm:${budget.binding.ordinal}:${arm}`)
   return {case:budget.binding,arm,job:hex(++serial,24),attempt:1,hold:budget.hold,reservationLimitMicros:budget.amounts[arm]}
  },
  async executeOnce(binding,reviewed){
   assert.equal(reviewedByOrdinal.get(binding.case.ordinal),reviewed)
   trace.push(`run:${binding.case.ordinal}:${binding.arm}`)
   return {binding,state:'settled',actualMicros:10,counts:{candidates:5,rightPlace:3,proven:2}}
  },
 }
 return {p,trace}
}
test('seven private cases, 21 distinct ordered jobs, one durable authorization; emits only counts and cost',async()=>{
 const {p,trace}=setup()
 const r=await run(scope,p)
 assert.equal(r.state,'complete')
 assert.equal(r.cases.length,7)
 assert.deepEqual(r.cases[0],{ordinal:1,old:{candidates:5,rightPlace:3,proven:2,actualMicros:10},
   new:{candidates:5,rightPlace:3,proven:2,actualMicros:10},judge:{candidates:5,rightPlace:3,proven:2,actualMicros:10}})
 assert.deepEqual(trace,Array.from({length:7},(_,i)=>['old','new','judge'].flatMap(a=>[`arm:${i+1}:${a}`,`run:${i+1}:${a}`])).flat())
 for(const confidential of [...inputs.map(i=>i.business),'fixture-actor','sourcePolicy','digest','job','hold','fixture region'])
   assert.equal(JSON.stringify(r).includes(confidential),false)
 assert.deepEqual(await run(scope,{...p,loadPrivateCases:async()=>{assert.fail('never load unapproved private cases')}}),
   {state:'partial',cases:[],stop:{reason:'approval_refused',ordinal:null,arm:null}})
})
test('invalid private cohort, absent reviewed intent/event, and underfunding never arm',async()=>{
 const {p,trace}=setup()
 assert.deepEqual(await run(scope,{...p,loadPrivateCases:async()=>[...inputs.slice(0,6),inputs[0]]}),
   {state:'partial',cases:[],stop:{reason:'input_invalid',ordinal:null,arm:null}})
 const i=setup()
 let r=await run(scope,{...i.p,resolveReviewedIntent:async(...x)=>({...((await i.p.resolveReviewedIntent(...x))!),event:''})})
 assert.equal(r.state==='partial'&&r.stop.reason,'intent_unproven')
 const q=setup()
 r=await run(scope,{...q.p,reserveReviewedCase:async()=>null})
 assert.equal(r.state==='partial'&&r.stop.reason,'funding_refused')
 assert.deepEqual([...trace,...i.trace,...q.trace],[])
})
test('uncertain charge, mismatched case or reused job fail closed before a later lane',async()=>{
 const {p,trace}=setup()
 let r=await run(scope,{...p,executeOnce:async(binding)=>({binding,state:'unknown'})})
 assert.equal(r.state==='partial'&&r.stop.reason,'accounting_unknown')
 assert.deepEqual(trace,['arm:1:old'])
 const q=setup()
 r=await run(scope,{...q.p,executeOnce:async(binding,reviewed)=>{
   const old=await q.p.executeOnce(binding,reviewed)
   return old ? {...old,binding:{...binding,case:{...binding.case,ordinal:2}}} : null
 }})
 assert.equal(r.state==='partial'&&r.stop.reason,'receipt_unproven')
 assert.deepEqual(q.trace,['arm:1:old','run:1:old'])
 const w=setup()
 r=await run(scope,{...w.p,armSignedJob:async(...x)=>{
   const a=await w.p.armSignedJob(...x)
   return a?{...a,job:hex(1,24)}:null
 }})
 assert.equal(r.state==='partial'&&r.stop.arm,'new')
})
test('revocation between lanes and known overrun are different; never replay or count hidden proof',async()=>{
 const {p,trace}=setup()
 let reads=0
 let r=await run(scope,{...p,authorizationStillCurrent:async()=>++reads<5})
 assert.equal(r.state==='partial'&&r.stop.reason,'approval_changed')
 assert.deepEqual(trace,['arm:1:old','run:1:old'])
 const q=setup()
 r=await run(scope,{...q.p,executeOnce:async(binding,reviewed)=>{
   const a=await q.p.executeOnce(binding,reviewed)
   return a?.state==='settled'?{...a,actualMicros:81}:a
 }})
 assert.equal(r.state==='partial'&&r.stop.reason,'budget_exceeded')
 assert.deepEqual(r.cases[0].old,{candidates:null,rightPlace:null,proven:null,actualMicros:81})
 assert.deepEqual(q.trace,['arm:1:old','run:1:old'])
})
