import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyLeads } from '../lib/scan/runner.ts'

test('private placement metric observes affirmative verified candidate evidence only, without changing eligibility', async () => {
  const now=new Date('2026-11-20T00:00:00Z'), day='2026-11-15'
  const url='https://publisher.example/roundup'
  const correct='Sample Alder raised a $3M seed round for its London, England operations'
  const wrong='Sample Birch raised a $2M seed round for its Manchester, England operations'
  const unknown='Sample Cinder raised a $1M seed round to grow the business'
  const page={title:'Independent business round-up',text:`Posted ${day}. ${correct}. ${wrong}. ${unknown}. ${'Founders described their plans for the coming year. '.repeat(7)}`,retrievedAt:1}
  const rows=[['Sample Alder',correct],['Sample Birch',wrong],['Sample Cinder',unknown]].map(([company,excerpt])=>({
    company,excerpt,name:'',contact:null,signal:'seed round',source_url:url,score:72,event_date:day,
  }))
  const observed:string[]=[]
  const measured=await verifyLeads(rows,async()=>page,now,undefined,null,undefined,undefined,['London'],undefined,c=>observed.push(c.company))
  const ordinary=await verifyLeads(rows,async()=>page,now,undefined,null,undefined,undefined,['London'])
  assert.deepEqual(observed,['Sample Alder'])
  assert.deepEqual(measured.leads,ordinary.leads)
  assert.deepEqual(measured.review,ordinary.review)
})
