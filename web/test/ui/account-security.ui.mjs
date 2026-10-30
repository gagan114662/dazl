// Production UI + real endpoints, isolated synthetic account/database, outbound-network fenced.
// No SMTP configured: delivery paths must report unavailable, never claim email was sent.
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {randomBytes,createHash} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import path from 'node:path'
import {loadPlaywright,startServer} from '../smoke/harness.mjs'
const {chromium}=loadPlaywright(),srv=await startServer(),browser=await chromium.launch()
const dir=path.resolve(process.env.SHOTS||'/tmp/account-security-shots');mkdirSync(dir,{recursive:true})
const ctx=await browser.newContext();await ctx.route('**/*',r=>new URL(r.request().url()).origin===srv.base?r.continue():r.abort())
const page=await ctx.newPage(),db=new Database(srv.dbPath)
const call=async (url,body)=>page.evaluate(async({url,body})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}},{url,body})
async function shot(name){for(const [label,width]of[['desktop',1280],['mobile',390]]){await page.setViewportSize({width,height:844});await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));if(name==='session-inventory'){const card=page.locator('.card',{has:page.getByRole('heading',{name:'Signed-in devices'})});await card.scrollIntoViewIfNeeded();await card.screenshot({path:path.join(dir,`${name}-${label}.png`)})}else await page.screenshot({path:path.join(dir,`${name}-${label}.png`),fullPage:true})}}
try{
 await page.goto(srv.base+'/sign-up');assert.equal((await call('/api/auth/signup',{email:'account@example.test',password:'fixture password42',name:'Fixture'})).status,200)
 await page.goto(srv.base+'/app/settings');await page.getByText('account@example.test · not confirmed yet').waitFor()
 await page.getByRole('button',{name:'Send confirmation link'}).click();await page.getByText('Email delivery is not available. Try again later.').waitFor();await shot('account-mail-unavailable')
 const mail=db.prepare('SELECT body FROM system_mail_outbox WHERE to_email=?').get('account@example.test'),token=/\/verify#t=([a-f0-9]{64})/.exec(mail.body)[1]
 await page.goto(srv.base+'/verify#t='+token);await page.getByText('Your email is confirmed.').waitFor();assert.equal(new URL(page.url()).hash,'');await shot('email-confirmed')
 await page.goto(srv.base+'/reset');await page.getByPlaceholder('you@company.com').fill('account@example.test');await page.getByRole('button',{name:'Send link',exact:true}).click();await page.getByText('Email delivery is not available. Try again later.').waitFor();await shot('reset-mail-unavailable')
 await page.goto(srv.base+'/app/settings');const second=await browser.newContext();await second.route('**/*',r=>new URL(r.request().url()).origin===srv.base?r.continue():r.abort());const other=await second.newPage();await other.goto(srv.base+'/sign-in');assert.equal((await other.evaluate(async()=>{const r=await fetch('/api/auth/signin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'account@example.test',password:'fixture password42'})});return r.status})),200)
 await page.reload();await page.getByRole('button',{name:'Sign out everywhere else'}).waitFor();await shot('session-inventory');await page.getByRole('button',{name:'Sign out everywhere else'}).click();await page.getByText('Signed out everywhere else.').waitFor();assert.equal(await other.evaluate(async()=> (await fetch('/api/auth/sessions')).status),401)
 const u=db.prepare('SELECT id FROM users WHERE email=?').get('account@example.test'),reset=randomBytes(32).toString('hex'),now=Math.floor(Date.now()/1000)
 db.prepare('INSERT INTO email_tokens(id,user_id,purpose,email,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(randomBytes(12).toString('hex'),u.id,'reset','account@example.test',createHash('sha256').update(reset).digest('hex'),now,now+1800)
 await page.goto(srv.base+'/reset#t='+reset);await page.getByText('Choose a new password').waitFor();assert.equal(new URL(page.url()).hash,'');await shot('reset-password-form');await page.getByPlaceholder('New password (10+ characters, letters and numbers)').fill('replacement password43');await page.getByRole('button',{name:'Set password',exact:true}).click();await page.waitForURL('**/sign-in?reset=1');assert.equal((await page.evaluate(async()=> (await fetch('/api/auth/sessions')).status)),401)
 assert.equal((await call('/api/auth/reset',{token:reset,password:'replacement password43'})).status,410)
 assert.equal((await call('/api/auth/signin',{email:'account@example.test',password:'fixture password42'})).status,401)
 assert.equal((await call('/api/auth/signin',{email:'account@example.test',password:'replacement password43'})).status,200)
 await page.goto(srv.base+'/reset#t='+reset);await page.getByPlaceholder('New password (10+ characters, letters and numbers)').fill('another password44');await page.getByRole('button',{name:'Set password',exact:true}).click();await page.getByText('This link has expired or was already used. Ask for a new one.').waitFor();await shot('reset-replay-refused');await second.close()
 console.log('ok account-security production UI: verification+fragment removal, honest unavailable mail, session inventory+revocation, reset form+recovery+old-session/password invalidation+replay, desktop/mobile no overflow; '+dir)
}catch(e){console.error(e,srv.log().slice(-2000));process.exitCode=1}finally{db.close();await browser.close();srv.stop()}
