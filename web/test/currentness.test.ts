import test from 'node:test'
import assert from 'node:assert/strict'
import {scoreLeads,scorePrompt} from '../lib/scan/score.ts'
import {eventTimingFresh} from '../lib/events/store.ts'
const lead={company:'Acme',name:'',signal:'Raised yesterday',excerpt:'Acme raised funding',event_date:'2026-10-01',date_status:'unverified'}
test('scoring cannot assign NOW from unverified dates even if provider ignores instructions',async()=>{
 const provider={research:async()=>({text:'',citedUrls:[]}),complete:async()=> 'LEAD 1 | fit 4 | intent 5 | action 3 | signals raised_funding | why urgent need right now'}
 const grades=await scoreLeads(provider,'test','ICP',[lead])
 assert.equal(grades?.[0].fit,4);assert.equal(grades?.[0].intent,0);assert.equal(grades?.[0].timing?.status,'unknown')
 assert.doesNotMatch(grades?.[0].why??'',/urgent need right now/);assert.match(grades?.[0].why??'',/Event timing is unconfirmed/)
 assert.match(scorePrompt('ICP',[lead]),/event association: unverified/)
})
test('publication, observation, invalid dates and stale rereads cannot create event freshness',()=>{
 const now=Date.parse('2026-10-23T12:00:00Z')/1000
 const row={event_type:'funding_round' as const,source_url:'https://news.example/acme',source_published_at:'2026-10-23',last_seen_at:now}
 assert.equal(eventTimingFresh(row,now),false)
 assert.equal(eventTimingFresh({...row,event_type:'hiring_surge',source_published_at:null},now),false)
 const filing={...row,event_type:'sec_filing' as const,source_url:'https://www.sec.gov/Archives/example',source_published_at:'2026-10-01'}
 assert.equal(eventTimingFresh(filing,now),true)
 for(const date of ['2026-02-30','2026-10-24','2024-01-01',null])assert.equal(eventTimingFresh({...filing,source_published_at:date},now),false)
 assert.equal(eventTimingFresh({...filing,source_url:'https://sec.gov.attacker.example/x'},now),false)
})

test('legacy verified label and present-tense quote cannot bypass deterministic NOW guard',async()=>{
 const provider={research:async()=>({text:'',citedUrls:[]}),complete:async()=> 'LEAD 1 | fit 5 | intent 5 | action 4 | signals expansion | why They need this NOW because they are expanding'}
 const grades=await scoreLeads(provider,'test','ICP',[{...lead,date_status:'verified',excerpt:'Acme is expanding now'}])
 assert.equal(grades?.[0].fit,5);assert.equal(grades?.[0].action,4);assert.equal(grades?.[0].intent,0)
 assert.doesNotMatch(grades?.[0].why??'',/need this NOW|are expanding/)
})
