import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { effectiveOffer, statedOffer } from '../lib/scan/play-offer-text.ts'
import { createQueryJob, migrateScan } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { saveKey, migrateKeys } from '../lib/llm/key-store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { migrateEvents } from '../lib/events/store.ts'

test('the full parenthetical offer label survives nested grammar and punctuation, not the buyer tail',()=>{
  const selection='Example.ai (training for (small) firms; incl. finance)'
  const q=`We sell ${selection} to independent studios in Oslo.`
  assert.equal(statedOffer(q),selection)
  assert.equal(statedOffer(`Offer: ${selection}. Find studios.`),selection)
  const choice=effectiveOffer({query:q},'Workspace plumbing subscription')
  assert.equal(choice.conflict?.stated,selection)
  assert.equal(statedOffer('Find companies (note: we sell unrelated tooling) in Oslo'),null)
  assert.equal(statedOffer('We sell Example.ai (unfinished'),'Example.ai')
})

test('inference on the product runner uses the explicitly selected play offer without mutating the saved seller snapshot',async()=>{
  const db=new Database(':memory:'), master=randomBytes(32), prompts:string[]=[]
  const seller='Workspace plumbing subscription - plumbing.example', offer='Studio project planning (teams with (contractors))'
  const old=process.env.DAZL_MASTER_KEY
  process.env.DAZL_MASTER_KEY=master.toString('base64')
  try{
    migrateScan(db);migrateKeys(db);migratePlans(db);migrateConnectors(db);migrateEvents(db)
    saveKey(db,'A','anthropic','sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',master)
    const id=createQueryJob(db,'A',{query:'Find studio owners in Oslo',seller,offer})
    const job=claimKeyedJob(db,id)!
    const provider:Provider={
      complete:async(_k,p)=>{prompts.push(p);return JSON.stringify({summary:'Oslo studios',who:['Owner'],where:['Oslo'],signals:[]})},
      research:async()=>({text:'[]',citedUrls:[]}),
    }
    const fetchImpl=(async()=>new Response('{}',{status:404})) as typeof fetch
    await runJob(db,job,{master,providers:{anthropic:provider,openai:provider},fetchImpl,score:false,ground:false})
    assert.ok(prompts[0]);assert.ok(prompts[0].includes(offer));assert.doesNotMatch(prompts[0],/plumbing|plumbing\.example/i)
    assert.deepEqual(db.prepare('SELECT seller,offer FROM scan_jobs WHERE id=?').get(id),{seller,offer})
  }finally{
    if(old===undefined)delete process.env.DAZL_MASTER_KEY;else process.env.DAZL_MASTER_KEY=old
    db.close()
  }
})

test('unfinished trailing qualifiers do not erase a complete stated offer or reveal nested grammar',()=>{
  const choice=effectiveOffer({query:'We sell CRM setup to studios (not finished'},'Workspace fleet software')
  assert.equal(choice.conflict?.stated,'CRM setup')
  assert.equal(statedOffer('We sell CRM setup (for studios (not finished'),'CRM setup')
  assert.equal(statedOffer('Find studios (we sell CRM setup'),null)
  assert.equal(statedOffer('We sell (unfinished'),null)
})

test('tight sentence punctuation separates targeting clauses while preserving dotted labels',()=>{
  assert.equal(statedOffer('We sell CRM setup.Find studios in Oslo'),'CRM setup')
  assert.equal(statedOffer('Offer: Example.ai.Find studios in Oslo'),'Example.ai')
  assert.equal(statedOffer('We sell Example.AI and Dotted.Brand services to studios'),'Example.AI and Dotted.Brand services')
  assert.equal(statedOffer('We sell Example.ai (for (small) firms.Find a better workflow) to studios'),'Example.ai (for (small) firms.Find a better workflow)')
})

test('an unfinished qualifier cannot silently hide a later explicit seller assertion',()=>{
  const base='CRM setup'
  for (const tail of ['We sell payroll support.', 'We also offer payroll support.', 'We are also providing payroll support.', 'Offer: payroll support.']) {
    const query=`We sell CRM setup (unfinished. ${tail}`
    assert.equal(statedOffer(query),base,'never extract the uncertain seller clause as the offer')
    const result=effectiveOffer({query},base)
    assert.equal(result.offer,null)
    assert.equal(result.conflict?.ambiguous,true)
    assert.equal(effectiveOffer({query,offer:'Payroll support'},base).offer,'Payroll support')
    assert.equal(effectiveOffer({query},null).conflict?.ambiguous,true)
  }
  assert.equal(effectiveOffer({query:'We sell CRM setup (unfinished but we also offer payroll support'},base).conflict?.ambiguous,true)
  assert.equal(effectiveOffer({query:'We sell CRM setup (an example: We also offer payroll support.)'},'CRM setup (an example: We also offer payroll support.)').conflict?.ambiguous,undefined)
  assert.equal(effectiveOffer({query:'We sell CRM setup (unfinished (We also offer payroll support.)'},base).conflict?.ambiguous,undefined,'a closed nested qualifier does not promote its contents')
  assert.equal(effectiveOffer({query:'We sell CRM setup (unfinished'},base).offer,base)
})
