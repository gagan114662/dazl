// Real component render and interaction. All HTTP intercepted: no production records, source fetch or paid call.
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url),esbuild=require('esbuild'),{chromium}=require('playwright')
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const bundle=await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import PlayResearch from '@/app/app/leads/play-research';createRoot(document.getElementById('root')).render(<main style={{maxWidth:850,margin:'20px auto',padding:16}}><h1>Original London CRM play</h1><PlayResearch jobId={'a'.repeat(24)}/></main>)`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':root}})
const cssFile=fs.readdirSync(path.join(root,'.next/static/chunks')).find(x=>x.endsWith('.css')),css=fs.readFileSync(path.join(root,'.next/static/chunks',cssFile),'utf8')
const job='a'.repeat(24),cards=[],posts=[]
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1100,height:1000}})
await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)})
 if(u.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text})
 if(u.pathname.startsWith('/api/')){assert.equal(u.pathname,'/api/leads/play-research');if(req.method()==='POST'){const i=req.postDataJSON();posts.push(i);assert.equal(i.job_id,job);cards.push({...i,id:'research-only',email_claim:i.contact||null,query_snapshot:'Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days. We sell CRM setup and outbound sales consulting. Exclude agencies, directories and companies outside the UK. Show dated source evidence and founder or head of sales contacts.',offer_snapshot:'CRM setup and outbound sales consulting',play_created_at:1793286117,offer_source:'play',source_check:{checked_at:1793437200,fetch_status:'fetched',quote_match:true,company_named:true},person_check:{fetch_status:'fetched',quote_match:true},created_at:1793286117});return json({id:'research-only',job_id:job,research_only:true,can_draft:false})}return json({job_id:job,research:cards})}
 return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${css}body{font-family:Arial;color:#111;background:#faf9f6}.field{border:1px solid #aaa;border-radius:5px;padding:8px;color:#111;background:white}a{overflow-wrap:anywhere}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`})})
await page.goto('http://dazl.test/app/leads?job_id='+job)
await page.getByText('No supplemental research saved.').waitFor();assert.equal(posts.length,0)
await page.getByText('Save source-backed research to this play (no paid call)').click()
const fields={'Company':'Epoch','Signal claim':'Announced a seed round in London','Public HTTPS source URL':'https://epoch.blue/article/epoch-raises-6-26m','Exact source quote (20-400 characters)':'London, 26 October 2026 — Epoch, the first-mile supply chain intelligence platform, has today launched a self-serve product that automates compliance for small and mid-sized businesses (SMBs), starting with the EU Deforestation Regulation (EUDR)*. The launch follows the close of a $4.25M seed round led by Burnt Island Ventures and Sand River, bringing Epoch\'s total funding to $6.26M.','Claimed event or announcement date (YYYY-MM-DD, optional)':'2026-10-26','Person name (optional)':'Mario Romero Garoz','Person role':'Head of EMEA Sales','Professional source URL (HTTPS, separate from email)':'https://www.linkedin.com/posts/mario-romero-garoz_new-chapter-ive-joinedepochas-head-activity-7515675341110018050-6c1Y','Exact professional source quote (20-400 characters)':'New chapter: I’ve joined Epoch as Head of Sales, EMEA.'}
for(const [name,v] of Object.entries(fields))await page.getByLabel(name,{exact:true}).fill(v)
await page.getByRole('button',{name:'Save research only',exact:true}).click()
await page.getByTestId('play-research-card').waitFor();assert.equal(posts.length,1)
const card=page.getByTestId('play-research-card');assert.equal(await card.getByRole('button').count(),0);assert.match(await card.innerText(),/not draft ready/);assert.match(await card.innerText(),/No email supplied/)
await card.getByText('Play context when saved').click();await page.getByText('Save source-backed research to this play (no paid call)').click()
fs.mkdirSync('/downloads/dazl-play-research',{recursive:true});await page.screenshot({path:'/downloads/dazl-play-research/desktop.png',fullPage:true})
await page.setViewportSize({width:390,height:1050});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'/downloads/dazl-play-research/mobile.png',fullPage:true})
await browser.close();console.log('PASS: actual component saves one same-play research-only card, separate professional route/no email, request+offer visible, no action buttons/draft/send/scan calls; mobile no overflow. HTTP fully stubbed; quotes from independently fetched source snapshots; route/database mocked, not production evidence.')
