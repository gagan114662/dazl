// Actual LeadsClient integration with app styles. Every HTTP call mocked; no production state.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]} (set NODE_PATH to a folder with esbuild and playwright)`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import LeadsClient from '@/app/app/leads/leads-client'; createRoot(document.getElementById('root')).render(<LeadsClient />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': root },
  // node:crypto is only used by the draft-review binding hash, which this check never exercises: a browser shim keeps the bundle self-contained.
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const randomBytes = () => ({toString:()=>"test"}); export const createHash = () => ({ update() { return this }, digest() { return "shim" } })', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"' }, external: [],
})
const js = bundle.outputFiles[0].text


const proof=JSON.parse(fs.readFileSync(process.env.RESEARCH_PROOF,'utf8')),JOB=proof.job_id
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1100,height:1100}})
const cssFile=fs.readdirSync(path.join(root,'.next/static/chunks')).find(x=>x.endsWith('.css')),css=fs.readFileSync(path.join(root,'.next/static/chunks',cssFile),'utf8')
const calls=[],json=(route,body)=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)})
await page.route('**/*',async route=>{const u=new URL(route.request().url()),m=route.request().method()
if(u.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:js})
if(route.request().resourceType()==='document')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${css}body{font-family:Arial;color:#111;background:#faf9f6}a{overflow-wrap:anywhere}</style></head><body><div class="app-ui" id="root"></div><script src="/bundle.js"></script></body></html>`})
calls.push(m+' '+u.pathname);if(m==='POST'){assert.equal(u.pathname,'/api/leads/play-research');return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'The play context changed. Reload before saving research.'})})}assert.equal(m,'GET')
if(u.pathname==='/api/leads/play-research')return json(route,{job_id:JOB,research:[proof.card]})
if(u.pathname==='/api/scan/status')return json(route,{status:'done',lead_count:0,icp:{summary:'Original London CRM',where:['London'],signals:['Seed round'],who:['Founder'],industries:['B2B SaaS'],sizes:[],exclude:[],window_days:90},attempts:1,max_attempts:3})
if(u.pathname==='/api/leads')return json(route,{job_id:JOB,status:'done',hidden_count:0,leads:[]})
if(u.pathname==='/api/scan/jobs')return json(route,{jobs:[]})
return json(route,{watches:[],monitors:[],jobs:[],sources:[],connections:[],feeds:[],providers:[],batches:[],rows:[]})})
page.on('pageerror',e=>{throw e});await page.goto('http://dazl.test/app/leads?job_id='+JOB)
const card=page.getByTestId('play-research-card');await card.waitFor({timeout:10000})
assert.equal(await page.getByTestId('play-research').evaluate(e=>!!e.closest('details[data-testid="play-settings"]')),false,'research is visible outside closed settings')
assert.match(await card.innerText(),/not draft ready/);assert.equal(await card.getByRole('button').count(),0)
await card.getByText('Play context when saved').click()
await page.screenshot({path:'/downloads/dazl-play-research/full-leads-desktop.png',fullPage:true})
await page.setViewportSize({width:390,height:1100});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
await page.screenshot({path:'/downloads/dazl-play-research/full-leads-mobile.png',fullPage:true})
assert.equal(calls.filter(x=>!x.startsWith('GET')).length,0)
await page.getByText('Save source-backed research to this play (no paid call)').click()
await page.getByTestId('play-research').getByLabel('Company',{exact:true}).fill('Epoch');await page.getByTestId('play-research').getByLabel('Signal claim',{exact:true}).fill('Own seed announcement');await page.getByTestId('play-research').getByLabel('Public HTTPS source URL',{exact:true}).fill(proof.card.source_url);await page.getByTestId('play-research').getByLabel('Exact source quote (20-400 characters)',{exact:true}).fill(proof.card.excerpt)
await page.screenshot({path:'/downloads/dazl-play-research/full-form-mobile.png',fullPage:true})
await page.getByRole('button',{name:'Save research only',exact:true}).click();await page.getByRole('alert').filter({hasText:'The play context changed.'}).waitFor();assert.equal(calls.filter(x=>x.startsWith('POST')).length,1)
await page.screenshot({path:'/downloads/dazl-play-research/full-error-mobile.png',fullPage:true})
await page.setViewportSize({width:1100,height:1100});await page.screenshot({path:'/downloads/dazl-play-research/full-error-desktop.png',fullPage:true})
await browser.close();console.log('PASS: full LeadsClient real component outside closed settings, exact original-control scratch research card, one scoped research-only POST refused with visible context error; no scan/lead/draft/send mutation; mobile zero overflow; all HTTP mocked.')
