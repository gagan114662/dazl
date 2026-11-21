// Run after an ordinary production build: node --experimental-strip-types test/ui/signed-website-review.ui.mjs
// Real signed Next endpoints, real SQLite, real estimates and queue/status.
// Only the public page's external transport and dummy Anthropic wire are replayed.
import '../helpers/net-fence.ts'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createPasswordUser, createSession } from '../../lib/auth-db.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { confirmEmail } from '../helpers/confirmed.ts'
import { pickUiPort } from '../helpers/ui-port.mjs'

const dir=fileURLToPath(new URL('../../',import.meta.url))
const require=createRequire(join(dir,'package.json'))
assert.ok(existsSync(join(dir,'.next/BUILD_ID')),'Build the ordinary app before running this test')
const {chromium}=require(process.env.DAZL_TEST_PLAYWRIGHT_MODULE||'playwright')
const root=mkdtempSync(join(tmpdir(),'dazl-signed-website-review-')),file=join(root,'app.db')
const freshActor='first-run-website-fixture'
const actor='website-review-fixture', business='Fixture Booking', offer='Fixture Booking'
const oldOffer='Former saved consulting offer'
const oldProfile={summary:'Unrelated historical buyers',who:['Prior owner'],industries:[],sizes:[],where:[],signals:[],exclude:[]}
const query='Find operators with dated hiring evidence; seller = Fixture Booking'
const site='https://seller.fixture.test/'
const db=new Database(file),d=sqliteDb(db)
let app,browser
let logs=''
const websiteGets=[]
const web=createServer((req,res)=>{
  if(req.method!=='GET'||!['/single','/multiple'].includes(req.url)){res.writeHead(404).end();return}
  websiteGets.push(req.url)
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(
    '<html><head><title>Fixture seller</title></head><body><h1>Fixture seller</h1><p>We sell Fixture Booking.</p><p>We sell Fixture Analytics.</p><p>Fixture Booking helps service coordinators manage appointments.</p><p>Our products help teams organize intake and dispatch while keeping the members of their operations team up to date.</p></body></html>')
})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
try {
  await new Promise((ok,no)=>{web.once('error',no);web.listen(0,'127.0.0.1',ok)})
  migrateAllSqlite(db)
  await createPasswordUser({id:actor,email:'reviewer@fixture.test',name:actor,business_name:business,password_hash:'unused',salt:'unused'},d)
  await confirmEmail(d,actor)
  saveKey(db,actor,'anthropic','sk-ant-api03-SYNTHETICFIXTUREONLY000000000000000',Buffer.alloc(32,55))
  const session=await createSession(actor,d)
  await createPasswordUser({id:freshActor,email:'first-run@fixture.test',name:freshActor,business_name:'',password_hash:'unused',salt:'unused'},d)
  await confirmEmail(d,freshActor)
  saveKey(db,freshActor,'anthropic','sk-ant-api03-SYNTHETICFIXTUREONLY000000000000000',Buffer.alloc(32,55))
  const freshSession=await createSession(freshActor,d)
  db.prepare('UPDATE users SET sells=?, buyer_profile=? WHERE id=?').run(oldOffer,JSON.stringify(oldProfile),actor)
  const initial=db.prepare('SELECT sells,buyer_profile FROM users WHERE id=?').get(actor)
  const port=pickUiPort(),base='http://127.0.0.1:'+port
  app=spawn(process.execPath,['--experimental-strip-types','--import',join(dir,'test/helpers/signed-website-review-wire.mjs'),
    require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{
      cwd:dir,env:{PATH:process.env.PATH,HOME:root,DB_PATH:file,DAZL_FIXTURE_SITE_PORT:String(web.address().port),
        DAZL_ANTHROPIC_MODEL:'claude-sonnet-4-5',SCAN_MAX_CONCURRENT:'0',SITECRAWL_ENABLED:'0',NEWS_SEARCH_ENABLED:'0',NEXT_TELEMETRY_DISABLED:'1'},
      stdio:['ignore','pipe','pipe']})
  for(const side of [app.stdout,app.stderr])side.on('data',c=>{logs=(logs+c).slice(-4000)})
  let online=false
  for(let i=0;i<120&&!online&&app.exitCode===null;i++){try{online=(await fetch(base+'/sign-in')).ok}catch{} if(!online)await sleep(100)}
  assert.ok(online,'built Next app did not start')
  assert.equal((await fetch(base+'/api/settings/profile')).status,401)
  browser=await chromium.launch(process.env.DAZL_TEST_CHROMIUM?{executablePath:process.env.DAZL_TEST_CHROMIUM}:{})
  const ctx=await browser.newContext({serviceWorkers:'block'})
  await ctx.route(u=>u.origin!==base,r=>r.abort()) // only egress blocked; no app response interception
  await ctx.addCookies([{name:'dazl_session',value:session,url:base}])
  const page=await ctx.newPage(), posts=[]
  const shots=process.env.SHOTS
  const capture=async name=>{if(shots){mkdirSync(shots,{recursive:true});await page.screenshot({path:join(shots,name+'.png'),fullPage:true})}}
  page.on('request',r=>{if(r.method()==='POST'&&r.url().startsWith(base+'/api/scan'))posts.push(new URL(r.url()).pathname)})
  await page.goto(base+'/app/leads')
  const requestBox=page.getByLabel('Who do you want to reach?')
  await requestBox.fill('Find operators with dated hiring evidence')
  await page.getByTestId('play-settings').locator('summary').first().click()
  await page.getByTestId('more-sources').locator('summary').first().click()
  const input=page.getByPlaceholder('Your website - we will fill the profile from it')
  const review=page.getByTestId('research-review')
  async function build(path){
    await input.fill(site+path)
    const pending=page.waitForResponse(r=>r.url()===base+'/api/scan/icp-from-url'&&r.request().method()==='POST')
    await page.getByRole('button',{name:'Fill from my website',exact:true}).click()
    const r=await pending
    assert.equal(r.status(),200)
    const data=await r.json()
    assert.equal(data.source,site+path)
    assert.equal(typeof data.website_draft_receipt,'string')
    await review.waitFor()
  }

  await build('multiple')
  const sourced=review.locator('li').filter({hasText:'service coordinators'})
  assert.match(await sourced.innerText(),/on your site:.*Fixture Booking helps service coordinators manage appointments/s)
  assert.equal(await sourced.locator(`a[href="${site}multiple"]`).count(),1)
  await sourced.getByRole('button',{name:'Add',exact:true}).click()
  assert.equal(await sourced.locator(`a[href="${site}multiple"]`).count(),1)
  const question=page.getByTestId('research-question')
  await question.getByRole('button',{name:'Fixture Analytics',exact:true}).click()
  await page.getByTestId('research-answered').filter({hasText:'Fixture Analytics'}).waitFor()
  await capture('website-offer-pick')
  // Merely reviewing or picking an offer does not price or queue a play.
  assert.deepEqual(posts,['/api/scan/icp-from-url'])
  const visibleOffer=page.getByTestId('review-offer-input')
  await visibleOffer.waitFor()
  assert.equal(await visibleOffer.inputValue(),'Fixture Analytics')
  const alternateQuote=page.waitForResponse(r=>r.url()===base+'/api/scan/estimate'&&r.request().method()==='POST')
  await page.getByRole('button',{name:'Run scan with this profile',exact:true}).last().click()
  const alt=await alternateQuote
  assert.equal(alt.status(),200)
  const altSent=alt.request().postDataJSON()
  assert.equal(altSent.offer,'Fixture Analytics')
  assert.equal(altSent.icp.research.ans.q,'Which of your offers is this play for?')
  assert.equal(altSent.icp.research.offers.find(row=>row.i===altSent.icp.research.ans.o).n,'Fixture Analytics')
  await page.getByTestId('estimate-confirm-run').waitFor()
  await page.getByRole('button',{name:'Discard website draft',exact:true}).click()

  await requestBox.fill(query)
  await build('single')
  const option=page.getByRole('button',{name:'Use: Fixture Booking',exact:true})
  await option.waitFor()
  assert.equal(await page.getByTestId('estimate-confirm').count(),0)
  await page.getByRole('button',{name:'Review website profile',exact:true}).click()
  assert.deepEqual(posts,['/api/scan/icp-from-url','/api/scan/estimate','/api/scan/icp-from-url'])
  await option.click()
  const ops=review.locator('li').filter({hasText:'operations managers'})
  await ops.getByRole('button',{name:'Add',exact:true}).click()
  const sales=review.locator('li').filter({hasText:'sales managers'})
  await sales.getByRole('button',{name:'Dismiss',exact:true}).click()
  await review.getByText('Dismissed targeting (restore explicitly)').click()
  await review.getByRole('button',{name:'Restore',exact:true}).click()
  await sales.getByRole('button',{name:'Dismiss',exact:true}).click()
  await question.locator('input').fill('dispatch leaders')
  await question.getByRole('button',{name:'Save',exact:true}).click()
  await page.getByTestId('research-answered').filter({hasText:'dispatch leaders'}).waitFor()
  const priced=page.waitForResponse(r=>r.url()===base+'/api/scan/estimate'&&r.request().method()==='POST')
  await page.getByRole('button',{name:'Run scan with this profile',exact:true}).last().click()
  const price=await priced
  assert.equal(price.status(),200)
  assert.ok((await price.json()).website_approval_receipt)
  await page.getByTestId('estimate-confirm-run').waitFor()
  await capture('website-reviewed-estimate')
  assert.equal(db.prepare('SELECT count(*) FROM scan_jobs').pluck().get(),0)
  const queued=page.waitForResponse(r=>r.url()===base+'/api/scan'&&r.request().method()==='POST')
  await page.getByTestId('estimate-confirm-run').click()
  const run=await queued
  assert.equal(run.status(),202)
  const {job_id}=await run.json()
  assert.match(job_id,/^[a-f0-9]{24}$/)
  const proofResponse=await ctx.request.get(base+'/api/scan/status?readonly=1&job_id='+job_id)
  assert.equal(proofResponse.status(),200)
  const proof=await proofResponse.json()
  assert.equal(proof.website_profile_review,'confirmed')
  assert.deepEqual(proof.icp.who,['operations managers','dispatch leaders'])
  assert.ok(proof.icp.research.hyps.some(h=>h.t==='sales managers'&&h.s==='rejected'))
  assert.equal(db.prepare('SELECT offer FROM scan_jobs WHERE id=?').pluck().get(job_id),offer)
  assert.equal(db.prepare('SELECT count(*) FROM scan_spend_calls').pluck().get(),0,'worker never dispatches a scan')
  assert.deepEqual(db.prepare('SELECT sells,buyer_profile FROM users WHERE id=?').get(actor),initial)
  // Separate authentic new account: retain the independent first-run half of
  // the old offer-question check, with the real build/read/autosave behavior.
  const fresh=await browser.newContext({serviceWorkers:'block'})
  await fresh.route(u=>u.origin!==base,r=>r.abort())
  await fresh.addCookies([{name:'dazl_session',value:freshSession,url:base}])
  const first=await fresh.newPage()
  await first.goto(base+'/app')
  await first.getByTestId('site-step').waitFor()
  await first.getByLabel('Your website').fill(site+'multiple')
  await first.getByRole('button',{name:'Read my site'}).click()
  await first.getByTestId('ready-step').waitFor({timeout:20000})
  await first.getByRole('button',{name:'Edit what dazl inferred'}).click()
  await first.getByTestId('research-question').getByRole('button',{name:'Fixture Analytics',exact:true}).click()
  assert.equal(await first.getByLabel('What you sell').inputValue(),'Fixture Analytics')
  assert.equal(db.prepare('SELECT count(*) FROM scan_jobs WHERE user_id=?').pluck().get(freshActor),0)
  assert.deepEqual(websiteGets,['/multiple','/single','/multiple'])
  assert.equal(readFileSync(join(root,'provider-transport.log'),'utf8'),'multiple\nsingle\nmultiple\n')
  console.log('Signed website → two-offer and typed reviews → real estimate → confirmed queue receipt. No provider egress or worker dispatch.')
} catch(error){console.error(logs);throw error}
finally{
  await browser?.close()
  if(app?.exitCode===null){const wait=new Promise(r=>app.once('exit',r));app.kill('SIGTERM');await Promise.race([wait,sleep(4000)]);if(app.exitCode===null)app.kill('SIGKILL')}
  await new Promise(r=>web.close(r))
  db.close();rmSync(root,{force:true,recursive:true})
}
