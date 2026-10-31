// Original #349 source, offline text fixtures only. No eligibility write or model/search call.
import test from 'node:test'
import assert from 'node:assert/strict'
import {closedJobEvidence} from '../lib/scan/closed-job.ts'
import {verifyLeads} from '../lib/scan/runner.ts'
const url='https://startup.jobs/sales-development-representative-english-speaking-associate-clera-10390648'
const candidate={name:'',company:'Clera',contact:'unverified@example.test',signal:'Is hiring a Sales Development Representative',source_url:url,score:75,excerpt:'Own the English-speaking top of the sales funnel at a seed-stage AI communications software company',event_date:null}
const page={title:'Sales Development Representative (English-speaking), Associate at',text:`Sales Development Representative (English-speaking), Associate. London, United Kingdom Full-Time On-site. This job is no longer available and isn't accepting applications. About the Role. ${candidate.excerpt}`,retrievedAt:1793422800}
test('original Clera source explicit main-page closure returns exact provenance',()=>{
 assert.deepEqual(closedJobEvidence(candidate,page),{marker:'This job is no longer available',checkedAt:page.retrievedAt,sourceUrl:url})
})
test('same source closed lead stays research with no contact and no judge call',async()=>{
 let judges=0
 const before=structuredClone(candidate)
 const result=await verifyLeads([candidate],async()=>page,new Date('2026-10-31T05:00:00Z'),async()=>{judges++;return 'supports'},null,undefined,undefined,['London','UK'])
 assert.equal(result.leads.length,0);assert.equal(result.review[0]?.review_reason,'job_closed');assert.equal(result.review[0]?.contact,null);assert.equal(judges,0);assert.deepEqual(candidate,before)
})
test('startup.jobs absence of closure is unknown, not active confirmation',()=>{
 assert.equal(closedJobEvidence(candidate,{...page,text:candidate.excerpt}),null)
})
test('startup.jobs exact posting path only; hostname lookalikes, listings and company pages do not trigger',()=>{
 for(const source_url of ['https://startup.jobs/','https://startup.jobs/jobs','https://startup.jobs/companies/clera-10390648','https://startup.jobs/blog/clera-10390648','https://startup.jobs/sales-development-representative-clera','https://startup.jobs.evil.example/sales-development-representative-clera-10390648','https://evilstartup.jobs/sales-development-representative-clera-10390648'])assert.equal(closedJobEvidence({...candidate,source_url},page),null,source_url)
 assert.equal(closedJobEvidence({...candidate,signal:'Raised seed funding'},page),null)
})
test('startup.jobs footer beyond main text window does not hold, fetch failure stays unknown',async()=>{
 assert.equal(closedJobEvidence(candidate,{...page,text:'a '.repeat(1100)+page.text}),null)
 const result=await verifyLeads([candidate],async()=>({fail:'blocked'} as never))
 assert.equal(result.leads.length,0);assert.ok(!result.review.some(r=>r.review_reason==='job_closed'))
})
