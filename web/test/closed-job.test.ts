import test from 'node:test'
import assert from 'node:assert/strict'
import { closedJobEvidence } from '../lib/scan/closed-job.ts'
import { verifyLeads } from '../lib/scan/runner.ts'
const candidate={name:'',company:'JM Eagle',contact:null,signal:'Hiring Sales Operations Manager',source_url:'https://www.linkedin.com/jobs/view/sales-operations-manager-at-jm-eagle-4469961360',score:80,excerpt:'JM Eagle is hiring a Sales Operations Manager',event_date:null}
const page={title:'Sales Operations Manager at JM Eagle',text:'JM Eagle is hiring a Sales Operations Manager. No longer accepting applications.',retrievedAt:1792696500}
test('closed-job marker preserves exact source evidence and check time',()=>{
  assert.deepEqual(closedJobEvidence(candidate,page),{marker:'No longer accepting applications',checkedAt:1792696500,sourceUrl:candidate.source_url})
})
test('absence of marker is unknown activity, not active confirmation',()=>{
  assert.equal(closedJobEvidence(candidate,{...page,text:candidate.excerpt}),null)
})
test('generic company news and footer jobs do not trigger closure',()=>{
  assert.equal(closedJobEvidence({...candidate,source_url:'https://linear.app/now/update'},page),null)
  assert.equal(closedJobEvidence(candidate,{...page,text:'a '.repeat(1100)+page.text}),null)
})
test('closed page goes to review with no contact and no model judgment',async()=>{
  let judgments=0
  const result=await verifyLeads([candidate],async()=>page,new Date('2026-10-22T00:00:00Z'),async()=>{judgments++;return 'supports'})
  assert.equal(result.leads.length,0);assert.equal(result.review[0].review_reason,'job_closed');assert.equal(result.review[0].contact,null);assert.equal(judgments,0)
})
test('inaccessible sources remain unknown, not closed',async()=>{
  const result=await verifyLeads([candidate],async()=>({fail:'blocked'} as never))
  assert.equal(result.leads.length,0)
  assert.ok(!result.review.some(r=>r.review_reason==='job_closed'))
})
test('short-page footer marker: positional window cannot isolate footer content (documented limitation)',()=>{
  // The first-2000-visible-characters window is a positional heuristic, not
  // structural header isolation. On a short page (<2000 chars) a closure marker
  // that sits in the footer region (e.g. a "similar jobs" recommendation card)
  // is still inside the window and still triggers. This false-positive path is
  // preserved deliberately: the detector does not parse scoped job content, so
  // the row lands in review where a person checks the source. Longer pages are
  // safe because footer markers fall outside the window (see test above).
  const shortFooter={...page,text:'Sales Operations Manager at JM Eagle. Apply on our careers site. '+'similar jobs: sales rep at acme '.repeat(20)+'this position is no longer available'}
  const hit=closedJobEvidence(candidate,shortFooter)
  assert.ok(hit,'known limitation: short-page footer markers inside the 2000-char window trigger review')
  assert.equal(hit.marker.toLowerCase(),'this position is no longer available')
})
