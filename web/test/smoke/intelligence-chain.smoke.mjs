// Exact production client -> actual route admission+ledger -> unrelated play -> actual website handler recall.
// Browser forwards the two API endpoints to the fixture RPC process, not hand-built success JSON. No runner flush,
// outbound transport or paid call. The test DB and authenticated actor are fixtures, never a live account.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import readline from 'node:readline'
import {mkdirSync} from 'node:fs'
import path from 'node:path'
import {loadPlaywright,newContext,startServer,root} from './harness.mjs'
const {chromium}=loadPlaywright();const out=path.join(root,'preview','intelligence-chain');mkdirSync(out,{recursive:true})
const child=spawn(process.execPath,['--experimental-strip-types','--no-warnings','--import','./test/helpers/net-fence.ts','--loader','./test/helpers/intelligence-chain-loader.mjs','./test/helpers/intelligence-chain-runtime.mts'],{cwd:root,env:{...process.env},stdio:['pipe','pipe','pipe']})
let seq=0,stderr='';const pending=new Map();child.stderr.on('data',d=>stderr+=d)
readline.createInterface({input:child.stdout}).on('line',l=>{try{const j=JSON.parse(l);const p=pending.get(j.id);if(!p)throw Error(l);pending.delete(j.id);p.resolve(j.result)}catch{for(const p of pending.values())p.reject(Error(l+stderr))}})
const rpc=(op,body)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,op,body})+'\n')})
child.on('exit',code=>{for(const p of pending.values())p.reject(Error(`RPC exit${code} ${stderr}`))})
const srv=await startServer();let browser
try{
 browser=await chromium.launch();const ctx=await newContext(browser,srv);const page=await ctx.newPage();await page.setViewportSize({width:1280,height:1000})
 for(const [endpoint,op] of [['icp-from-url','website'],['estimate','estimate'],['','admit']])await page.route(`**/api/scan${endpoint?'/'+endpoint:''}`,async r=>{const result=await rpc(op,r.request().postDataJSON());await r.fulfill({status:result.status,json:result.body})})
 await page.route('**/api/scan/status?*',r=>r.fulfill({json:{status:'done',lead_count:0,icp:null}}))
 async function read(){await page.goto(srv.base+'/app/leads');await page.getByTestId('play-settings').locator('summary').first().click();await page.getByTestId('more-sources').locator('summary').first().click();await page.getByPlaceholder('Your website - we will fill the profile from it').fill('https://seller.example');await page.getByRole('button',{name:'Fill from my website',exact:true}).click();await page.getByTestId('research-review').waitFor()}
 async function submit(query){await page.getByLabel('Who do you want to reach?',{exact:true}).fill(query);await page.getByRole('button',{name:'Run scan with this profile',exact:true}).first().click();await page.getByTestId('estimate-confirm-run').click();await page.waitForURL(/job_id=/);await rpc('finish')}
 await read();let review=page.getByTestId('research-review');await review.getByRole('button',{name:'Add',exact:true}).click();await review.getByRole('button',{name:'Dismiss',exact:true}).click();await review.getByText('Dismissed targeting (restore explicitly)').click();await review.getByRole('button',{name:'Restore',exact:true}).click();await submit('Find clinic managers')
 let state=await rpc('inspect');assert.equal(state.decisions.length,1);assert.equal(state.decisions[0].action,'confirm');assert.equal(state.decisions[0].actor_id,'chain-actor')
 const unrelated=await rpc('admit',{query:'Find software developers',offer:'A different service'});assert.equal(unrelated.status,202);await rpc('finish')
 await read();assert.ok((await page.locator('textarea').evaluateAll(xs=>xs.map(x=>x.value))).includes('Clinic managers'));await page.getByTestId('research-review').screenshot({path:path.join(out,'confirmed-recalled-after-unrelated.png')})
 review=page.getByTestId('research-review');await review.getByRole('button',{name:'Dismiss',exact:true}).click();await submit('Find clinics without the dismissed persona')
 state=await rpc('inspect');assert.equal(state.decisions.length,2);assert.equal(state.decisions[1].action,'reject')
 await read();assert.ok(!(await page.locator('textarea').evaluateAll(xs=>xs.map(x=>x.value))).includes('Clinic managers'));await page.getByText('Dismissed targeting (restore explicitly)').click();await page.getByTestId('research-review').screenshot({path:path.join(out,'rejected-recalled.png')})
 console.log('PASS production UI -> real admission ledger -> unrelated play -> actual website recall -> editable targeting; confirmation and rejection. No paid transport/runner.')
 await ctx.close()
}finally{await browser?.close();srv.stop();child.stdin.end();if(child.exitCode===null)await new Promise(r=>child.once('exit',r))}
