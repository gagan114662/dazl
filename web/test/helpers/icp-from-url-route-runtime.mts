// POST /api/scan/icp-from-url through the real handler (#409 keyed path): real SSRF guard (stubbed DNS), real
// key-store decrypt, real owner spend guard, stubbed transport (site HTML + Anthropic fixtures). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { POST } from '../../app/api/scan/icp-from-url/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')

const HTML = `<html><head><title>Acme Dental - Family Dentist in Columbus, Ohio</title>
<meta name="description" content="Family dental care, implants and same-day crowns in Columbus, Ohio."></head>
<body><p>Acme Dental is a family dental practice in Columbus, Ohio. We provide cleanings, implants, same-day crowns,
emergency dental care and pediatric dentistry for families across Franklin County. Our team of twelve dentists and
hygienists has served Columbus since 2004. We accept most insurance plans and offer evening appointments for working
families. New patients are welcome at our two Columbus locations.</p></body></html>`
const THIN = '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
const DRAFT = { draft: { summary: 'Families and working professionals in Columbus, Ohio who need dental care',
  who: ['parents booking for a family', 'working professionals'], industries: ['healthcare consumers'],
  sizes: [], where: ['Columbus, Ohio'], signals: ['new move to Columbus', 'tooth pain emergency'], exclude: [] },
  sells: 'Family dental care, implants and same-day crowns', offers: [], items: [] }

let modelCalls = 0
let seenKey: string | null = null
globalThis.fetch = (async (u: unknown, init?: { headers?: Record<string, string> }) => {
  const url = String(u)
  if (url.endsWith('/v1/messages/count_tokens')) return new Response(JSON.stringify({ input_tokens: 100 }), { status: 200, headers: { 'content-type': 'application/json' } })
  if (url.includes('api.anthropic.com/v1/messages')) {
    modelCalls++; seenKey = init?.headers?.['x-api-key'] ?? null
    return new Response(JSON.stringify({ id: 'msg_fixture', content: [{ type: 'text', text: JSON.stringify(DRAFT) }],
      usage: { input_tokens: 100, output_tokens: 60 }, stop_reason: 'end_turn' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.startsWith('https://acme.example/')) return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } })
  if (url.startsWith('https://thin.example/')) return new Response(THIN, { status: 200, headers: { 'content-type': 'text/html' } })
  if (url.startsWith('https://down.example/')) return new Response('upstream down', { status: 503 })
  return new Response('not found', { status: 404 })
}) as unknown as typeof fetch

function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migratePlatform(db); setScanDb(db); modelCalls = 0; seenKey = null
  return db
}
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify(body) }))

test('keyed tenant gets a drafted icp from their own key; keyless tenant gets only the sourced free read', async () => {
  const db = setup()
  setUser({ id: 'T1', business_name: 'Acme' })
  saveKey(db, 'T1', 'anthropic', 'sk-fixture-ant-key')
  const r1 = await post({ url: 'https://acme.example' })
  assert.equal(r1.status, 200)
  const keyed = await r1.json()
  assert.equal(keyed.icp.summary, DRAFT.draft.summary, 'drafted icp came back through the route')
  assert.deepEqual(keyed.icp.who, DRAFT.draft.who)
  assert.equal(keyed.sells, DRAFT.sells)
  assert.equal(keyed.source, 'https://acme.example/')
  assert.equal(modelCalls, 1, 'exactly one model call')
  assert.equal(seenKey, 'sk-fixture-ant-key', 'the tenant\'s own key paid for the call')

  // Another tenant in the same db, no key of their own: the free read only, and T1's key is never used for them.
  setUser({ id: 'T2', business_name: 'Keyless Co' })
  const r2 = await post({ url: 'https://acme.example' })
  assert.equal(r2.status, 200)
  const free = await r2.json()
  assert.equal(free.free, true)
  assert.equal(free.site, 'acme.example')
  assert.equal(free.source, 'https://acme.example/')
  assert.equal(free.facts.length, 2, 'title + description, each with its source')
  assert.equal(free.facts[0].kind, 'title')
  assert.equal(free.facts[0].source, 'https://acme.example/')
  assert.equal(modelCalls, 1, 'no model call for the keyless read')
})

test('route error mapping: invalid, not_public, js_only, upstream failure, unauthenticated', async () => {
  setup()
  setUser({ id: 'T1', business_name: 'Acme' })
  const bad = await post({ url: 'not a url' })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'invalid')
  const priv = await post({ url: 'https://private.example' })
  assert.equal(priv.status, 400)
  assert.equal((await priv.json()).error, 'not_public', 'SSRF guard refusal surfaces as 400')
  const thin = await post({ url: 'https://thin.example' })
  assert.equal(thin.status, 422)
  assert.equal((await thin.json()).error, 'js_only')
  const down = await post({ url: 'https://down.example' })
  assert.equal(down.status, 502)
  assert.equal(modelCalls, 0, 'no model call on any failure leg')
  setUser(null)
  const anon = await post({ url: 'https://acme.example' })
  assert.equal(anon.status, 401)
})

test('failed recall never makes a paid call', async () => {
  const db = setup(); setUser({ id: 'T1', business_name: 'Acme' }); saveKey(db,'T1','anthropic','sk-fixture-ant-key')
  db.exec('DROP TABLE seller_decisions')
  const r = await post({ url: 'https://acme.example' })
  assert.equal(r.status,503); assert.equal((await r.json()).error,'intelligence_unavailable'); assert.equal(modelCalls,0)
})

// Fresh model output and HTML transport are fixtures; handler/key/spend/research/recall/reuse all execute for real.
test('durable seller corrections beat a fresh model after an unrelated latest play, without stale quotes', async()=>{
 const {decisionRows}=await import('../../lib/scan/intelligence.ts')
 const {captureSellerDecisions,createQueryJob}=await import('../../lib/scan/store.ts')
 const db=setup();setUser({id:'T1',business_name:'Acme'});saveKey(db,'T1','anthropic','sk-fixture-ant-key')
 const prior={v:1 as const,site:'acme.example',offers:[{i:'family-dental',n:'Family dental'}],q:null,ans:null,hyps:[{i:'family-dental:persona:parents',o:'family-dental',k:'persona' as const,t:'parents booking for a family',s:'rejected' as const,u:null,q:null,at:null}]}
 captureSellerDecisions(db,decisionRows([{offer:'family-dental',hypothesis:'family-dental:persona:parents',action:'reject'}],prior,{tenant:'T1',actor:'actor-t1',job:'original',now:1800000000000}))
 createQueryJob(db,'T1',{id:'unrelated',query:'a completely different play',icp:JSON.stringify({summary:'Unrelated',who:[],industries:[],sizes:[],where:[],signals:[],exclude:[]})})
 DRAFT.offers=[{id:'o1',name:'Family dental'}] as never
 DRAFT.items=[{offer:'o1',kind:'persona',text:'parents booking for a family',url:'https://acme.example/',quote:'Acme Dental is a family dental practice in Columbus, Ohio.'}] as never
 DRAFT.sells='Family dental'
 const r=await post({url:'https://acme.example'});assert.equal(r.status,200)
 const out=await r.json();assert.ok(!out.icp.who.includes('parents booking for a family'))
 assert.equal(out.icp.research.hyps.find((h:{k:string})=>h.k==='persona').s,'rejected')
 assert.equal(out.intelligence.selected.length,1);assert.equal(modelCalls,1)
})
