import{startServer,loadPlaywright,newContext}from'./harness.mjs'
import{createRequire}from'node:module'
import assert from'node:assert/strict'
import{mkdirSync,mkdtempSync,rmSync}from'node:fs'
import{tmpdir}from'node:os'
import path from'node:path'
const shotDir=process.env.RECHECK_SHOT_DIR||mkdtempSync(path.join(tmpdir(),'evidence-recheck-shots-'));mkdirSync(shotDir,{recursive:true})
import{migrateAllSqlite}from'../../lib/db/sqlite-migrations.ts'
const require=createRequire(new URL('../../package.json',import.meta.url)),Database=require('better-sqlite3'),playwright=loadPlaywright(),L='30186dd7f9e343cc618cff1e',J='c53bb81d0b6d00d2a2f31144'
const s=await startServer({env:{NODE_OPTIONS:'--experimental-strip-types --import '+new URL('../helpers/net-fence.ts',import.meta.url).pathname+' --import '+new URL('./stripe-test-env.mjs',import.meta.url).pathname,SMOKE_MASTER_B64:Buffer.alloc(32,7).toString('base64'),SMOKE_STRIPE_SK:'sk_test_smoke123456',SMOKE_STRIPE_WHSEC:'whsec_smokefixture',STRIPE_PRICE_PRO:'price_smoke'},prepare(file){const d=new Database(file);migrateAllSqlite(d);d.prepare("UPDATE users SET sells=? WHERE id='smoke-user'").run('We sell dental appointment booking software.');d.prepare("INSERT INTO scan_jobs(id,user_id,status,business_name,industry,location,query,seller,offer,icp)VALUES(?,'smoke-user','running','fixture','SaaS','London',?,?,?,?)").run(J,'Find London startups funded in the last 90 days. We sell CRM setup and outbound sales consulting.','Dental software','CRM setup and outbound sales consulting',JSON.stringify({summary:'London SaaS',who:[],industries:['SaaS'],sizes:[],where:['London','UK'],signals:['seed funding'],exclude:[],window_days:90}));d.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,review_reason,evidence_excerpt,event_date)VALUES(?,?,?,?,?,?,?,?)').run(L,J,'Revnu','Raised seed funding','https://revnu.example/news','counterparty_signal','Revnu raised seed funding.','2026-10-01');d.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(J);d.close()}})
let browser
try{
 const get=async(p,auth=true)=>{const r=await fetch(s.base+p,{headers:auth?{Cookie:'dazl_session='+s.token}:{}});return {status:r.status,body:await r.json()}}
 assert.equal((await get('/api/leads/evidence-recheck?lead_id='+L,false)).status,401)
 assert.equal((await get('/api/leads/evidence-recheck?lead_id=bad')).status,400)
 assert.equal((await get('/api/leads/evidence-recheck?lead_id='+'f'.repeat(24))).status,404)
 const real=await get('/api/leads/evidence-recheck?lead_id='+L);assert.equal(real.status,200);assert.equal(real.body.status,'unreadable');assert.equal(real.body.offer,'CRM setup and outbound sales consulting');assert.equal(real.body.eligibility_changed,false)
 browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox']})
 for(const width of[1280,390]){
 const ctx=await newContext(browser,s),p=await ctx.newPage();await p.setViewportSize({width,height:950});await p.goto(s.base+'/app/leads?job_id='+J);await p.getByRole('button',{name:'Recheck saved source (free, no AI call)',exact:true}).waitFor();await p.getByRole('button',{name:'Recheck saved source (free, no AI call)',exact:true}).click();await p.getByText('The saved source could not be read (error). Its evidence is unknown.',{exact:true}).waitFor();await p.screenshot({path:path.join(shotDir,'unreadable-'+width+'.png'),fullPage:true})
 await p.route('**/api/leads/evidence-recheck?*',r=>r.fulfill({json:{...real.body,status:'checked',reasons:['This company is tied to a different place than the saved play targeting.','This only rechecks the saved source. It does not verify identity, contact, fit, buying need or consent, find new leads, or make this lead ready to draft. The saved review hold is unchanged.']}}));await p.getByRole('button',{name:'Recheck saved source (free, no AI call)',exact:true}).click();await p.getByText('This company is tied to a different place than the saved play targeting.',{exact:true}).waitFor();await p.screenshot({path:path.join(shotDir,'checked-'+width+'.png'),fullPage:true});await p.reload();assert.equal(await p.getByText('This company is tied to a different place than the saved play targeting.',{exact:true}).count(),0);await ctx.close()
 }
 const d=new Database(s.dbPath);assert.equal(d.prepare('SELECT review_reason FROM leads WHERE id=?').get(L).review_reason,'counterparty_signal');assert.equal(d.prepare('SELECT count(*) n FROM outreach_messages').get().n,0);d.close();console.log(JSON.stringify({routeReal:real.body,uiWidths:[1280,390],positiveUi:'mocked diagnostic result; deterministic helper exercised separately',storageUnchanged:true}))
}finally{if(browser)await browser.close();s.stop();if(!process.env.RECHECK_SHOT_DIR)rmSync(shotDir,{recursive:true,force:true})}
