import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { AuthorizedScorecardExecution } from '../lib/company-first/scorecard-dispatch.ts'
import { authorizeScorecardSubject, scorecardPinnedBudget, verifyScorecardTicket } from '../lib/company-first/scorecard-admission.ts'
import { bindReviewedCompanyPlan } from '../lib/company-first/scorecard-reviewed-company-plan.ts'
import { DISCOVERY_STRATEGIES } from '../lib/company-first/company-first-claude-request.ts'
import { prepareNativeDiscoveryVariant } from '../lib/company-first/company-first-native-transport.ts'

test('a protected plan retains signed role, exact date, and quote bindings',async()=>{
  const key=Buffer.alloc(32,43)
  const h=(s:string)=>createHmac('sha256',key).update(s).digest('hex')
  const hex=(n:number,d=64)=>n.toString(16).padStart(d,'0')
  const scope={tenantId:'fixture-tenant',actorId:'fixture-owner',jobId:hex(1,24),attempt:1,release:hex(2,40)}
  const revision=hex(3), e=Date.now()+60_000, signal=new AbortController().signal
  const day=(n:number)=>new Date(Date.now()-n*86_400_000).toISOString().slice(0,10)
  const criteria={category:'Technical services',place:'Fixture market',event:'hiring_posting',from:day(15),through:day(0)}
  const raw={...criteria,schema:'company-first-reviewed-v1',source:'greenhouse_reciprocal',roleKey:'hiring-role',placeKey:'reviewed-place',
    postingTitles:['Sales Development Representative'],buyerTitles:['Managing Director'],literalOnsitePlaces:['Fixture market'],
    maxUses:2,reserveMicros:3_000_000,forecasts:DISCOVERY_STRATEGIES.map(strategy=>({strategy,
      requestBinding:prepareNativeDiscoveryVariant(scope,criteria,2,strategy)!.binding,reserveMicros:500_000}))}
  function run(config:unknown){
    const subject={query:'Find the reviewed hiring event for case one',icp:JSON.stringify({summary:'Fixture'}),offer:'Research tools',
      sources:JSON.stringify({companyFirstReviewed:config})}
    const subjectMac=h(JSON.stringify(['legacy-observation-v1',scope.actorId,scope.tenantId,scope.jobId,scope.attempt,Math.floor(e/1000),
      subject.query,subject.icp,subject.offer,null,subject.sources,scorecardPinnedBudget()]))
    const encoded=Buffer.from(JSON.stringify([scope.tenantId,scope.actorId,scope.jobId,scope.attempt,revision,hex(4),1,hex(5),e,
      Array.from({length:7},(_,i)=>hex(100+i)),subjectMac,scope.release,'new'])).toString('base64url')
    const ticket=verifyScorecardTicket(encoded+'.'+h('dazl-scorecard-ticket:v1\n'+encoded),key,scope,Date.now())!
    assert.ok(ticket)
    const proof=authorizeScorecardSubject(ticket,subject)!
    assert.ok(proof)
    assert.equal(authorizeScorecardSubject(ticket,{...subject,sources:'{}'}),null)
    const execution:AuthorizedScorecardExecution={ticket,vendor:'anthropic',funding:'workspace_owned',
      *requireReservation(){throw new Error('plan does not reserve')}}
    return {ticket,plan:bindReviewedCompanyPlan(proof,execution,signal)}
  }
  const {ticket,plan}=run(raw)
  assert.ok(plan)
  assert.deepEqual(plan.publicReads.literalTitles,raw.postingTitles)
  assert.deepEqual((await plan.readReviewedPublicDiscovery(ticket,signal))?.requestedTitles,raw.buyerTitles)
  assert.equal(await plan.readReviewedPublicDiscovery({...ticket},signal),null)
  assert.equal(await plan.readReviewedPublicDiscovery(ticket,AbortSignal.abort()),null)
  assert.equal(run({...raw,reserveMicros:2_999_999}).plan,null)
  assert.equal(run({...raw,from:day(46)}).plan,null)
  assert.equal(run({...raw,buyerTitles:['Director','director']}).plan,null)
  assert.equal(run({...raw,forecasts:raw.forecasts.map((r,i)=>i? r : {...r,requestBinding:hex(5)})}).plan,null)
})
