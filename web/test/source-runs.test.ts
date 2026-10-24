import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob, type LeadDraft } from '../lib/scan/runner.ts'
import { SourceRunLedger, sourceRuns, sourcesForLead } from '../lib/scan/source-runs.ts'
import { dedupKey } from '../lib/scan/evidence.ts'
import { ADAPTERS, collectEvidenceReport } from '../lib/sources/index.ts'
const candidate = { name: 'Pat', company: 'Acme', contact: null, signal: 'Hiring', source_url: 'https://example.com/news', score: 70, excerpt: 'Acme is hiring a sales team for its new office', event_date: '2026-10-01' }
function setup() {
  const db = new Database(':memory:')
  migrateScan(db)
  const id = createJob(db, 'A', { business_name: 'Seller', industry: 'software', location: 'Toronto' })
  return { db, id }
}
test('ledger migration is repeatable, old runs stay unknown and reads are tenant scoped', () => {
  const { db, id } = setup(); migrateScan(db)
  assert.deepEqual(sourceRuns(db, 'A', id), [])
  const ledger = new SourceRunLedger(); ledger.record('adapter:rss', 'empty', 0)
  ledger.write(db, id, 1, [], [], new Set())
  assert.equal((sourceRuns(db, 'A', id)[0] as any).evidence_count, 0)
  assert.deepEqual(sourceRuns(db, 'B', id), [])
})
test('same evidence URL keeps multiple actual collector credits; counts deduplicate per collector', () => {
  const { db, id } = setup(); const ledger = new SourceRunLedger()
  ledger.record('adapter:rss', 'ok', 2); ledger.record('search:anthropic', 'ok')
  ledger.evidenceCandidates([{ source: 'adapter:rss', url: candidate.source_url }], [candidate, candidate])
  ledger.candidates('search:anthropic', [candidate])
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id)
  db.prepare('INSERT INTO leads (id,scan_job_id,name,company,signal,source_url,score,dedup_key) VALUES (?,?,?,?,?,?,?,?)')
    .run('lead', id, candidate.name, candidate.company, candidate.signal, candidate.source_url, 70, dedupKey(candidate))
  ledger.write(db, id, 1, [candidate], [], new Set([`${dedupKey(candidate)}|${candidate.source_url}`]))
  const runs = sourceRuns(db, 'A', id) as any[]
  assert.deepEqual(runs.map(r => [r.collector,r.candidate_count,r.verified_count,r.inserted_count]), [['adapter:rss',1,1,1],['search:anthropic',1,1,1]])
  assert.equal(runs[1].evidence_count, null) // model search hit count is not observed
  assert.equal(sourcesForLead(db, 'A', 'lead').length, 2)
  assert.deepEqual(sourcesForLead(db, 'B', 'lead'), [])
  ledger.write(db, id, 2, [candidate], [], new Set())
  assert.equal((sourceRuns(db, 'A', id)[2] as any).inserted_count, 0)
})
test('unobserved verification stays NULL, not a made-up zero', () => {
  const { db, id } = setup(); const ledger = new SourceRunLedger()
  ledger.record('search:openai', 'started'); ledger.write(db,id,1,null,null,new Set())
  const row = sourceRuns(db,'A',id)[0] as any
  assert.equal(row.evidence_count,null); assert.equal(row.verified_count,null)
})
test('adapter reports distinguish empty, exception and timeout without late mutation', async () => {
  ADAPTERS.ledger_empty = { id:'ledger_empty', label:'test', collect:async()=>[] }
  ADAPTERS.ledger_error = { id:'ledger_error', label:'test', collect:async()=>{throw Error('test')} }
  ADAPTERS.ledger_slow = { id:'ledger_slow', label:'test', collect:async()=>{await new Promise(r=>setTimeout(r,20)); return []} }
  try {
    const result = await collectEvidenceReport({ adapters:['ledger_empty','ledger_error','ledger_slow'], feeds:[] },'test',async()=>null,3)
    assert.deepEqual(result.runs.map(r=>[r.status,r.evidence]),[['empty',0],['error',null],['timeout',null]])
    await new Promise(r=>setTimeout(r,25)); assert.equal(result.runs[2].status,'timeout')
  } finally { delete ADAPTERS.ledger_empty; delete ADAPTERS.ledger_error; delete ADAPTERS.ledger_slow }
})
test('runner records actual provider candidate counts and stored-lead attribution', async () => {
  const { db, id } = setup(); const master = randomBytes(32)
  migrateKeys(db); saveKey(db,'A','anthropic','sk-ant-test-key-AAAAAAAAAAAAAAAAAAAAAAAA',master)
  const provider = { research:async()=>({text:JSON.stringify([candidate]),citedUrls:[candidate.source_url]}) }
  const job = claimKeyedJob(db)!
  assert.equal(await runJob(db,job,{master,providers:{anthropic:provider,openai:provider},judge:null,fetchPage:async()=>({text:candidate.excerpt,title:'Acme news',retrievedAt:1791000000}),now:new Date('2026-10-22')}),'done')
  const row = sourceRuns(db,'A',id)[0] as any
  assert.equal(row.collector,'search:anthropic'); assert.equal(row.candidate_count,1)
  assert.equal(row.verified_count,1); assert.equal(row.inserted_count,1); assert.equal(row.evidence_count,null)
  const lead = db.prepare('SELECT id FROM leads WHERE scan_job_id=?').get(id) as {id:string}
  assert.deepEqual(sourcesForLead(db,'A',lead.id),[{collector:'search:anthropic',attempt:1}])
})

test('a rejected evidence URL is not credited because the same company survived via another URL', () => {
  const { db, id } = setup(); const ledger = new SourceRunLedger()
  ledger.candidates('adapter:rss', [candidate])
  ledger.candidates('search:openai', [{ ...candidate, source_url: 'https://other.example/news' }])
  ledger.write(db,id,1,[candidate],[],new Set())
  const rows = sourceRuns(db,'A',id) as any[]
  assert.equal(rows[0].verified_count,1); assert.equal(rows[1].verified_count,0)
})

test('a stale attempt cannot write ledger rows or links after its job was reclaimed', async () => {
  const { db, id } = setup(); const master = randomBytes(32)
  migrateKeys(db); saveKey(db,'A','anthropic','sk-ant-test-key-AAAAAAAAAAAAAAAAAAAAAAAA',master)
  const job = claimKeyedJob(db)!
  db.prepare('UPDATE scan_jobs SET attempts=attempts+1 WHERE id=?').run(id)
  const provider = { research:async()=>({text:JSON.stringify([candidate]),citedUrls:[candidate.source_url]}) }
  await runJob(db,job,{master,providers:{anthropic:provider,openai:provider},judge:null,fetchPage:async()=>({text:candidate.excerpt,title:'Acme news',retrievedAt:1791000000}),now:new Date('2026-10-22')})
  assert.deepEqual(sourceRuns(db,'A',id),[])
  assert.equal((db.prepare('SELECT count(*) n FROM lead_sources').get() as any).n,0)
})
test('review attribution is retained without being counted as verified', () => {
  const { db, id } = setup(); const ledger = new SourceRunLedger()
  ledger.candidates('adv:reddit',[candidate]); ledger.write(db,id,1,[],[candidate],new Set())
  const row = sourceRuns(db,'A',id)[0] as any
  assert.equal(row.review_count,1); assert.equal(row.verified_count,0)
})

test('one slow source does not drop the evidence of sources that finished (items, runs and late results agree)', async () => {
  const ev = (source: string, n: number) => Array.from({ length: n }, (_, i) => ({ source, url: `https://x.example/${source}/${i}`, title: 't', quote: 'q', date: null })) as never
  ADAPTERS.iso_fast_a = { id: 'iso_fast_a', label: 'test', collect: async () => ev('iso_fast_a', 2) }
  ADAPTERS.iso_fast_b = { id: 'iso_fast_b', label: 'test', collect: async () => ev('iso_fast_b', 1) }
  ADAPTERS.iso_slow = { id: 'iso_slow', label: 'test', collect: async () => { await new Promise(r => setTimeout(r, 30)); return ev('iso_slow', 5) } }
  try {
    const result = await collectEvidenceReport({ adapters: ['iso_fast_a', 'iso_slow', 'iso_fast_b'], feeds: [] }, 'test', async () => null, 5)
    assert.deepEqual(result.runs.map(r => [r.collector, r.status, r.evidence]), [['adapter:iso_fast_a', 'ok', 2], ['adapter:iso_slow', 'timeout', null], ['adapter:iso_fast_b', 'ok', 1]])
    assert.deepEqual(result.items.map(i => i.source), ['iso_fast_a', 'iso_fast_a', 'iso_fast_b'], 'finished sources keep their items, in selection order')
    await new Promise(r => setTimeout(r, 40))
    assert.equal(result.items.length, 3, 'the late result never enters the report')
    assert.equal(result.runs[1].status, 'timeout')
  } finally { delete ADAPTERS.iso_fast_a; delete ADAPTERS.iso_fast_b; delete ADAPTERS.iso_slow }
})

test('an erroring source keeps its siblings evidence; all-timeout and all-error give no items and exact run statuses', async () => {
  const ev = (source: string, n: number) => Array.from({ length: n }, (_, i) => ({ source, url: `https://x.example/${source}/${i}`, title: 't', quote: 'q', date: null })) as never
  ADAPTERS.iso_ok = { id: 'iso_ok', label: 'test', collect: async () => ev('iso_ok', 2) }
  ADAPTERS.iso_err = { id: 'iso_err', label: 'test', collect: async () => { throw Error('boom') } }
  ADAPTERS.iso_slow1 = { id: 'iso_slow1', label: 'test', collect: async () => { await new Promise(r => setTimeout(r, 30)); return ev('iso_slow1', 3) } }
  ADAPTERS.iso_slow2 = { id: 'iso_slow2', label: 'test', collect: async () => { await new Promise(r => setTimeout(r, 30)); return ev('iso_slow2', 4) } }
  const run = (adapters: string[], t: number) => collectEvidenceReport({ adapters, feeds: [] }, 'test', async () => null, t)
  try {
    const mixed = await run(['iso_err', 'iso_ok'], 50)
    assert.deepEqual(mixed.runs.map(r => [r.collector, r.status, r.evidence]), [['adapter:iso_err', 'error', null], ['adapter:iso_ok', 'ok', 2]])
    assert.deepEqual(mixed.items.map(i => i.source), ['iso_ok', 'iso_ok'])
    const allTimeout = await run(['iso_slow1', 'iso_slow2'], 5)
    assert.deepEqual(allTimeout.runs.map(r => [r.status, r.evidence]), [['timeout', null], ['timeout', null]])
    assert.equal(allTimeout.items.length, 0)
    await new Promise(r => setTimeout(r, 40))
    assert.equal(allTimeout.items.length, 0, 'late results never enter an all-timeout report')
    assert.deepEqual(allTimeout.runs.map(r => r.status), ['timeout', 'timeout'])
    const allErr = await run(['iso_err'], 50)
    assert.deepEqual(allErr.runs.map(r => [r.status, r.evidence]), [['error', null]]); assert.equal(allErr.items.length, 0)
  } finally { for (const k of ['iso_ok', 'iso_err', 'iso_slow1', 'iso_slow2']) delete ADAPTERS[k] }
})
