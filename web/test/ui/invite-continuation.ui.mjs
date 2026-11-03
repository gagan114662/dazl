// Real production sign-in continuation, own synthetic user/link, network fenced.
import assert from 'node:assert/strict'
import {loadPlaywright,startServer} from '../smoke/harness.mjs'
const {chromium}=loadPlaywright(),srv=await startServer(),browser=await chromium.launch()
try{
 const ctx=await browser.newContext();await ctx.route('**/*',r=>new URL(r.request().url()).origin===srv.base?r.continue():r.abort());const page=await ctx.newPage()
 await page.goto(srv.base+'/sign-up');assert.equal(await page.evaluate(async()=> (await fetch('/api/auth/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'continuation@example.test',password:'fixture password42'})})).status),200)
 await ctx.clearCookies();const token='a'.repeat(64)
 await page.goto(srv.base+'/app/join#t='+token);await page.waitForURL('**/sign-in*');await page.getByRole('button',{name:'Sign in',exact:true}).waitFor()
 await page.getByPlaceholder('you@company.com').fill('continuation@example.test');await page.getByPlaceholder('Password', {exact:true}).fill('fixture password42');await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.waitForURL('**/app/join*');await page.getByText('This invitation link has expired, was already used, or was withdrawn.').waitFor();assert.equal(new URL(page.url()).hash,'')
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('dazl_invite')),null)
 console.log('ok signed-out invitation survives actual password sign-in, returns to join, clears fragment/storage, dead link honestly refused')
}catch(e){console.error(e);process.exitCode=1}finally{await browser.close();srv.stop()}
