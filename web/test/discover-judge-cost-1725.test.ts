import test from 'node:test'
import assert from 'node:assert/strict'
import { signalJudge, ENTAIL_MODEL } from '../lib/discover/entail.ts'

for(const failure of ['http503','missingusage','wrongmodel']) test(`1725 evidence judge ${failure} keeps accounting uncertain without retry`,async()=>{
  let sends=0
  const judge=signalJudge({apiKey:'synthetic-fixture',fetch:async()=>{
    sends++
    if(failure==='http503') return new Response('Fixture unavailable',{status:503})
    return Response.json({id:'msg_fixture1725',type:'message',role:'assistant',
      model:failure==='wrongmodel'?'claude-opus-5-5':ENTAIL_MODEL,
      content:[{type:'text',text:'YES'}],stop_reason:'end_turn',
      usage:{...(failure==='missingusage'?{}:{input_tokens:10}),output_tokens:1}})
  }})
  await assert.rejects(judge.ask('Opening a branch','Fictional Cedar',['Fictional Cedar is opening a branch']))
  assert.equal(sends,1)
  assert.equal(judge.usage.accountingUncertain,true)
  await assert.rejects(judge.ask('Opening another branch','Fictional Elm',['Fictional Elm is opening a branch']))
  assert.equal(sends,1,'a later judgement must not start after uncertainty')
})
