import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {placeAgreement} from '../lib/scan/place-agreement.ts'
import {ownPlaceAgreement} from '../lib/scan/own-block.ts'
const where=['London, UK']
test('flattened real pages: country lists, customer names and bylines do not invent competing UK cities',()=>{
 for(const [file,company] of [['ravical','Ravical'],['helmguard','HelmGuard']]){
  const page=JSON.parse(readFileSync(new URL(`./fixtures/london-source-binding/${file}.json`,import.meta.url),'utf8'))
  assert.equal(ownPlaceAgreement(page,where,company),'agrees',company)
 }
})
test('capitalized non-city tokens before UK do not override a company bound to London',()=>{
 for(const tail of ['Author Alice Jones London, UK, 29 October 2026.', 'Our customers include Barrons, UK.', 'Users across US, Canada, UK, Hong Kong and South Africa.', 'Thanks, UK readers.'])
  assert.equal(placeAgreement(`Synthetic Co is based in London. ${tail}`,where,'Synthetic Co'),'agrees',tail)
})
test('unknown and known company-bound cities still override incidental London, with no city allowlist exception',()=>{
 for(const city of ['Salisbury','Manchester','Bury St Edmunds','Aberystwyth']){
  for(const text of [`Synthetic Co is based in ${city}, UK. Market news: London startups raised more.`,`Synthetic Co, ${city}, England. News from London.`])
   assert.equal(placeAgreement(text,where,'Synthetic Co'),'mismatch',text)
 }
})
test('foreign London namesakes, own other-city address and unrelated London postcodes stay held',()=>{
 for(const text of ['Synthetic Co is based in London, Ontario. News from London, UK.', 'Synthetic Co is based in Manchester, UK. Supplier address: London EC1V 9HX.', 'Headquarters: 10 Wellington St, Leeds, UK. Satellite desk in London.', 'Synthetic Co, 14 Market Street, Salisbury, UK. News from London.', 'Our headquarters: 22 High Road, Bury St Edmunds, England. We serve London.'])
  assert.equal(placeAgreement(text,where,'Synthetic Co'),'mismatch',text)
 assert.equal(placeAgreement('Synthetic Co is a United Kingdom company. Customers include Canada, UK and Australia.',where,'Synthetic Co'),'unconfirmed')
})
test('real page geography is not qualification and does not rescue original wrong-city evidence',async()=>{
 const {verifyLeads}=await import('../lib/scan/runner.ts')
 const {splitByWindow}=await import('../lib/scan/window.ts')
 const page=JSON.parse(readFileSync(new URL('./fixtures/london-source-binding/ravical.json',import.meta.url),'utf8'))
 const start=page.text.indexOf('London, UK, 29 October 2026 : Ravical'),end=page.text.indexOf('new investor Shapers .',start)
 assert.ok(start>=0&&end>start)
 const excerpt=page.text.slice(start,end+'new investor Shapers .'.length)
 const candidate={company:'Ravical',name:'',contact:null,signal:'Ravical announced a $17m seed funding round.',source_url:'https://ravical.com/blog/ravical-secures-17m-to-help-accounting-firms-break-the-link-between-growth-and-headcount',excerpt,event_date:'2026-10-29',score:0}
 const result=await verifyLeads([candidate],async()=>page,new Date('2026-10-31T06:00:00Z'),undefined,null,undefined,undefined,where)
 assert.equal(result.leads.length,1);assert.equal(result.leads[0].event_date,'2026-10-29');assert.equal(result.leads[0].contact,null)
 assert.equal(result.leads[0].fit,undefined,'literal verification never fabricates ICP grading')
 assert.equal(splitByWindow(result.leads,90,new Date('2026-10-31T06:00:00Z')).inside.length,1)
 const original=JSON.parse(readFileSync(new URL('./fixtures/349-revnu-source.json',import.meta.url),'utf8'))
 assert.equal(ownPlaceAgreement(original,where,'Revnu'),'mismatch','the original Manchester candidate is still held')
})
test('an unknown-town street belongs to its named company, not a supplier or a news mention',()=>{
 for(const tail of ['Supplier address: 14 Market Street, Salisbury, UK.', 'Synthetic Co\'s accountant works at 22 High Road, Bury St Edmunds, England.', 'News: another business opens at 14 Market Street, Salisbury, UK.'])
  assert.equal(placeAgreement(`Synthetic Co is based in London. ${tail}`,where,'Synthetic Co'),'agrees',tail)
 assert.equal(placeAgreement('Synthetic Co, 14 Market Street, Salisbury, UK. Our UK office: 1 Old Street, London EC1V 9HX.',where,'Synthetic Co'),'agrees')
 for(const text of ['synthetic co, 14 market street, salisbury, uk. News from London.', 'SYNTHETIC CO, 22 HIGH ROAD, BURY ST EDMUNDS, ENGLAND. News from London.'])
  assert.equal(placeAgreement(text,where,'Synthetic Co'),'mismatch',text)
})
