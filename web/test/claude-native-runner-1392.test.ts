import { fetchPageDetailed } from '../lib/scan/fetch-page.ts'
import { atsPostingRef, atsPublisherRef } from '../lib/sources/ats-posting.ts'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CLAUDE_SEARCH_MODEL, CLAUDE_SEARCH_MAX_USES, CLAUDE_COMPANY_FIRST_MAX_CALLS, CLAUDE_COMPANY_FIRST_MAX_USES, claudeSearchEstimate } from '../lib/llm/claude-web-search.ts'
import { accountKeys, keyHash } from '../lib/scan/lookalike-discovery.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { PINNED_FIRST5_CLAUDE_ONLY_MODE, qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob, pinAdmittedStrictJob } from '../lib/scan/store.ts'

const master = randomBytes(32)
const count = 1500
const q = 'Find commercial roofers in London, UK'
const url = 'https://public.example/official-company-page'
const netNewUrl = 'https://second-publisher.example/new-company'
const netNewName = 'Independent Sheet Metals'
const netNewQuote = netNewName + ' opened its new London office to serve commercial roofers.'
const suppliedLookalike = {
  v: 1, f: [{ d: 'i', t: 'roofing', n: 5, x: 2 }], p: 5, q: 5, h: { p: 0.75, b: 0.5, n: 4 },
  k: { c: accountKeys({ name: 'Regional Document Services' }).map(keyHash).join(''), x: '', n: '' },
}
const api = 'https://api.anthropic.com/v1/messages'
const v3 = 'native_opt_in_fixture'
const v2 = PINNED_FIRST5_CLAUDE_ONLY_MODE

async function simulate({ mode = v3, trial = false, first5 = true, cap = '5', overage = false, interrupted = false, sparseUsage = false, noNativeUrls = false, thinPublisher = false, failedPublisher = false, acceptedGeo, diverseFixture, uncertainResponse, rateLimited = false, query = q, where = ['London, UK'], industries = ['Roofing'], signals = [], now, windowDays, ordinary = false, companyFirstTenant, confirmedOffer, inputTokens, secondWave, extractionFixture, reclaimed = false, publisherError = false, useLimitOnly = false, suppliedOnlyFirstWave = false, deepSignal = false, overTokens = 300_000 }: { mode?: string; trial?: boolean; first5?: boolean; cap?: string; overage?: boolean; interrupted?: boolean; sparseUsage?: boolean; noNativeUrls?: boolean; thinPublisher?: boolean; failedPublisher?: boolean; acceptedGeo?: string; diverseFixture?: { results: string[]; cited: string[]; blocked: string[]; missing?: string[] }; uncertainResponse?: 'http' | 'body' | 'usage' | 'projected'; rateLimited?: boolean; query?: string | null; where?: string[]; industries?: string[]; signals?: string[]; now?: Date; windowDays?: number; ordinary?: boolean; companyFirstTenant?: string; confirmedOffer?:string; inputTokens?:number; secondWave?:'valid'|'unknown'|'over'; extractionFixture?:boolean; reclaimed?: boolean; publisherError?: boolean; useLimitOnly?: boolean; suppliedOnlyFirstWave?: boolean | 'unreadable'; deepSignal?: boolean; overTokens?: number } = {}) {
  const db = new Database(':memory:')
  const env = {
    DAZL_MASTER_KEY: master.toString('base64'),
    DAZL_SCAN_CAP_CAD: cap,
    DAZL_SCAN_CAP_FX_CAD_PER_USD: '1.50',
    NEWS_SEARCH_ENABLED: '0',
    LEAD_ENGINE: '',
    DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture',
    DAZL_TRIAL_SCAN_RESERVE_USD: '0.30',
    DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
    DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
    TINYFISH_API_KEY: '',
    DAZL_COMPANY_FIRST_TENANT_ID: companyFirstTenant ?? '',
  }
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const previousFetch = globalThis.fetch
  const sequence: string[] = []
  const messages: { url: string; body: Record<string, unknown>; key: string | null }[] = []
  const denied: string[] = [], publisherRequests: string[] = []
  try {
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'sk-ant-workspace-fixture', master)
    const options = JSON.stringify({ first5, paid_fallback: false, credit_enrichment: false })
    const raw = ordinary ? (companyFirstTenant ? markCompanyFirstBudget(options) : options) : qaClaudeOnlyBudget(options, mode === v3)
    const job = db.transaction(() => {
      createQueryJob(db, 'workspace', { id: 'job', query: query ?? '', runBudget: raw, icpReviewed: true, offer:confirmedOffer, icp: JSON.stringify({ summary: query ?? 'Reviewed buyer type', who: confirmedOffer ? ['owner'] : [], industries, sizes: confirmedOffer ? ['11-50'] : [], where, signals, exclude: confirmedOffer ? ['Not a competitor'] : [], ...(suppliedOnlyFirstWave ? { lookalike: suppliedOnlyFirstWave === 'unreadable' ? { v: 99 } : suppliedLookalike } : {}), ...(windowDays ? { window_days: windowDays } : {}) }) })
      if (query === null) db.exec("UPDATE scan_jobs SET query=NULL WHERE id='job'") // legacy/non-query row: never open native discovery
      if (reclaimed) db.exec("UPDATE scan_jobs SET attempts=1 WHERE id='job'")
      if (trial) db.exec("UPDATE scan_jobs SET funded_by='trial' WHERE id='job'")
      return ordinary ? claimKeyedJob(db, 'job')! : pinAdmittedStrictJob(db, 'workspace', 'job', raw)
    }).immediate()
    const io: typeof fetch = async (input, init) => {
      const target = String(input)
      if (target !== api && target !== api + '/count_tokens') { denied.push(target); throw Error('offline fixture refused network') }
      const body = JSON.parse(String(init?.body ?? '{}'))
      messages.push({ url: target, body, key: new Headers(init?.headers).get('x-api-key') })
      const native = Array.isArray(body.tools) || String(body.messages?.[0]?.content ?? '').startsWith('Find public company or publisher pages')
      if (target.endsWith('/count_tokens')) assert.equal('tools' in body, false, 'Anthropic count_tokens rejects server tools')
      sequence.push(native ? target.endsWith('/count_tokens') ? 'native-count' : 'native-send' : 'model')
      if (target.endsWith('/count_tokens')) return Response.json({ input_tokens: count })
      if (!native) {
        const excerpt='Regional Document Services opened its new London office to serve commercial roofers.'
        const netNew = suppliedOnlyFirstWave && sequence.filter(x=>x==='native-send').length===2
        const text=extractionFixture&&JSON.stringify(body.messages).includes('This is company-first discovery') ? JSON.stringify(netNew ? [
          { name:'', company:netNewName, signal:'Office expansion', source_url:netNewUrl, excerpt:netNewQuote, event_date:null, score:75 },
        ] : [
          {name:'Do Not Extract',contact:'contact@example.test',company:'Regional Document Services',signal:'Office expansion',
            source_url:url,excerpt,event_date:null,score:70},
          {name:'',company:'Invented Entity',signal:'Office expansion',source_url:url,excerpt,event_date:null,score:80},
          {name:'',company:'Regional Document Services',signal:'New contract',source_url:url,
            excerpt:'A fabricated entirely unwritten contract sentence.',event_date:null,score:80},
        ]) : '[]'
        return Response.json({model:CLAUDE_SEARCH_MODEL,content:[{type:'text',text}],usage:{input_tokens:100,output_tokens:15}})
      }
      const sent=sequence.filter(s=>s==='native-send').length
      const held = db.prepare("SELECT reserve_usd FROM scan_spend_calls WHERE scan_job_id='job' AND status='reserved'").all()
      assert.deepEqual(held, [{ reserve_usd: claudeSearchEstimate(count,ordinary&&companyFirstTenant==='workspace'?'company_first':undefined).estimatedUsd }], 'durable search reserve exists at time of send')
      if (rateLimited && sequence.filter(x => x === 'native-send').length === 1)
        return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' }, request_id: 'req_fixture' }, { status: 429, headers: { 'request-id': 'req_fixture' } })
      if(sent===2&&secondWave==='unknown')throw Error('fixture second call uncertain, no retry')
      if(sent===2&&secondWave)assert.equal(db.prepare("SELECT count(*) FROM scan_spend_calls WHERE kind='llm.anthropic.web_search' AND status='settled'").pluck().get(),1)
      if (interrupted) throw Error('offline fixture response dropped')
      if (uncertainResponse === 'http') return new Response('raw-response-sentinel', { status: 529 })
      if (uncertainResponse === 'body') return new Response('raw-response-sentinel')
      if (uncertainResponse === 'usage') return Response.json({ model: CLAUDE_SEARCH_MODEL, content: 'raw-response-sentinel', usage: {} })
      if (uncertainResponse === 'projected') return Response.json({
        model: CLAUDE_SEARCH_MODEL, content: 'raw-response-sentinel', id: 'hidden-request-id',
        usage: { input_tokens: 8_000, output_tokens: 10_000_001, cache_read_input_tokens: null, service_tier: 'priority',
          inference_geo: 'secret-enum-value', speed: 'standard', cache_creation: { ephemeral_5m_input_tokens: 3, arbitrary: 'private-cache-value' },
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 0, provider_private_tool: 1 } },
      })
      return Response.json({
        model: CLAUDE_SEARCH_MODEL, stop_reason: 'end_turn', role: 'assistant', type: 'message',
        content: noNativeUrls ? [
          { type: 'web_search_tool_result', content: { type: 'opaque-private-sentinel' } },
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'opaque-private-sentinel' }] },
          { type: 'web_search_tool_result', content: [] },
          ...['too_many_requests', 'invalid_tool_input', 'max_uses_exceeded', 'query_too_long', 'request_too_large', 'unavailable', '__proto__', 'opaque-private-sentinel'].map(error_code =>
            ({ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code } })),
        ] : useLimitOnly ? [
          { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
        ] : diverseFixture ? [
          { type: 'web_search_tool_result', content: diverseFixture.results.map(url => ({ type: 'web_search_result', url })) },
          { type: 'text', citations: diverseFixture.cited.map(url => ({ type: 'web_search_result_location', url })) },
        ] : [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: suppliedOnlyFirstWave && sent===2 ? netNewUrl : url }] }],
        usage: { input_tokens: sent===2 && secondWave==='over' ? overTokens : inputTokens ?? (overage ? 100_000 : 8_000), output_tokens: 200,
          ...(acceptedGeo !== undefined ? { inference_geo: acceptedGeo } : {}),
          ...(!sparseUsage ? { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } : {}),
          server_tool_use: { web_search_requests: inputTokens ? 2 : 1, web_fetch_requests: 0 } },
      })
    }
    globalThis.fetch = io
    const status = await runJob(db, job, {
      master, fetchImpl: io, score: false, ground: false, judge: null, now,
      fetchPage: async page => {
        sequence.push('publisher-page')
        publisherRequests.push(page)
        if (suppliedOnlyFirstWave && page === netNewUrl) return { title: 'Second publisher', retrievedAt: 1_700_000_000, text: netNewQuote.repeat(5) }
        if (!diverseFixture) assert.equal(page, url)
        if (publisherError) throw new Error('fixture: publisher handoff unavailable')
        if (sparseUsage) assert.deepEqual(db.prepare("SELECT status,actual_usd FROM scan_spend_calls WHERE scan_job_id='job' AND kind='llm.anthropic.web_search'").get(),
          { status: 'settled', actual_usd: 0.037 }, 'native billing is durable before publisher evidence is read')
        if (failedPublisher || diverseFixture?.blocked.includes(page)) return { fail: 'blocked' }
        if (diverseFixture?.missing?.includes(page)) return { fail: 'not_found' }
        return { title: 'Publisher page', retrievedAt: 1_700_000_000, text: deepSignal ? 'Products Pricing Customers Careers Login Start free. '.repeat(60) + 'Regional Document Services raised new funding to grow its commercial roofers team in London. ' + 'Footer links. '.repeat(20) : thinPublisher ? 'too short' : extractionFixture ? 'Regional Document Services opened its new London office to serve commercial roofers. '.repeat(5) : 'Published evidence about a commercial roofing company. '.repeat(8) }
      },
    })
    const end = db.prepare('SELECT status, error FROM scan_jobs WHERE id=?').get(job.id)
    const ledger = db.prepare('SELECT status, reason, reserve_usd, actual_usd FROM scan_spend_calls WHERE scan_job_id=? ORDER BY rowid').all(job.id)
    const jobSpend = db.prepare('SELECT spend_reserved_usd, spend_cap_reserved_usd FROM scan_jobs WHERE id=?').get(job.id)
    const pool = db.prepare('SELECT period,reserved_usd,reported_usd FROM tenant_spend_pools WHERE tenant_id=? ORDER BY period').all('workspace')
    let second
    if (interrupted || rateLimited) {
      const id = 'next-play'
      const next = db.transaction(() => {
        createQueryJob(db, 'workspace', { id, query: q, runBudget: raw, icp: JSON.stringify({ summary: q, who: [], industries: ['Roofing'], sizes: [], where: ['London, UK'], signals: [], exclude: [] }) })
        return pinAdmittedStrictJob(db, 'workspace', id, raw)
      }).immediate()
      await runJob(db, next, { master, fetchImpl: io, score: false, ground: false, judge: null })
      second = db.prepare('SELECT status, error FROM scan_jobs WHERE id=?').get(id)
    }
    const nativeStatus = db.prepare("SELECT status FROM scan_source_runs WHERE job_id=? AND collector=?").get(job.id, ordinary ? 'search:company_first' : 'search:anthropic_web')
    const reportRow = db.prepare('SELECT report FROM scan_run_report WHERE job_id=? AND attempt=1').get(job.id) as { report: string } | undefined
    return { status, sequence, messages, denied, publisherRequests, end, ledger, jobSpend, pool, second, nativeStatus,
      report:reportRow ? JSON.parse(reportRow.report) : undefined,
      nativeReport: reportRow ? JSON.parse(reportRow.report).native_web_search : undefined }
  } finally {
    globalThis.fetch = previousFetch
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    db.close()
  }
}

test('ordinary claimed query uses the company-first source for exactly the configured workspace', async () => {
  const open = await simulate({ ordinary: true, companyFirstTenant: 'workspace', windowDays: 90 })
  const delivered = open.messages.find(m => Array.isArray(m.body.tools))
  assert.equal(delivered?.key, 'sk-ant-workspace-fixture', JSON.stringify({end:open.end, sequence:open.sequence, ledger:open.ledger, nativeStatus:open.nativeStatus}))
  const prompt = JSON.stringify(delivered?.body)
  assert.match(prompt, /Find organizations in the requested geography/)
  assert.match(prompt, /Locate the official company website/)
  assert.match(prompt, /45 days/)
  assert.deepEqual(open.publisherRequests, [url])
  assert.ok(open.nativeStatus)
  assert.ok(open.nativeReport && open.nativeReport.actual_usd > 0)
  assert.equal(open.end && (open.end as { error: string }).error, 'no_candidates', 'a source page alone did not become a lead')
})

test('company first reserves observed high-token shape, carries reviewed seller, and runs up to three distinct accounted angles while candidates are short',async()=>{
  // #case1 (prod run 8d422adf): two searches on one angle found one aggregator page. With no candidate yet and room under
  // the scan cap, company-first keeps going through every distinct angle, each with the wider four-search tool.
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',
    inputTokens:101937,secondWave:'valid',cap:'10'})
  const paid=r.messages.filter(x=>Array.isArray(x.body.tools))
  assert.equal(paid.length,CLAUDE_COMPANY_FIRST_MAX_CALLS)
  assert.equal(paid.length,3)
  for(const x of paid)assert.deepEqual(x.body.tools,[{type:'web_search_20250305',name:'web_search',max_uses:CLAUDE_COMPANY_FIRST_MAX_USES}])
  assert.equal(CLAUDE_COMPANY_FIRST_MAX_USES,4)
  const prompts=paid.map(x=>JSON.stringify(x.body.messages))
  assert.match(prompts[0],/could actually use the reviewed seller offer/)
  assert.match(prompts[1],/work backwards to the buyer category/)
  assert.match(prompts[2],/first-party pages only/)
  assert.match(prompts[2],/applicant tracking system job permalinks/)
  for(const prompt of prompts){
    assert.match(prompt,/Independent commercial document services/)
    assert.match(prompt,/Not a competitor/)
    assert.match(prompt,/11-50/)
  }
  assert.equal(r.nativeReport.searches,6)
  assert.equal(r.nativeReport.reported_input_tokens,3*101937)
  assert.equal(r.nativeReport.assumed_result_tokens,3*4*50000)
  assert.equal(r.nativeReport.estimated_usd,3*claudeSearchEstimate(count,'company_first').estimatedUsd)
  assert.equal(r.nativeReport.estimate_exceeded,false)
  assert.deepEqual(r.publisherRequests,[url],'no duplicate source read across angles')
})
test('company first at the default CAD 5 scan cap never settles more native search spend than the cap allows',async()=>{
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',
    inputTokens:101937,secondWave:'valid'})
  const sends=r.sequence.filter(x=>x==='native-send').length
  assert.ok(sends>=2&&sends<=CLAUDE_COMPANY_FIRST_MAX_CALLS,String(sends))
  assert.ok(sends*claudeSearchEstimate(count,'company_first').estimatedUsd<=5/1.5+1e-9,'every dispatched call was reserved inside the cap')
})
test('company first: an angle that only hit the search-use limit and ended normally lets the next distinct angle run',async()=>{
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',useLimitOnly:true})
  assert.equal(r.sequence.filter(x=>x==='native-send').length,CLAUDE_COMPANY_FIRST_MAX_CALLS)
})
test('legacy QA native search still stops after a use-limit-only result',async()=>{
  const r=await simulate({useLimitOnly:true})
  assert.equal(r.sequence.filter(x=>x==='native-send').length,1)
})
test('company first gives extraction the request-term passage of a long first-party page, not only its navigation head',async()=>{
  // Prod run 878b07b5: 10 usable first-party pages, every extraction returned []: only the first 1200 characters (navigation)
  // reached the model. The signal sentence sits ~3,000 characters into this page.
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',deepSignal:true})
  const extraction=r.messages.filter(x=>!Array.isArray(x.body.tools)&&JSON.stringify(x.body.messages??'').includes('This is company-first discovery'))
  assert.ok(extraction.length>0,'the extraction call ran')
  assert.ok(extraction.every(x=>JSON.stringify(x.body.messages).includes('Regional Document Services raised new funding to grow its commercial roofers team')))
})
test('company first does not retry an uncertain second batch and retains its reservation',async()=>{
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',
    secondWave:'unknown'})
  assert.equal(r.sequence.filter(x=>x==='native-send').length,2)
  assert.equal((r.end as {error:string}).error,'accounting_uncertain')
  assert.ok((r.ledger as {status:string}[]).some(x=>x.status==='reserved'))
  assert.equal(r.nativeReport.actual_usd,null,'no pretend complete total on unknown usage')
  assert.ok(r.nativeReport.prior_settled_usd>0)
  assert.equal(r.nativeReport.usage_incomplete,true)
  assert.equal(r.nativeReport.reported_input_tokens,8000)
})

test('only supplied lookalikes in the first angle allow a net-new second angle and are audited once', async () => {
  const r = await simulate({ ordinary: true, companyFirstTenant: 'workspace', windowDays: 45,
    confirmedOffer: 'Independent commercial document services', extractionFixture: true, suppliedOnlyFirstWave: true })
  assert.ok(r.sequence.filter(x => x === 'native-send').length >= 2)
  assert.equal(r.report.observed.verification, true)
  assert.ok(r.report.candidates.some((x: { company: string }) => x.company === netNewName))
  const drops = r.report.candidates.filter((x: { company: string }) => x.company === 'Regional Document Services')
  assert.equal(drops.length, 1)
  assert.equal(drops[0].fate, 'dropped:lookalike_supplied_customer')
  assert.equal(r.report.funnel.drop_reasons.lookalike_supplied_customer, 1)
})

test('an unreadable supplied lookalike block cannot open a recovery angle', async () => {
  const r = await simulate({ ordinary: true, companyFirstTenant: 'workspace', windowDays: 45,
    confirmedOffer: 'Independent commercial document services', suppliedOnlyFirstWave: 'unreadable', useLimitOnly: true })
  assert.equal(r.sequence.filter(x => x === 'native-send').length, 1)
  assert.equal(r.publisherRequests.length, 0)
})

test('#1454 latching: a later angle that settles over its estimate keeps first-wave candidates and sends them to verification', async () => {
  const r = await simulate({ ordinary: true, companyFirstTenant: 'workspace', windowDays: 45,
    confirmedOffer: 'Independent commercial document services', extractionFixture: true, secondWave: 'over' })
  assert.equal(r.sequence.filter(x => x === 'native-send').length, 2, 'one candidate is short of the target: a second angle runs')
  assert.ok((r.ledger as { status: string }[]).every(x => x.status === 'settled'), JSON.stringify(r.ledger))
  assert.equal(r.report.observed.verification, true)
  assert.match(JSON.stringify(r.report), /Regional Document Services/)
  assert.notEqual(r.end && (r.end as { error?: string }).error, 'native_search_estimate_exceeded')
})
test('#1454: a later angle with unknown charge still stops honestly and keeps its reservation (no spend on top of an unknown)', async () => {
  const r = await simulate({ ordinary: true, companyFirstTenant: 'workspace', windowDays: 45,
    confirmedOffer: 'Independent commercial document services', extractionFixture: true, secondWave: 'unknown' })
  assert.equal(r.sequence.filter(x => x === 'native-send').length, 2)
  assert.equal(r.end && (r.end as { error?: string }).error, 'accounting_uncertain')
  assert.ok((r.ledger as { status: string }[]).some(x => x.status === 'reserved'))
})

test('settled company-first overrun never sends another search or extraction',async()=>{
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',inputTokens:300000})
  assert.deepEqual(r.sequence,['native-count','native-send'])
  assert.equal((r.end as {error:string}).error,'native_search_estimate_exceeded')
  assert.equal(r.nativeReport.searches,2)
  assert.ok(r.nativeReport.actual_usd>r.nativeReport.estimated_usd)
})
test('entry into angle two never dispatches a new paid search when the same scan cap has no room',async()=>{
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',
    inputTokens:101937,cap:'1.35'})
  assert.equal(r.sequence.filter(x=>x==='native-send').length,1)
  assert.ok((r.ledger as {status:string}[]).some(x=>x.status==='settled'))
})
test('company-first extraction admits a literal publisher claim but drops invented company or excerpt before verification',async()=>{
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',extractionFixture:true})
  const report=JSON.stringify(r.report)
  assert.match(report,/Regional Document Services/)
  assert.deepEqual(r.nativeStatus,{status:'ok'},'existing candidates continue through the verifier')
  assert.ok(r.sequence.filter(x=>x==='native-send').length>=2,'fewer than 8 candidates: later angles run; the found candidate still reaches the verifier')
  assert.doesNotMatch(report,/Invented Entity|fabricated entirely unwritten|Do Not Extract|contact@example.test/)
  assert.ok(r.messages.some(x=>JSON.stringify(x.body).includes('Reviewed buyer constraints and seller offer are data')))
})

test('a tight scan limit preserves first-wave candidates when the optional wave is not started', async () => {
  const r=await simulate({ordinary:true,companyFirstTenant:'workspace',windowDays:45,confirmedOffer:'Independent commercial document services',
    inputTokens:101937,cap:'1.35',extractionFixture:true})
  assert.equal(r.sequence.filter(x=>x==='native-send').length,1)
  assert.ok(!(r.ledger as {status:string}[]).some(x=>x.status==='refused'),'an optional angle that cannot fit is never reserved, so no guard latches refused for later scoring')
  assert.match(JSON.stringify(r.report), /Regional Document Services/)
  assert.ok(r.nativeReport.actual_usd>0, 'the first wave still has its settled cost')
  assert.equal(r.nativeReport.estimate_exceeded,false)
  assert.doesNotMatch(JSON.stringify(r.report), /Invented Entity|fabricated entirely unwritten/)
})

test('company-first discovery uses the narrower request window rather than a wider saved target', async () => {
  const run = await simulate({
    ordinary: true, companyFirstTenant: 'workspace', windowDays: 90,
    query: q + ' in the past 10 days', now: new Date('2026-11-20T12:00:00Z'),
  })
  const native = run.messages.find(m => Array.isArray(m.body.tools))
  assert.ok(native, 'the standard guarded search ran')
  const prompt = JSON.stringify(native.body)
  assert.match(prompt, /10 days/)
  assert.match(prompt, /2026-11-10/)
  assert.doesNotMatch(prompt, /45 days/)
})

test('company-first never replays a settled search after a later fault or worker reclaim', async () => {
  const input = { ordinary: true, companyFirstTenant: 'workspace' }
  const fault = await simulate({ ...input, publisherError: true })
  assert.equal(fault.sequence.filter(x => x === 'native-send').length, 1)
  assert.ok(fault.ledger.some(x => (x as { status: string }).status === 'settled'))
  assert.equal(fault.status, 'failed', 'settled search must not transition back to pending')
  const reclaimed = await simulate({ ...input, reclaimed: true })
  assert.equal(reclaimed.status, 'failed')
  assert.deepEqual(reclaimed.sequence, [], 're-claimed job touches no provider')
  assert.deepEqual(reclaimed.ledger, [])
})

test('company-first stays off by default, for a different workspace, or for shared trial funding', async () => {
  for (const options of [{}, { companyFirstTenant: 'different-workspace' }, { companyFirstTenant: 'workspace', trial: true }]) {
    const run = await simulate({ ordinary: true, ...options })
    assert.equal(run.messages.some(m => Array.isArray(m.body.tools)), false)
    assert.equal(run.nativeStatus, undefined)
  }
})

test('pinned V3 uses one counted, budgeted native request with workspace key and validates publisher evidence afterward', async () => {
  const x = await simulate()
  const native = x.messages.filter(m => Array.isArray(m.body.tools) || (m.url.endsWith('/count_tokens') && JSON.stringify(m.body).includes('Find public company or publisher pages')))
  assert.equal(native.length, 2, JSON.stringify(x))
  assert.deepEqual(native.map(m => m.url), [api + '/count_tokens', api])
  assert.deepEqual(native.map(m => m.key), ['sk-ant-workspace-fixture', 'sk-ant-workspace-fixture'])
  assert.equal('tools' in native[0].body, false)
  assert.deepEqual(native[1].body, { ...native[0].body, max_tokens: 3000, service_tier: 'standard_only', tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: CLAUDE_SEARCH_MAX_USES }] })
  assert.deepEqual(x.sequence.slice(0, 3), ['native-count', 'native-send', 'publisher-page'])
  assert.deepEqual(x.denied, [])
})

test('#1392 native discovery includes profile-only geography, services and signals before URL fetch', async () => {
  const query = 'Find distributors'
  const where = ['Utrecht, Netherlands', 'Gent, Belgium']
  const industries = ['Refrigerated logistics']
  const signals = ['New distribution facility', 'Public warehouse expansion']
  const x = await simulate({ query, where, industries, signals })
  const [native] = x.messages.filter(m => Array.isArray(m.body.tools))
  assert.ok(native)
  const prompt = (native.body.messages as { content: string }[])[0].content
  const data = JSON.parse(prompt.slice(prompt.indexOf('Request: ') + 'Request: '.length))
  assert.deepEqual(data, { query, where, industries, signals })
  assert.doesNotMatch(prompt, /Toronto|London|roofing/)
  assert.deepEqual(x.denied, [])
})

test('legacy V2, trial-funded V3, V3 without strict first5 and legacy no-query rows never request native web search', async () => {
  for (const options of [{ mode: v2 }, { trial: true }, { first5: false }, { query: null }]) {
    const x = await simulate(options)
    assert.equal(x.messages.some(m => Array.isArray(m.body.tools)), false, JSON.stringify(x))
    assert.deepEqual(x.denied, [])
  }
})

test('under the estimate, the scan refuses before the paid request and stays stopped', async () => {
  const x = await simulate({ cap: '0.15' })
  assert.deepEqual(x.sequence, ['native-count'], JSON.stringify(x))
  assert.deepEqual(x.end, { status: 'failed', error: 'budget_stopped' })
  assert.ok(x.ledger.some(row => (row as { status: string; reason: string }).status === 'refused' && (row as { reason: string }).reason === 'over_cap'))
})

test('known actual overage is settled in full and stops before any publisher or further model work', async () => {
  const x = await simulate({ overage: true })
  assert.deepEqual(x.sequence, ['native-count', 'native-send'], JSON.stringify(x))
  assert.deepEqual(x.end, { status: 'failed', error: 'native_search_estimate_exceeded' })
  const actual = (100_000 * 3 + 200 * 15) / 1e6 + 0.01
  assert.deepEqual(x.ledger, [{ status: 'settled', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: actual }])
  assert.equal(x.pool.length, 2)
  for (const row of x.pool as { reserved_usd: number; reported_usd: number }[]) {
    assert.ok(Math.abs(row.reserved_usd - actual) < 1e-8)
    assert.ok(Math.abs(row.reported_usd - actual) < 1e-8)
  }
})

test('unknown native search billing stops the old play without permanently blocking a separately admitted play', async () => {
  const x = await simulate({ interrupted: true })
  assert.deepEqual(x.end, { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(x.second, { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(x.nativeStatus, { status: 'error:transport' })
  assert.deepEqual(x.sequence, ['native-count', 'native-send', 'native-count', 'native-send'])
  assert.deepEqual(x.ledger, [{ status: 'reserved', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: null }])
})

test('post-send failure diagnostics distinguish response paths without releasing unknown spend', async () => {
  for (const [uncertainResponse, reason] of [['http', 'http_error'], ['body', 'response_unreadable'], ['usage', 'usage_envelope']] as const) {
    const x = await simulate({ uncertainResponse })
    assert.deepEqual(x.end, { status: 'failed', error: 'accounting_uncertain' })
    assert.deepEqual(x.sequence, ['native-count', 'native-send'])
    assert.deepEqual(x.nativeStatus, { status: `error:${reason}` })
    assert.deepEqual(x.ledger, [{ status: 'reserved', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: null }])
    assert.doesNotMatch(JSON.stringify(x.nativeStatus), /raw-response-sentinel/)
  }
})

test('authenticated 429 stops this play, reverses all reservations and lets a separate play send once', async () => {
  const x = await simulate({ rateLimited: true })
  assert.deepEqual(x.end, { status: 'failed', error: 'provider_rate_limited' })
  assert.deepEqual(x.sequence.slice(0, 4), ['native-count', 'native-send', 'native-count', 'native-send'])
  assert.deepEqual(x.ledger, [{ status: 'settled', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: 0 }])
  assert.deepEqual(x.jobSpend, { spend_reserved_usd: 0, spend_cap_reserved_usd: 0 })
  for (const row of x.pool as { reserved_usd: number; reported_usd: number }[]) {
    assert.equal(row.reserved_usd, 0)
    assert.equal(row.reported_usd, 0)
  }
  assert.equal(x.sequence.filter(x => x === 'native-send').length, 2)
})


test('the real runner settles sparse documented native usage before reading publisher evidence', async () => {
  const x = await simulate({ sparseUsage: true })
  assert.deepEqual(x.sequence.slice(0, 3), ['native-count', 'native-send', 'publisher-page'])
  assert.deepEqual(x.ledger[0], { status: 'settled', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: 0.037 })
})


test('a refusal writes only bounded billing fields on the tenant run report and never settles or fetches evidence', async () => {
  const x = await simulate({ uncertainResponse: 'projected' })
  assert.deepEqual(x.end, { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(x.sequence, ['native-count', 'native-send'])
  assert.deepEqual(x.nativeStatus, { status: 'error:usage_tier' })
  assert.equal(x.nativeReport.actual_usd, null)
  assert.equal(x.nativeReport.reported_input_tokens, null)
  assert.equal(x.nativeReport.searches, null)
  assert.deepEqual(x.nativeReport.rejected_usage, {
    rejection: 'usage_tier', usage: 'object', model: CLAUDE_SEARCH_MODEL,
    inference_geo: 'unrecognized', speed: 'standard', service_tier: 'priority', input_tokens: 8000,
    output_tokens: 'outside_diagnostic_bound', cache_read_input_tokens: 'null', cache_creation_input_tokens: 'absent',
    cache_creation: 'object', ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 'absent',
    server_tool_use: 'object', web_search_requests: 2, web_fetch_requests: 0, other_tool_counts: 'nonzero_or_invalid',
  })
  assert.doesNotMatch(JSON.stringify(x.nativeReport), /secret-enum-value|hidden-request-id|raw-response-sentinel|private-cache-value|provider_private_tool/)
  assert.deepEqual(x.ledger, [{ status: 'reserved', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: null }])
})

test('settled unavailable searches distinguish discarded transport results from thin publisher pages', async () => {
  const noUrls = await simulate({ noNativeUrls: true })
  const thin = await simulate({ thinPublisher: true })
  const blocked = await simulate({ failedPublisher: true })
  for (const x of [noUrls, thin, blocked]) {
    assert.deepEqual(x.nativeStatus, { status: 'unavailable' })
    assert.equal(x.nativeReport.actual_usd, 0.037)
    assert.doesNotMatch(JSON.stringify(x.nativeReport), /opaque-private-sentinel|too short/)
  }
  const present = { stop: 'end_turn', result_blocks: 1, non_array_result_blocks: 0, empty_result_blocks: 0,
    malformed_result_blocks: 0, result_errors: {}, result_entries: 1, safe_urls: 1, publisher_attempted: 1,
    publisher_returned: 1, publisher_failures: {}, publisher_usable: 0, evidence_items: 0 }
  assert.deepEqual(noUrls.nativeReport.evidence_diagnostic, { stop: 'end_turn', result_blocks: 11, non_array_result_blocks: 9,
    empty_result_blocks: 1, malformed_result_blocks: 1, result_errors: { too_many_requests: 1, invalid_tool_input: 1,
      max_uses_exceeded: 1, query_too_long: 1, request_too_large: 1, unavailable: 1, other: 2 },
    result_entries: 1, safe_urls: 0, publisher_attempted: 0, publisher_returned: 0, publisher_failures: {}, publisher_usable: 0, evidence_items: 0 })
  assert.deepEqual(thin.nativeReport.evidence_diagnostic, present)
  assert.deepEqual(blocked.nativeReport.evidence_diagnostic, { ...present, publisher_returned: 0, publisher_failures: { blocked: 1 } })
})

test('settled pre-4.6 geo fallback persists only a fixed diagnostic, never raw provider metadata', async () => {
  const injected = 'secret-geo-sentinel\n<script>injection</script>'
  const x = await simulate({ sparseUsage: true, acceptedGeo: injected })
  assert.equal(x.nativeReport.actual_usd, 0.037)
  assert.equal(x.nativeReport.inference_geo_diagnostic, 'unrecognized_price_neutral')
  assert.doesNotMatch(JSON.stringify(x.nativeReport), /secret-geo-sentinel|<script>/)
  assert.deepEqual(x.ledger[0], { status: 'settled', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: 0.037 })
  const documented = await simulate({ sparseUsage: true, acceptedGeo: 'not_available' })
  assert.equal(documented.nativeReport.actual_usd, 0.037)
  assert.equal(documented.nativeReport.inference_geo_diagnostic, 'not_available')
  for (const acceptedGeo of ['us', 'global', undefined]) {
    const known = await simulate({ sparseUsage: true, acceptedGeo })
    assert.equal(known.nativeReport.actual_usd, 0.037)
    assert.equal(Object.hasOwn(known.nativeReport, 'inference_geo_diagnostic'), false)
  }
})

test('native shortlist promotes admitted citations and never fetches citation-only URLs', async () => {
  const blocked = ['a', 'b', 'c', 'd', 'e'].map(host => `https://${host}.example/blocked`)
  const x = await simulate({ diverseFixture: { results: [...blocked, url], cited: ['https://citation-only.example/', url], blocked } })
  assert.deepEqual(x.publisherRequests, [url, ...blocked])
  assert.equal(x.nativeReport.evidence_diagnostic.publisher_attempted, 6)
  assert.equal(x.nativeReport.evidence_diagnostic.publisher_lookahead_attempted, 1)
  assert.equal(x.nativeReport.evidence_diagnostic.publisher_failures.blocked, 5)
  assert.equal(x.nativeReport.evidence_diagnostic.evidence_items, 1)
  assert.deepEqual(x.sequence.filter(s => s.startsWith('native-')), ['native-count', 'native-send'])
  const alreadyReadable = await simulate({ diverseFixture: { results: [url, ...blocked], cited: [], blocked } })
  assert.equal(x.sequence.filter(s => s === 'model').length, alreadyReadable.sequence.filter(s => s === 'model').length)
})

test('uncited shortlist keeps ATS boards distinct and skips a blocked origin and publisher', async () => {
  const blocked = 'https://publisher.example/blocked', repeat = 'https://publisher.example/repeat'
  const subdomain = 'https://news.publisher.example/different-origin'
  const alpha = 'https://boards.greenhouse.io/alpha/jobs/1', beta = 'https://boards.greenhouse.io/beta/jobs/2'
  const x = await simulate({ diverseFixture: { results: [blocked, repeat, subdomain, alpha, beta], cited: [], blocked: [blocked] } })
  assert.deepEqual(x.publisherRequests, [blocked, alpha, beta])
  assert.equal(x.nativeReport.evidence_diagnostic.publisher_attempted, 3)
  assert.equal(x.nativeReport.evidence_diagnostic.publisher_failures.blocked, 1)
})

test('uncited shortlist prioritizes distinct official ATS board roots within the existing five slots', async () => {
  const alpha = 'https://jobs.lever.co/alpha', beta = 'https://jobs.lever.co/beta'
  const outside = ['a', 'b', 'c', 'd'].map(host => `https://${host}.example/source`)
  const x = await simulate({ diverseFixture: { results: [alpha, beta, ...outside], cited: [], blocked: [] } })
  assert.deepEqual(x.publisherRequests, [alpha, beta, ...outside.slice(0, 3)])
  assert.equal(x.nativeReport.evidence_diagnostic.publisher_attempted, 5)
})

test('ATS root identity is ranking-only and restricted to documented board hosts and path shape', () => {
  for (const [host, kind] of [['jobs.lever.co', 'lever'], ['jobs.ashbyhq.com', 'ashby'],
    ['boards.greenhouse.io', 'greenhouse'], ['job-boards.greenhouse.io', 'greenhouse']]) {
    const root = `https://${host}/alpha/`
    assert.deepEqual(atsPublisherRef(root), { kind, org: 'alpha' })
    assert.equal(atsPostingRef(root), null)
  }
  assert.deepEqual(atsPublisherRef('https://boards.greenhouse.io/alpha/jobs/123'), { kind: 'greenhouse', org: 'alpha' })
  for (const raw of ['https://jobs.lever.co/', 'https://jobs.lever.co/alpha/unknown', 'https://jobs.lever.co/%61lpha',
    'https://jobs.lever.co/alpha?token=beta', 'https://jobs.lever.co.evil.example/alpha',
    'http://jobs.lever.co/alpha', 'https://user@jobs.lever.co/alpha', 'https://jobs.lever.co:444/alpha']) {
    assert.equal(atsPublisherRef(raw), null, raw)
  }
})


test('thin native source batch looks ahead to distinct admitted publishers without another native call', async () => {
  const blocked = ['a', 'b', 'c'].map(host => `https://${host}.example/blocked`)
  const missing = 'https://missing.example/gone', extra = ['f','g','h','i'].map(host => `https://${host}.example/evidence`)
  const repeat = 'https://news.a.example/alternate-identity'
  const x = await simulate({ diverseFixture: { results: [...blocked, missing, url, repeat, ...extra],
    cited: ['https://citation-only.example/'], blocked, missing: [missing, ...extra.slice(1)] } })
  assert.deepEqual(x.publisherRequests, [...blocked, missing, url, ...extra.slice(0, 3)])
  assert.deepEqual(x.nativeReport.evidence_diagnostic.publisher_failures, { blocked: 3, not_found: 3 })
  assert.equal(x.nativeReport.evidence_diagnostic.publisher_attempted, 8)
  assert.equal(x.nativeReport.evidence_diagnostic.publisher_lookahead_attempted, 3)
  assert.equal(x.nativeReport.evidence_diagnostic.evidence_items, 2)
  assert.equal(x.nativeReport.actual_usd, 0.037)
  assert.deepEqual(x.sequence.filter(s => s.startsWith('native-')), ['native-count', 'native-send'])
  const baseline = await simulate({ diverseFixture: { results: [url, extra[0]], cited: [], blocked: [] } })
  assert.equal(x.sequence.filter(s => s === 'model').length, baseline.sequence.filter(s => s === 'model').length)
})


test('native hop fencing refuses a URL before any network or rendering work', async () => {
  const inspected: string[] = []
  assert.deepEqual(await fetchPageDetailed('https://blocked.example/topic', async () => {
    assert.fail('refused hop must not render')
  }, undefined, { allow: url => { inspected.push(url.origin); return false }, blocked: () => assert.fail('refused hop was not requested') }), { fail: 'refused' })
  assert.deepEqual(inspected, ['https://blocked.example'])
})


test('native freshness prompt uses clock and normalized explicit window without changing request limits', async () => {
  const now = new Date('2026-11-20T12:00:00Z')
  const x = await simulate({ now, windowDays: 30, query: 'Workshops posting roles within the last 60 days',
    where: ['Dunedin, New Zealand'], industries: ['Repair'], signals: ['Hiring'] })
  const paid = x.messages.find(m => Array.isArray(m.body.tools))!
  const counted = x.messages.find(m => m.url.endsWith('/count_tokens') && String(m.body.messages).length > 0)!
  const text = (paid.body.messages as { content: string }[])[0].content
  assert.match(text, /Today is 2026-11-20/)
  assert.match(text, /last 30 days.*2026-10-21/)
  assert.match(text, /Dunedin, New Zealand/)
  assert.match(text, /not the date the page was published/)
  assert.doesNotMatch(text, /undated official posting/)
  assert.deepEqual(paid.body.messages, counted.body.messages)
  assert.equal(paid.body.max_tokens, 3000)
  assert.deepEqual(paid.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }])
  assert.deepEqual(x.sequence.filter(s => s.startsWith('native-')), ['native-count', 'native-send'])
})

test('native default freshness favors current events without asserting a date on an active official posting', async () => {
  const x = await simulate({ now: new Date('2026-11-20T12:00:00Z'), query: 'Local studios hiring',
    where: ['Porto, Portugal'], industries: ['Studios'] })
  const paid = x.messages.find(m => Array.isArray(m.body.tools))!
  const text = (paid.body.messages as { content: string }[])[0].content
  assert.match(text, /Today is 2026-11-20.*2025-11-20/)
  assert.match(text, /undated official posting.*still active.*do not infer a date/)
  assert.match(text, /Porto, Portugal/)
  assert.doesNotMatch(text, /last 30 days/)
})

test('native vacancy sourcing follows the requested event without keyword routing or changing paid request limits', async () => {
  const cases = [
    { query: 'Find employers hiring refrigeration technicians in Faro', where: ['Faro, Portugal'], signals: ['Hiring'], role: 'refrigeration technicians' },
    { query: 'Find employers seeking refrigeration technicians in Nelson', where: ['Nelson, New Zealand'], signals: [], role: 'seeking refrigeration technicians' },
    { query: 'Find workshops opening a new location and growing their market position in Porto', where: ['Porto, Portugal'], signals: ['Expansion'], role: 'market position' },
    { query: 'Find cold storage companies expanding in Dunedin, not hiring', where: ['Dunedin, New Zealand'], signals: ['Hiring'], role: 'not hiring' },
  ]
  for (const { role, ...fixture } of cases) {
    const x = await simulate({ ...fixture, industries: ['Cold storage'] })
    const paid = x.messages.find(m => Array.isArray(m.body.tools))!
    const counted = x.messages.find(m => m.url.endsWith('/count_tokens'))!
    const prompt = (paid.body.messages as { content: string }[])[0].content
    assert.match(prompt, /Only for a requested current job vacancy,.*individual vacancy permalink.*employer['’]s own careers site/)
    assert.match(prompt, /category lists.*discovery only/)
    assert.match(prompt, /For non-hiring events, .* do not substitute vacancies/)
    assert.match(prompt, /A new location or market position is not a job vacancy/)
    assert.match(prompt, /Do not treat hiring as requested when the explicit play excludes it, even if saved profile signals mention hiring/)
    assert.ok(prompt.includes(fixture.where[0]), fixture.query)
    assert.ok(prompt.includes(role), fixture.query)
    assert.deepEqual(paid.body.messages, counted.body.messages)
    assert.equal(paid.body.max_tokens, 3000)
    assert.deepEqual(paid.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }])
    assert.deepEqual(x.sequence.filter(s => s.startsWith('native-')), ['native-count', 'native-send'])
  }
})

test('#1457 (b): an optional angle needs room for its search plus the downstream reserve, so found leads can still be graded', async () => {
  // USD cap 0.84: the 0.69 search estimate alone would fit after the first wave, search + grading reserve does not.
  const r = await simulate({ ordinary: true, companyFirstTenant: 'workspace', windowDays: 45,
    confirmedOffer: 'Independent commercial document services', extractionFixture: true, cap: '1.26' })
  assert.equal(r.sequence.filter(x => x === 'native-send').length, 1)
  assert.ok(!(r.ledger as { status: string }[]).some(x => x.status === 'refused'))
  assert.equal(r.report.observed.verification, true)
  assert.match(JSON.stringify(r.report), /Regional Document Services/)
})
test('#1457 (c): a later angle whose over-estimate settle leaves no cap room fails as before instead of grading into a refusal', async () => {
  const r = await simulate({ ordinary: true, companyFirstTenant: 'workspace', windowDays: 45,
    confirmedOffer: 'Independent commercial document services', extractionFixture: true, secondWave: 'over', overTokens: 600_000, cap: '1.5' })
  assert.equal(r.sequence.filter(x => x === 'native-send').length, 2)
  assert.equal(r.end && (r.end as { error?: string }).error, 'native_search_estimate_exceeded', JSON.stringify(r.end))
})
