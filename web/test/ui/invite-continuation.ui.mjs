// Real production sign-in continuation, own synthetic user/link, network fenced.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {scryptSync} from 'node:crypto'
import {loadPlaywright,startServer,root} from '../smoke/harness.mjs'
const Database=createRequire(root+'/package.json')('better-sqlite3')
const {chromium}=loadPlaywright(),srv=await startServer(),browser=await chromium.launch()
try{
 const ctx=await browser.newContext();await ctx.route('**/*',r=>new URL(r.request().url()).origin===srv.base?r.continue():r.abort());const page=await ctx.newPage()
 await page.goto(srv.base+'/sign-up');assert.equal(await page.evaluate(async()=> (await fetch('/api/auth/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'continuation@example.test',password:'fixture password42'})})).status),503)
 // #357: sign-up needs mail delivery (none on this fenced server); the confirmed fixture account is written directly
 const db=new Database(srv.dbPath),salt='ab'.repeat(16);db.prepare('INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES (?,?,?,?,1)').run('continuation','continuation@example.test',scryptSync('fixture password42',salt,64).toString('hex'),salt);db.close()
 await ctx.clearCookies();const token='a'.repeat(64)
 await page.goto(srv.base+'/app/join#t='+token);await page.waitForURL('**/sign-in*');await page.getByRole('button',{name:'Sign in',exact:true}).waitFor()
 await page.getByPlaceholder('you@company.com').fill('continuation@example.test');await page.getByPlaceholder('Password', {exact:true}).fill('fixture password42');await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.waitForURL('**/app/join*');await page.getByText('This invitation link has expired, was already used, or was withdrawn.').waitFor();assert.equal(new URL(page.url()).hash,'')
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('dazl_invite')),null)
 console.log('ok signed-out invitation survives actual password sign-in, returns to join, clears fragment/storage, dead link honestly refused')
}catch(e){console.error(e);process.exitCode=1}finally{await browser.close();srv.stop()}
