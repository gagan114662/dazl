// Run after building Next: node --experimental-strip-types test/smoke/signed-shell-timing.smoke.mjs
// Test actual signed streaming, not just unsigned /api/health or a static shell.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createQueryJob } from '../../lib/scan/store.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { pickUiPort } from '../helpers/ui-port.mjs'

const web = fileURLToPath(new URL('../..', import.meta.url))
assert.ok(existsSync(path.join(web, '.next/BUILD_ID')), 'Build the production app before running the signed shell smoke')
const require = createRequire(path.join(web, 'package.json'))
const browserProof = process.argv.includes('--browser')
const workingProof = process.argv.includes('--working-worker')
const job='bf'.repeat(12)
const dir = mkdtempSync(path.join(tmpdir(), 'dazl-app-shell-timing-'))
const dbPath = path.join(dir, 'app.db')
const token = randomBytes(32).toString('hex')
const statusText = 'Opening your workspace…'
const routes = [
  ['/app', '<h1 class="text-3xl font-bold tracking-tight">Welcome to dazl</h1>'],
  ['/app/business', '>Loading what dazl knows about your business...</p>'],
  ['/app/plays', '>Loading your plays...</p>'],
]

async function verify(base, route, pageMarker, mode) {
  const start = performance.now()
  const elapsed = () => Math.round(performance.now() - start)
  const signed = mode !== 'invalid-cookie'
  const r = await fetch(base + route, {
    headers: { 'sec-fetch-dest': 'document', cookie: 'dazl_session=' + (signed ? token : 'a'.repeat(64)) },
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  })
  const headersMs = elapsed()
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let html = '', firstMs = null, contentMs = null
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    firstMs ??= elapsed()
    html += decoder.decode(chunk.value, { stream: true })
    if (html.includes(pageMarker)) contentMs ??= elapsed()
  }
  const status = /<div[^>]*\brole="status"[^>]*>\s*<p[^>]*>Opening your workspace…<\/p>/.exec(html)
  console.log(JSON.stringify({ route, mode, status: r.status, headersMs, firstMs, contentMs, totalMs: elapsed(), shellStatus: !!status }))
  if (signed) {
    assert.equal(r.status, 200)
    const id=r.headers.get('x-request-id')
    const metric=/dazl_request;desc="([^"]+)"/.exec(r.headers.get('server-timing')??'')?.[1]
    assert.ok(id&&metric?.startsWith(id+'.'))
    assert.ok(html.includes('data-signed-shell-auth-marker='))
    assert.ok(status, route + ': initial shell must have an accessible loading status')
    assert.notEqual(contentMs, null, route + ': signed page body must finish streaming')
    assert.ok(html.indexOf(statusText) < html.indexOf(pageMarker), route + ': loading status must precede page content')
    // The browser transport remains independent; here the real same-origin
    // endpoint validates server-issued correlation and session without a browser.
    if (mode === 'warm-signed') {
      const body = {kind:'signed_shell_timing',route,request_id:id,receipt:metric,
        ttfb_ms:null,auth_marker_ms:null,js_failed:0,css_failed:0,observation:'load'}
      const send = (value,session) => fetch(base+'/api/client-errors',{method:'POST',headers:{
        cookie:'dazl_session='+session,origin:base,'content-type':'application/json',
      },body:JSON.stringify(value)})
      assert.equal((await send({...body,asset_url:'/not-accepted?private=1'},token)).status,400)
      assert.equal((await send(body,'a'.repeat(64))).status,401)
      assert.equal((await send(body,token)).status,204)
    }
    return id
  } else {
    assert.equal(r.headers.get('server-timing'),null)
    assert.equal(r.status, 307)
    const location = r.headers.get('location')
    assert.ok(location, route + ': invalid session must redirect to sign-in')
    assert.equal(new URL(location, base + route).href, base + '/sign-in')
    assert.equal(contentMs, null)
    assert.equal(status, null)
  }
}

const common={
  PATH:process.env.PATH,DB_PATH:dbPath,DAZL_SIGNED_SHELL_TIMING:'1',
  SITECRAWL_ENABLED:'0',NEWS_SEARCH_ENABLED:'0',NEXT_TELEMETRY_DISABLED:'1',
  NODE_OPTIONS:'--experimental-strip-types --import '+path.join(web,'test/helpers/signed-shell-timing-preload.mjs'),
}
const delay=ms=>new Promise(r=>setTimeout(r,ms))
const parseLog=text=>text.split('\n').flatMap(l=>{
  try{const v=JSON.parse(l);return v.type==='signed_shell_timing'?[v]:[]}catch{return []}
})
async function stop(child) {
  if(child.exitCode!==null||child.signalCode!==null)return
  const done=new Promise(resolve=>child.once('exit',resolve))
  child.kill('SIGTERM')
  await Promise.race([done,delay(3000)])
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done}
}
async function checkBrowser(base,route,readLog){
  const {chromium}=require('playwright')
  const browser=await chromium.launch()
  try {
    const ctx=await browser.newContext({serviceWorkers:'block'})
    await ctx.addCookies([{name:'dazl_session',value:token,url:base}])
    let css=0
    await ctx.route('**/*',route=>{
      const u=new URL(route.request().url())
      if(u.origin!==base)return route.abort()
      // Induce only a resource failure; app HTML/RSC and API are unmodified.
      if(u.pathname.startsWith('/_next/static/')&&u.pathname.endsWith('.css')&&css===0){css++;return route.abort()}
      return route.continue()
    })
    const page=await ctx.newPage()
    const report=page.waitForResponse(r=>r.url()===base+'/api/client-errors'&&r.request().postDataJSON()?.kind==='signed_shell_timing')
    const document=await page.goto(base+route)
    assert.equal(document?.status(),200)
    const id=document.headers()['x-request-id']
    const posted=await report
    assert.equal(posted.status(),204)
    const content=posted.request().postDataJSON()
    assert.equal(content.request_id,id)
    assert.equal(content.route,route)
    assert.equal(typeof content.ttfb_ms,'number')
    assert.equal(typeof content.auth_marker_ms,'number')
    assert.equal(content.css_failed,1)
    assert.equal(content.js_failed,0)
    const receipt=parseLog(readLog()).find(x=>x.request_id===id&&x.phase==='browser_document')
    assert.ok(receipt)
    assert.equal(receipt.css_failed,1)
    assert.equal('receipt' in receipt,false)
  }finally{await browser.close()}
}
async function testRoute(route, pageMarker) {
  const port = pickUiPort()
  const base = 'http://127.0.0.1:' + port
  const srv = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: web,
    env: {...common,SCAN_MAX_CONCURRENT:'0'}, stdio:['ignore','pipe','pipe'],
  })
  let logs=''
  for(const stream of [srv.stdout,srv.stderr])stream.on('data',c=>{logs=(logs+c).slice(-64_000)})
  try {
    let ready = false
    for (let i = 0; i < 80 && !ready && srv.exitCode === null; i++) {
      try {
        const response = await fetch(base + '/sign-in', { signal: AbortSignal.timeout(1000) })
        await response.arrayBuffer()
        ready = response.ok
      } catch (err) {
        if (!(err instanceof TypeError) && err?.name !== 'TimeoutError') throw err
        await new Promise(r => setTimeout(r, 100))
      }
    }
    assert.ok(ready, 'Next server did not start')
    for (const mode of ['cold-signed', 'warm-signed', 'invalid-cookie']) {
      const id=await verify(base, route, pageMarker, mode)
      if(!id)continue
      const all=parseLog(logs).filter(l=>l.request_id===id)
      assert.equal(all.filter(l=>l.phase==='browser_document').length,mode==='warm-signed'?1:0)
      const scoped=all.filter(l=>l.phase!=='browser_document')
      assert.deepEqual(new Set(scoped.map(l=>l.phase)),new Set(['proxy_auth','layout_auth']))
      for(const l of scoped) {
        assert.equal(l.route,route)
        assert.equal(l.result,'allowed')
        assert.equal(l.sqlite,null)
        assert.equal(typeof l.duration_ms,'number')
        assert.equal(typeof l.ttfb_ms,'undefined')
      }
    }
    if(browserProof&&route==='/app/business')await checkBrowser(base,route,()=>logs)
  } finally {
    await stop(srv)
  }
}

try {
  const db = new Database(dbPath)
  try {
    migrateAllSqlite(db)
    const hashed = createHash('sha256').update(token).digest('hex')
    db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('fixture','example@local.test','x','y',1)").run()
    db.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,'fixture',?)").run(hashed, Math.floor(Date.now() / 1000) + 3600)
    if (workingProof) {
      saveKey(db,'fixture','anthropic','sk-ant-LOCAL-SHELL-TIMING-FIXTURE',Buffer.alloc(32,100))
      createQueryJob(db,'fixture',{id:job,query:'Find laboratory operators with published buying signals',offer:'Fixture offer'})
    }
  } finally {
    db.close()
  }
  const worker=spawn(process.execPath,['--experimental-strip-types','scripts/scan-worker.mts'],{
    cwd:web,env:{...common,DAZL_SCAN_SHARED_QUEUE:'1',SCAN_WORKER_INTERVAL_MS:'250',
      ...(workingProof?{DAZL_SHELL_FIXTURE_PROVIDER:'1',DAZL_ANTHROPIC_MODEL:'claude-sonnet-4-5'}:{})},stdio:['ignore','pipe','pipe'],
  })
  let workerReady=false
  worker.stdout.on('data',c=>{if(String(c).includes('shared_queue=on'))workerReady=true})
  try{
    for(let i=0;i<40&&!workerReady&&worker.exitCode===null;i++)await delay(100)
    assert.ok(workerReady,'real shared worker did not start')
    const proof=new Database(dbPath,{readonly:true})
    try {
      if(workingProof) {
        for(let i=0;i<150&&!existsSync(path.join(dir,'fixture-provider-entered'))&&worker.exitCode===null;i++)await delay(100)
        assert.ok(existsSync(path.join(dir,'fixture-provider-entered')),'real worker never reached its fenced external boundary')
      }
      for(const [route, marker] of routes){
        if(workingProof)assert.equal(proof.prepare('SELECT status FROM scan_jobs WHERE id=?').pluck().get(job),'running')
        await testRoute(route,marker)
      }
      assert.equal(proof.prepare('SELECT count(*) FROM scan_jobs').pluck().get(),workingProof?1:0)
      if(workingProof) {
        assert.equal(proof.prepare('SELECT status FROM scan_jobs WHERE id=?').pluck().get(job),'running')
        console.log('Real shared worker held in exactly one synthetic Anthropic response; signed document checks ran during the claim.')
      } else assert.equal(proof.prepare('SELECT count(*) FROM scan_spend_calls').pluck().get(),0)
    }finally{proof.close()}
  }finally {
    if(workingProof)writeFileSync(path.join(dir,'release-fixture-provider'),'release')
    await stop(worker)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
