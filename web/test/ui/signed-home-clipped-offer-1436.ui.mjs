// Actual signed Home Play card from persisted SQLite, no API stubs.
// Build first; --http-only proves the real route, while the default also
// verifies the actual hydrated Home card in Chromium.
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
assert.ok(existsSync(join(dir,'.next/BUILD_ID')),'build the actual app before this test')
const root=mkdtempSync(join(tmpdir(),'dazl-signed-clipped-1436-')), file=join(root,'app.db')
const db=new Database(file)
const actor='fixture-owner',away='fixture-other',oldJob='a'.repeat(24)
const oldQuery='Find independent dental practices in New York City hiring a receptionist.'
// Historical bad bytes are fixture data, not an assertion of a valid new offer.
const clipped='CRM setup (including outbound'
const laterSeller='Synthetic unrelated current profile offer'
const fakeSession=()=>randomBytes(32).toString('hex')
const token=fakeSession(),other=fakeSession()
const port=pickUiPort(),base='http://127.0.0.1:'+port
let server,browser
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
try{
  migrateAllSqlite(db)
  for(const [id,session] of [[actor,token],[away,other]]){
    db.prepare("INSERT INTO users(id,email,business_name,website,password_hash,salt,email_verified_at) VALUES (?,?,?,'','x','y',1)").run(id,id+'@example.test',id===actor?'Fixture Owner':'Other Fixture')
    db.prepare("INSERT INTO organizations(id,name,kind,created_by,created_at) VALUES (?,?,'personal',?,1)").run(id,id,id)
    db.prepare("INSERT INTO memberships(tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(id,id)
    db.prepare('INSERT INTO sessions(id,user_id,active_tenant_id,expires_at) VALUES (?,?,?,unixepoch()+3600)')
      .run(createHash('sha256').update(session).digest('hex'),id,id)
  }
  db.prepare("UPDATE users SET sells=? WHERE id=?").run(laterSeller,actor)
  db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,offer,offer_set_at) VALUES (?,?,'fixture','fixture','fixture','done',?,?,1)")
    .run(oldJob,actor,oldQuery,clipped)
  const facts=()=>({
    jobs:db.prepare('SELECT * FROM scan_jobs ORDER BY id').all(),
    offers:db.prepare('SELECT id,sells,website,buyer_profile FROM users ORDER BY id').all(),
    spend:['scan_spend_calls','tenant_spend_pools','scan_model_calls'].map(t=>db.prepare('SELECT count(*) n FROM '+t).get().n),
  })
  const before=facts()
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
  const campaignPath='/api/campaigns/'+oldJob
  const get=(path,session)=>fetch(base+path,{headers:{cookie:'dazl_session='+session},redirect:'manual'})
  const response=await get(campaignPath,token)
  assert.equal(response.status,200)
  const campaign=await response.json()
  assert.equal(campaign.job.id,oldJob)
  assert.deepEqual(campaign.offer,{offer:null,source:'conflict',conflict:{stated:null,recorded:'',incomplete:true}})
  assert.equal(db.prepare('SELECT offer FROM scan_jobs WHERE id=?').get(oldJob).offer,clipped,'historical raw source remains unchanged')
  assert.equal((await get(campaignPath,other)).status,404)
  assert.equal((await get(campaignPath,'')).status,401)
  assert.equal((await get('/app',token)).status,200)
  assert.ok(!JSON.stringify(campaign.offer).includes(clipped))
  console.log('Signed campaign: incomplete offer conflict, original bytes unchanged, owner-only read.')
  if(!httpOnly){
    const {chromium}=require('playwright')
    browser=await chromium.launch()
    const context=await browser.newContext({serviceWorkers:'block'})
    await context.route(u=>u.origin!==base,r=>r.abort())
    await context.addCookies([{name:'dazl_session',value:token,url:base}])
    const page=await context.newPage(), writes=[]
    page.on('request',r=>{if(r.method()!=='GET'&&r.method()!=='HEAD'&&new URL(r.url()).pathname.startsWith('/api/'))writes.push(r.url())})
    const campaignRead=page.waitForResponse(r=>r.url()===base+campaignPath&&r.status()===200)
    await page.goto(base+'/app',{waitUntil:'networkidle'})
    assert.equal((await (await campaignRead).json()).offer.conflict.incomplete,true)
    const panel=page.getByTestId('journey-play-offer')
    const alert=panel.getByTestId('play-offer-conflict')
    await alert.getByText('One of the offers for this play is incomplete.',{exact:true}).waitFor()
    await alert.getByRole('button',{name:'Write what this play sells',exact:true}).click()
    assert.equal(await alert.getByRole('textbox',{name:'What this play sells'}).inputValue(),'')
    assert.ok(!(await panel.textContent()).includes(clipped))
    assert.ok(!(await panel.textContent()).includes(laterSeller))
    assert.deepEqual(writes,[])
    await context.close()
  }
  assert.deepEqual(facts(),before,'no persisted job, profile or spend changes')
}finally{
  await browser?.close()
  if(server&&server.exitCode===null){server.kill();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),sleep(3000)])}
  db.close();rmSync(root,{recursive:true,force:true})
}
