// Real loopback Next + persisted throwaway SQLite; no API interception or
// provider stubs. Default runs Playwright too. Use --http-only where Chromium
// is unavailable; --same-brand uses the current brand with stale targeting.
// Build the ordinary app first. Confirmation queues a real fixture job,
// but zero worker slots and the network fence prevent provider execution.
import { createRequire } from 'node:module'
import { createHash,randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync,mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pickUiPort } from '../helpers/ui-port.mjs'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

const dir=fileURLToPath(new URL('../../',import.meta.url))
const require=createRequire(join(dir,'package.json'))
const Database=require('better-sqlite3')
const httpOnly=process.argv.includes('--http-only')
const sameBrand=process.argv.includes('--same-brand')
assert.ok(existsSync(join(dir,'.next/BUILD_ID')),'build the actual app before this test')
const root=mkdtempSync(join(tmpdir(),'dazl-signed-offer-1436-')), file=join(root,'app.db')
const db=new Database(file)
const actor='fixture-owner',away='fixture-other',oldJob='a'.repeat(24)
const oldQuery='Find independent dental practices in New York City hiring a receptionist.'
const dental='Dental appointment reminder software'
const savedOffer=sameBrand?'dazl':dental
const chosenOffer=sameBrand?savedOffer:'Software for finding qualified business leads'
const buyer={summary:'Independent dental practices in New York City',who:['Practice owner'],where:['New York City'],industries:['Dental'],sizes:[],signals:[],exclude:[],country:'US',language:'en',window_days:45}
const query='Find leads for dazl (dazl.ai): small marketing and creative agencies in Toronto, Ontario hiring an SDR or sales development rep.'
const fakeSession=()=>randomBytes(32).toString('hex')
const token=fakeSession(),other=fakeSession()
const port=pickUiPort(),base='http://127.0.0.1:'+port
let server,browser
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
try{
  migrateAllSqlite(db)
  for(const [id,session] of [[actor,token],[away,other]]){
    db.prepare("INSERT INTO users(id,email,business_name,website,password_hash,salt,email_verified_at) VALUES (?,?,?,'','x','y',1)").run(id,id+'@example.test',id===actor?'dazl':'Other Fixture')
    db.prepare("INSERT INTO organizations(id,name,kind,created_by,created_at) VALUES (?,?,'personal',?,1)").run(id,id,id)
    db.prepare("INSERT INTO memberships(tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(id,id)
    db.prepare('INSERT INTO sessions(id,user_id,active_tenant_id,expires_at) VALUES (?,?,?,unixepoch()+3600)')
      .run(createHash('sha256').update(session).digest('hex'),id,id)
    // An inert record so readHasKey takes the BYOK estimate branch. This is
    // intentionally not a decryptable key. Nothing may dispatch a provider.
    db.prepare("INSERT INTO tenant_llm_keys(tenant_id,vendor,ciphertext,last4,validated_at) VALUES (?,'anthropic','fixture-not-credential','0000',1)").run(id)
  }
  db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,icp,icp_inferred) VALUES (?,?,'fixture','Dental','New York City','done',?,?,0)")
    .run(oldJob,actor,oldQuery,JSON.stringify(buyer))
  const history=()=>db.prepare('SELECT * FROM scan_jobs ORDER BY id').all()
  const spending=()=>['scan_spend_calls','tenant_spend_pools','scan_model_calls'].map(t=>db.prepare('SELECT count(*) n FROM '+t).get().n)
  const h0=history(),m0=spending()
  server=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{
    cwd:dir,env:{PATH:process.env.PATH,HOME:root,DB_PATH:file,SCAN_MAX_CONCURRENT:'0',SITECRAWL_ENABLED:'0',NEWS_SEARCH_ENABLED:'0',
      NEXT_TELEMETRY_DISABLED:'1',NODE_OPTIONS:'--import '+join(dir,'test/helpers/net-fence.ts')},stdio:['ignore','pipe','pipe'],
  })
  let log=''
  for(const side of [server.stdout,server.stderr])side.on('data',chunk=>{log=(log+chunk).slice(-6000)})
  let online=false
  for(let i=0;i<100;i++){
    if(server.exitCode!==null)break
    try{if((await fetch(base+'/sign-in',{redirect:'manual'})).status<500){online=true;break}}catch{}
    await sleep(150)
  }
  assert.ok(online,'Next did not start: '+log)
  async function request(path,body,session=token){
    const res=await fetch(base+path,{redirect:'manual',method:body===undefined?'GET':'POST',
      headers:{cookie:'dazl_session='+session,origin:base,...(body===undefined?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})})
    return {status:res.status,data:await res.json().catch(()=>null)}
  }
  assert.equal((await request('/api/settings/profile',undefined,'')).status,401)
  const save=await request('/api/settings/profile',{business_name:'dazl',sells:savedOffer,website:'https://dazl.ai',buyer})
  assert.equal(save.status,200,JSON.stringify(save.data))
  const stored=await request('/api/settings/profile')
  assert.equal(stored.status,200)
  assert.equal(stored.data.new_play_offer,savedOffer)
  assert.equal(stored.data.buyer.summary,buyer.summary)
  const otherSettings=await request('/api/settings/profile',undefined,other)
  assert.equal(otherSettings.data.buyer,null)
  assert.notEqual(otherSettings.data.new_play_offer,savedOffer)
  const latest=await request('/api/scan/latest')
  assert.equal(latest.status,200)
  assert.equal(latest.data.query,oldQuery)
  assert.equal(latest.data.icp.summary,buyer.summary)
  const leads=await fetch(base+'/app/leads',{headers:{cookie:'dazl_session='+token},redirect:'manual'})
  assert.equal(leads.status,200)
  assert.match(await leads.text(),/Who do you want to reach/)
  const before=await request('/api/scan/estimate',{query,icp:latest.data.icp,reviewed:false})
  console.log('signed old-context quote status:',before.status,'same brand:',sameBrand)
  assert.equal(before.status,409,'No cost panel before a real offer choice')
  assert.deepEqual(before.data,{error:'offer_conflict',stated:'dazl',saved:savedOffer,fresh_target:true})
  const outside=await request('/api/scan/estimate',{query,icp:latest.data.icp,reviewed:false},other)
  assert.notEqual(outside.data?.saved,savedOffer,'another workspace cannot learn the stored offer')
  const selected=await request('/api/scan/estimate',{query,offer:chosenOffer})
  assert.equal(selected.status,200,JSON.stringify(selected.data))
  assert.equal(selected.data.estimate.verdict.ok,true)
  assert.equal(typeof selected.data.estimate.ack,'string')
  assert.ok(selected.data.estimate.ack.length>0)
  console.log('signed HTTP: Settings persisted; Leads loaded; 409 Use: dazl; chosen estimate accepted')
  let jobId
  if(httpOnly){
    const admitted=await request('/api/scan',{query,offer:chosenOffer,estimate_ack:selected.data.estimate.ack})
    assert.equal(admitted.status,202,JSON.stringify(admitted.data))
    jobId=admitted.data.job_id
  }else{
    const {chromium}=require('playwright')
    browser=await chromium.launch()
    const context=await browser.newContext({serviceWorkers:'block'})
    // Browser egress only: no loopback/API request is stubbed or altered.
    await context.route(u=>u.origin!==base,r=>r.abort())
    await context.addCookies([{name:'dazl_session',value:token,url:base}])
    const page=await context.newPage()
    const admissions=[]
    page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/scan')admissions.push(r.url())})
    await page.goto(base+'/app/leads',{waitUntil:'networkidle'})
    await page.getByTestId('business-profile').filter({hasText:buyer.summary}).waitFor()
    await page.getByLabel('Who do you want to reach?').fill(query)
    const conflictResponse=page.waitForResponse(r=>r.url()===base+'/api/scan/estimate'&&r.status()===409)
    await page.getByRole('button',{name:'Find leads'}).click()
    assert.ok((await conflictResponse).request().postDataJSON().icp)
    const use=page.getByRole('button',{name:'Use: dazl',exact:true})
    await use.waitFor()
    await page.getByRole('button',{name:'Keep saved targeting',exact:true}).waitFor()
    assert.equal(await page.getByTestId('estimate-confirm').count(),0)
    const quoteResponse=page.waitForResponse(r=>r.url()===base+'/api/scan/estimate'&&r.status()===200)
    await use.click()
    if(!sameBrand){
      const field=page.getByRole('textbox',{name:'What does this play sell?'})
      await field.waitFor()
      assert.equal(await field.inputValue(),'','do not reuse the unrelated saved offer or insert the workspace name')
      await field.fill(chosenOffer)
      await page.getByRole('button',{name:'Use this offer',exact:true}).click()
    }
    const quote=await quoteResponse
    const submitted=quote.request().postDataJSON()
    assert.equal(submitted.query,query)
    assert.equal(submitted.offer,chosenOffer)
    assert.equal('icp' in submitted,false)
    assert.equal('reviewed' in submitted,false)
    const confirm=page.getByTestId('estimate-confirm-run')
    await confirm.waitFor()
    assert.deepEqual(admissions,[],'an offer selection and a quote alone admit nothing')
    const admitting=page.waitForResponse(r=>r.url()===base+'/api/scan'&&r.request().method()==='POST')
    await confirm.click()
    const admitted=await admitting
    const approved=admitted.request().postDataJSON()
    assert.equal(approved.query,query)
    assert.equal(approved.offer,chosenOffer)
    assert.equal(approved.estimate_ack,(await quote.json()).estimate.ack)
    assert.equal('icp' in approved,false)
    assert.equal('reviewed' in approved,false)
    const result=await admitted.json()
    assert.equal(admitted.status(),202,JSON.stringify(result))
    jobId=result.job_id
    assert.deepEqual(admissions,[base+'/api/scan'])
    await context.close()
  }
  assert.deepEqual(await request('/api/settings/profile'),stored)
  assert.match(jobId,/^[a-f0-9]{24}$/)
  const statusPath='/api/scan/status?readonly=1&job_id='+jobId
  const readback=await request(statusPath)
  assert.equal(readback.status,200)
  assert.equal(readback.data.job_id,jobId)
  assert.equal(readback.data.query,query)
  assert.equal(readback.data.icp,null,'the old dental ICP must not be attached to the new job')
  assert.equal(readback.data.status,'pending')
  assert.equal(readback.data.attempts,0)
  assert.equal((await request(statusPath,undefined,other)).status,404)
  const all=history()
  const queued=all.find(row=>row.id===jobId)
  assert.ok(queued)
  assert.equal(queued.user_id,actor)
  assert.equal(queued.offer,chosenOffer)
  assert.deepEqual(all.filter(row=>row.id!==jobId),h0,'existing jobs must remain untouched')
  assert.deepEqual(spending(),m0,'no provider or spend rows')
  assert.equal(db.prepare('SELECT count(*) AS n FROM leads WHERE scan_job_id=?').get(jobId).n,0)
  console.log('Signed confirmation stored the chosen offer and query, with no inherited targeting, provider execution, spend, or saved-profile changes.')
}finally{
  await browser?.close()
  if(server&&server.exitCode===null){server.kill();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),sleep(3000)])}
  db.close();rmSync(root,{recursive:true,force:true})
}
