import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setDb, sqliteDb } from '../../lib/db/client.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { markCompanyFirstBudget } from '../../lib/company-first/product-discovery.ts'
import { recordTimingProof } from '../../lib/scan/timing-proof.ts'
import { migrateConnectors,addEnrichment } from '../../lib/connectors/store.ts'
import { GET as exportGET } from '../../app/api/leads/export/route.ts'

// The REAL CSV export route (it reads through store-db.ts, on SQLite too). A lead the required sales gate failed on whose review write was rejected still has review_reason NULL and
// a confidence in its stored row; the gate_failed marker beside it must make the export show it as held. In-memory DB, no network.
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const hex = () => randomBytes(12).toString('hex')
const get = (p: string) => new NextRequest(`http://localhost${p}`, { method: 'GET' })
function parseCsv(csv: string): Record<string, string>[] {
  const rows: string[][] = []; let cur: string[] = [], f = '', q = false
  for (let i = 0; i < csv.length; i++) { const c = csv[i]
    if (q) { if (c === '"' && csv[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c }
    else if (c === '"') q = true; else if (c === ',') { cur.push(f); f = '' } else if (c === '\n') { cur.push(f); rows.push(cur); cur = []; f = '' } else if (c !== '\r') f += c }
  if (f || cur.length) { cur.push(f); rows.push(cur) }
  const [h, ...rest] = rows; return rest.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])))
}
test('export route: a failed-gate lead exports as sales_hiring_check_failed with no confidence; a landed control still exports verified', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); setScanDb(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status='running', attempts=1 WHERE id=?").run(job)
  const ins = db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,confidence,review_reason,score) VALUES (?,?,?,?,?,?,?,?)')
  const ids = { held: hex(), ok: hex(), review: hex() }
  ins.run(ids.held, job, 'HeldCo', 's', 'https://news.example/h', 55, null, 60)
  ins.run(ids.ok, job, 'LandedCo', 's', 'https://news.example/o', 70, null, 70)
  ins.run(ids.review, job, 'ReviewCo', 's', 'https://news.example/r', null, 'quote_unconfirmed', 50)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'scan:gate', 'gate_failed', 'sales_hiring_check_failed', 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(hex(), ids.held)
  setUser({ id: 'A', business_name: 'Acme' })
  const res = await exportGET(get(`/api/leads/export?job_id=${job}`)); assert.equal(res.status, 200)
  const rows = parseCsv(await res.text()); const by = (c: string) => rows.find(r => r['Company'] === c)!
  assert.deepEqual([by('HeldCo')['Review Reason'], by('HeldCo')['Confidence']], ['sales_hiring_check_failed', ''], 'the failed-gate lead is held in the export, with no confidence')
  assert.deepEqual([by('LandedCo')['Review Reason'], by('LandedCo')['Confidence']], ['', '70'], 'a lead whose write landed (no marker) still exports verified')
  assert.deepEqual([by('ReviewCo')['Review Reason'], by('ReviewCo')['Confidence']], ['quote_unconfirmed', ''], 'an ordinary review lead is unchanged')
})


test('CSV scoped and workspace exports exclude held marked company-first; ready and ordinary still export',async()=>{
  const db=new Database(':memory:');migrateScan(db);migrateConnectors(db);setScanDb(db);setUser({id:'A',business_name:'Fixture'})
  try {
    const job=createJob(db,'A',{business_name:'Fixture',industry:'Services',location:'Anywhere'})
    const ordinary=createJob(db,'A',{business_name:'Fixture',industry:'Services',location:'Anywhere'})
    const foreign=createJob(db,'B',{business_name:'Fixture',industry:'Services',location:'Anywhere'})
    db.prepare("UPDATE scan_jobs SET status='running',attempts=1 WHERE id IN (?,?,?)").run(job,ordinary,foreign)
    db.prepare('UPDATE scan_jobs SET run_budget=? WHERE id=?').run(markCompanyFirstBudget(null),job)
    const t=Math.floor(Date.now()/1000),day=new Date((t-86400)*1000).toISOString().slice(0,10),source='https://fixture.example/evidence'
    const put=db.prepare(`INSERT INTO leads(id,scan_job_id,company,company_domain,signal,source_url,evidence_excerpt,
      confidence,event_date,event_date_proof,contact,fit) VALUES(?,?,?,'fixture.example','opening',?,'company opened',80,?,'page_bound',?,4)`)
    const held=hex(),ready=hex()
    put.run(held,job,'DoNotExportHeld',source,day,'held@fixture.example')
    put.run(ready,job,'CurrentMachineReady',source,day,'ready@fixture.example')
    put.run(hex(),ordinary,'OrdinaryLegacy',source,day,'ordinary@fixture.example')
    put.run(hex(),foreign,'OtherWorkspace',source,day,'other@fixture.example')
    for(const [connector,kind,value,label] of [
      ['sitecrawl','domain','fixture.example|evidence_own_domain','domain-basis-v1:evidence_own_domain'],
      ['sitecrawl','person','Dana Lee, Owner','owner'],['sitecrawl','email','ready@fixture.example','printed on site'],
      ['scan:actionable','actionability','Actionable: confirmed','Dana Lee, Owner'],
    ]) addEnrichment(db,'A',ready,{connector,kind,value,label,source_url:source,confidence:null,source_date:day,retrieved_at:t})
    assert.deepEqual(recordTimingProof(db,{id:job,user_id:'A'}),{proven:1,held:1})
    const scoped=await exportGET(get('/api/leads/export?job_id='+job));assert.equal(scoped.status,200)
    assert.deepEqual(parseCsv(await scoped.text()).map(r=>r.Company),['CurrentMachineReady'])
    const all=await exportGET(get('/api/leads/export'));assert.equal(all.status,200)
    const out=await all.text()
    assert.deepEqual(parseCsv(out).map(r=>r.Company).sort(),['CurrentMachineReady','OrdinaryLegacy'])
    assert.equal(out.includes('held@fixture.example'),false)
  } finally {db.close()}
})


function crowdedExport(heldCount:number){
  const db=new Database(':memory:');migrateScan(db);migrateConnectors(db);setScanDb(db);setUser({id:'A',business_name:'Fixture'})
  const job=createJob(db,'A',{business_name:'Fixture',industry:'Services',location:'Anywhere'})
  const other=createJob(db,'B',{business_name:'Fixture',industry:'Services',location:'Anywhere'})
  db.prepare("UPDATE scan_jobs SET status='running',attempts=1 WHERE id IN (?,?)").run(job,other)
  db.prepare('UPDATE scan_jobs SET run_budget=? WHERE id=?').run(markCompanyFirstBudget(null),job)
  const t=Math.floor(Date.now()/1000),day=new Date((t-86400)*1000).toISOString().slice(0,10),source='https://fixture.example/evidence'
  const insert=db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,created_at) VALUES(?,?,?,'event',?,?)")
  const held=Array.from({length:heldCount},hex),ready=hex(),older=hex(),foreign=hex()
  db.transaction(()=>{
    for(const id of held)insert.run(id,job,'Held Not Exported',source,t)
    // The first result ties the held rows' timestamp; insert_seq must decide
    // its stable place. The other is older by date.
    insert.run(ready,job,'Tied Proven Result',source,t)
    insert.run(older,job,'Older Proven Result',source,t-60)
    insert.run(foreign,other,'Foreign Result',source,t)
  })()
  for(const id of [ready,older]){
    db.prepare("UPDATE leads SET company_domain='fixture.example',confidence=80,event_date=?,event_date_proof='page_bound',evidence_excerpt='opened a site',fit=4 WHERE id=?").run(day,id)
    for(const [connector,kind,value,label] of [
      ['sitecrawl','domain','fixture.example|evidence_own_domain','domain-basis-v1:evidence_own_domain'],
      ['sitecrawl','person','Dana Lee, Owner','owner'],['sitecrawl','email','ready@fixture.example','printed on site'],
      ['scan:actionable','actionability','Actionable: confirmed','Dana Lee, Owner'],
    ])addEnrichment(db,'A',id,{connector,kind,value,label,source_url:source,confidence:null,source_date:day,retrieved_at:t})
  }
  assert.deepEqual(recordTimingProof(db,{id:job,user_id:'A'}),{proven:2,held:0})
  return {db,job,held,foreign,ready}
}

test('keyset CSV walks past over 5,000 held, then exports same-time and older proven rows in order',async()=>{
  const {db,job}=crowdedExport(5001)
  try{
    const res=await exportGET(get('/api/leads/export?job_id='+job))
    assert.equal(res.status,200)
    assert.deepEqual(parseCsv(await res.text()).map(r=>r.Company),['Tied Proven Result','Older Proven Result'])
    assert.equal(res.headers.get('x-dazl-export-truncated'),null)
  }finally{db.close()}
})

test('over work bound yields explicit owner-scoped cursor and resumes without gaps or duplicates',async()=>{
  const {db,job,held,foreign}=crowdedExport(10001)
  try{
    const path='/api/leads/export?job_id='+job
    const res=await exportGET(get(path))
    assert.equal(res.status,200)
    assert.deepEqual(parseCsv(await res.text()),[])
    assert.equal(res.headers.get('x-dazl-export-truncated'),'true')
    assert.equal(res.headers.get('x-dazl-export-candidate-limit'),'10000')
    assert.equal(res.headers.get('x-dazl-export-next-cursor'),held[9999])
    const link=res.headers.get('link')
    assert.equal(link,'<'+path+'&cursor='+held[9999]+'>; rel="next"')
    const next=await exportGET(get(path+'&cursor='+held[9999]))
    assert.equal(next.status,200)
    assert.deepEqual(parseCsv(await next.text()).map(r=>r.Company),['Tied Proven Result','Older Proven Result'])
    assert.equal(next.headers.get('x-dazl-export-next-cursor'),null)
    assert.equal((await exportGET(get(path+'&cursor='+foreign))).status,409)
  }finally{db.close()}
})

test('unsupported marked PostgreSQL proof returns 503, never a partial successful CSV',async()=>{
  const db=new Database(':memory:');migrateScan(db);migrateConnectors(db);setScanDb(db);setUser({id:'A',business_name:'Fixture'})
  try {
    const marked=createJob(db,'A',{business_name:'Fixture',industry:'Services',location:'Anywhere'})
    const ordinary=createJob(db,'A',{business_name:'Fixture',industry:'Services',location:'Anywhere'})
    db.prepare("UPDATE scan_jobs SET status='running',attempts=1 WHERE id IN (?,?)").run(marked,ordinary)
    db.prepare('UPDATE scan_jobs SET run_budget=? WHERE id=?').run(markCompanyFirstBudget(null),marked)
    const put=db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url) VALUES(?,?,?,'event','https://fixture.example')")
    put.run(hex(),ordinary,'Ordinary')
    // Exercise the real route's engine branch through the test Db only.
    setDb({...sqliteDb(db),kind:'pg'})
    const scoped=await exportGET(get('/api/leads/export?job_id='+marked))
    assert.equal(scoped.status,503,'an empty but explicitly marked job is not a successful report')
    assert.equal(scoped.headers.get('cache-control'),'no-store')
    assert.equal((await exportGET(get('/api/leads/export?job_id='+ordinary))).status,200)
    put.run(hex(),marked,'Do not partially export')
    const all=await exportGET(get('/api/leads/export'))
    assert.equal(all.status,503)
    assert.match((await all.json()).error,/No CSV was generated/)
  } finally {db.close()}
})

test('hitting CSV row limit inside final fetched batch resumes after last examined, excluding held rows',async()=>{
  const {db,foreign,ready}=crowdedExport(1)
  try {
    const ordinary=createJob(db,'A',{business_name:'Fixture',industry:'Services',location:'Anywhere'})
    db.prepare("UPDATE scan_jobs SET status='running',attempts=1 WHERE id=?").run(ordinary)
    const put=db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,created_at) VALUES(?,?,?,'event','https://fixture.example',?)")
    const created=Math.floor(Date.now()/1000)+60
    db.transaction(()=>{for(let i=0;i<4999;i++)put.run(hex(),ordinary,'Ordinary '+i,created)})()
    const path='/api/leads/export?include_fixtures=1'
    const first=await exportGET(get(path))
    assert.equal(first.status,200)
    const names=parseCsv(await first.text()).map(r=>r.Company)
    assert.equal(names.length,5000)
    assert.equal(names.at(-1),'Tied Proven Result')
    assert.ok(!names.includes('Held Not Exported'))
    assert.equal(first.headers.get('x-dazl-export-next-cursor'),ready)
    assert.equal(first.headers.get('x-dazl-export-truncated'),'true')
    assert.equal(first.headers.get('link'),'<'+path+'&cursor='+ready+'>; rel="next"')
    const next=await exportGET(get(path+'&cursor='+ready))
    assert.equal(next.status,200)
    assert.deepEqual(parseCsv(await next.text()).map(r=>r.Company),['Older Proven Result'])
    assert.equal(next.headers.get('x-dazl-export-next-cursor'),null)
    assert.equal((await exportGET(get(path+'&cursor='+foreign))).status,409)
    setUser({id:'B',business_name:'Fixture'})
    assert.equal((await exportGET(get(path+'&cursor='+ready))).status,409)
  } finally { db.close() }
})

// #1571 (Quest on staging 8132d324): the card showed a published address and a named person on a discovery lead, and the
// spreadsheet's Contact and Best Person columns were empty for every row. The export reads the same rows the card reads.
test('export route: a discovery lead exports the person and the published address its card shows; another workspace never sees them', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); setScanDb(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status='running', attempts=1 WHERE id=?").run(job)
  const ins = db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,confidence,score,fit,source_kind) VALUES (?,?,?,?,?,?,?,?,?)")
  const ids = { full: hex(), bare: hex(), old: hex() }
  ins.run(ids.full, job, 'FullCo', 's', 'https://fullco.example/news', 65, 65, 3, 'discover')
  ins.run(ids.bare, job, 'BareCo', 's', 'https://bareco.example/news', 65, 65, 3, 'discover')
  ins.run(ids.old, job, 'OldEngineCo', 's', 'https://old.example/news', 65, 65, 3, null)
  const add = (lead: string, kind: string, value: string, source_url: string, connector = 'discover') => addEnrichment(db, 'A', lead, { connector, kind, value, label: 'x', confidence: null, source_url, source_date: '2026-11-22', retrieved_at: 1 })
  add(ids.full, 'person', 'Dana Reyes, Head of Sales', 'https://fullco.example/team')
  add(ids.full, 'email', 'dana@fullco.example', 'https://fullco.example/contact')
  add(ids.full, 'linkedin', 'https://www.linkedin.com/in/dana-reyes', 'https://fullco.example/team')
  // rows of the discovery connector on a lead that is not a discovery lead are not this lead's card contact
  add(ids.old, 'email', 'someone@old.example', 'https://old.example/contact')
  setUser({ id: 'A', business_name: 'Acme' })
  const res = await exportGET(get(`/api/leads/export?job_id=${job}`)); assert.equal(res.status, 200)
  const rows = parseCsv(await res.text()); const by = (c: string) => rows.find(r => r['Company'] === c)!
  const P = 'Best Person (research candidate, not verified as current)'
  assert.deepEqual([by('FullCo')['Contact'], by('FullCo')[P], by('FullCo')['Best Person Title'], by('FullCo')['Best Person Profile or Source'], by('FullCo')['Contact Name']],
    ['dana@fullco.example', 'Dana Reyes', 'Head of Sales', 'https://www.linkedin.com/in/dana-reyes', 'Dana Reyes'], 'the discovery lead exports what its card shows')
  assert.match(by('FullCo')['Best Person Found Via'], /fullco\.example\/team/, 'the page that names the person is said')
  assert.deepEqual([by('BareCo')['Contact'], by('BareCo')[P]], ['', ''], 'a discovery lead with nothing stored stays empty')
  assert.deepEqual([by('OldEngineCo')['Contact'], by('OldEngineCo')[P]], ['', ''], 'a lead from another engine is unchanged')
  setUser({ id: 'B', business_name: 'Other' })
  assert.equal((await exportGET(get(`/api/leads/export?job_id=${job}`))).status, 404, "another workspace's scan is not found")
})
