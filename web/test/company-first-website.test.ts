import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyCompanyWebsite, type WebsitePorts } from '../lib/company-first/company-first-website-proof.ts'

const scope = {tenant:'private-tenant',job:'private-job',attempt:'private-attempt'}
const candidate = {name:'Sample Engineering',hintUrl:'https://sample.example/untrusted/citation?secret=omit'}
const origin = 'https://sample.example'
const identity = origin + '/about/company'
const robots = origin + '/robots.txt'
const on = { enabled: true }
type Review = NonNullable<Awaited<ReturnType<WebsitePorts['readIndependentOrigin']>>>
const body = (title = candidate.name) => '<html><head><title>' + title + '</title></head><body>Example</body></html>'
function fake(overrides: Partial<WebsitePorts> = {}, page = body()) {
  const review: Review = {scope,version:'v1',expiresAtMs:Date.now()+60_000,basis:'independent_official_origin',candidateName:candidate.name,companyKey:'sample-entity-id',origin,identityUrl:identity}
  const trace: unknown[] = []
  const ports: WebsitePorts = {
    async readIndependentOrigin(query) { trace.push(['review',query]); return review },
    async authorizeAndReserve({scope,reviewVersion,kind}) { trace.push(['reserve',scope,reviewVersion,kind]); return true },
    async read(url, opts) { trace.push(['read',url,opts?.headers]); return {status:url===robots ? 404 : 200,body:url===robots ? '' : page} },
    parseRobots() { return {allows: () => true, delayMs:0} },
    parsePage(html) { return {title: /<title>([^<>]+)<\/title>/i.exec(html)?.[1] ?? ''} },
    ...overrides,
  }
  return {ports,trace,review}
}

test('only independently reviewed path is read; same-name live title and current authority produce exact site evidence',async () => {
  const {ports,trace} = fake()
  const r = await verifyCompanyWebsite(on,scope,candidate,ports)
  assert.deepEqual(r,{state:'verified',site:{status:'verified',companyKey:'sample-entity-id',candidateName:candidate.name,website:origin,identitySource:identity}})
  const queried={scope,candidateName:candidate.name,hintedOrigin:origin,exactHintUrl:candidate.hintUrl}
  assert.deepEqual(trace,[
    ['review',queried],['reserve',scope,'v1','robots'],['read',robots,{'user-agent':'dazl-contact-check/1.0 (+https://dazl.ai)'}],
    ['reserve',scope,'v1','identity'],['read',identity,{'user-agent':'dazl-contact-check/1.0 (+https://dazl.ai)'}],['review',queried],
  ])
  assert.ok(!JSON.stringify(trace.filter(x=>Array.isArray(x)&&x[0]==='read')).includes('private'))
})

test('missing authority, false same name under other domain, stale attempt, no hint and disabled never dispatch',async()=>{
  const base=fake()
  assert.deepEqual(await verifyCompanyWebsite({},scope,candidate,base.ports),{state:'held',reason:'disabled'})
  assert.deepEqual(await verifyCompanyWebsite(on,scope,{name:candidate.name},base.ports),{state:'held',reason:'identity_unknown'})
  assert.deepEqual(base.trace,[])
  const denied=[
    null, {...base.review, scope:{...scope,attempt:'stale'}},
    {...base.review, scope:{...scope,tenant:'other'}},
    {...base.review, expiresAtMs:0}, {...base.review, candidateName:'Different company'},
    {...base.review, origin:'https://same-name.example',identityUrl:'https://same-name.example/about'},
    {...base.review, identityUrl: 'https://sample.example.evil.example/about'},
    {...base.review, identityUrl: identity+'?tracked=1'},
  ]
  for (const receipt of denied) {
    const x=fake({async readIndependentOrigin(){return receipt}})
    assert.deepEqual(await verifyCompanyWebsite(on,scope,candidate,x.ports),{state:'held',reason:'identity_unknown'})
    assert.deepEqual(x.trace,[])
  }
  assert.deepEqual(await verifyCompanyWebsite(on,scope,{...candidate,hintUrl:'https://same-name.example/about'},base.ports),{state:'held',reason:'identity_unknown'})
  assert.ok(!base.trace.some(x=>Array.isArray(x)&&x[0]==='read'))
})

test('guarded robots and exact path: no redirect follow, denied/truncated/invalid read and no same-origin retry',async()=>{
  for(const mode of ['robots_block','robots_delay','robots_redirect','identity_redirect','identity_same_origin_redirect','truncated','quota']) {
    const calls:string[]=[]
    const details=fake({
      async read(url){calls.push(url)
        if(url===robots) return mode==='robots_redirect'?{status:302,body:'',location:'https://other.example/robots.txt'}:{status:200,body:'User-agent: *'}
        if(mode==='identity_redirect')return {status:302,body:'',location:'https://same-name.example/about'}
        if(mode==='identity_same_origin_redirect')return {status:302,body:'',location:origin+'/elsewhere'}
        return {status:200,body:mode==='quota'?'x'.repeat(128001):body(),truncated:mode==='truncated'}
      },
      parseRobots(){return {allows:path=>path==='/about/company'&&mode!=='robots_block',delayMs:mode==='robots_delay'?1000:0}},
    })
    assert.deepEqual(await verifyCompanyWebsite(on,scope,candidate,details.ports),{state:'held',reason:'identity_unknown'},mode)
    assert.deepEqual(calls,mode.startsWith('robots')?[robots]:[robots,identity],mode)
  }
})

test('wrong, substring, hidden, body-only, ambiguous and branded titles are not proof',async()=>{
  const pages=[
    '<html><head><meta content="<title>'+candidate.name+'</title>"></head></html>',
    body('Other company'),body(candidate.name+' Worldwide'),body(candidate.name+' | Home'),
    '<html><head><!-- <title>'+candidate.name+'</title> --><title>Other company</title></head></html>',
    '<html><head><script>const spoof = "<title>'+candidate.name+'</title>"</script><title>Other</title></head></html>',
    '<html><head></head><title>'+candidate.name+'</title></html>',
    '<html><head><title>'+candidate.name+'</title><title>Other company</title></head></html>',
  ]
  for (const page of pages) assert.deepEqual(await verifyCompanyWebsite(on,scope,candidate,fake({},page).ports),{state:'held',reason:'identity_unknown'})
})

test('per-read reservation, expiry/supersession and active abort never advance',async()=>{
  const denied=fake({async authorizeAndReserve(req){return req.kind==='robots'}})
  assert.deepEqual(await verifyCompanyWebsite(on,scope,candidate,denied.ports),{state:'held',reason:'reservation_unavailable'})
  assert.equal(denied.trace.filter(x=>Array.isArray(x)&&x[0]==='read').length,1)
  const initial=fake().review
  let checks=0
  const superseded=fake({async readIndependentOrigin(){return checks++===0?initial:{...initial,version:'v2'}}})
  assert.deepEqual(await verifyCompanyWebsite(on,scope,candidate,superseded.ports),{state:'held',reason:'superseded_or_expired'})
  const controller=new AbortController()
  const aborted=fake({async authorizeAndReserve(){controller.abort();return true}})
  assert.deepEqual(await verifyCompanyWebsite({...on,signal:controller.signal},scope,candidate,aborted.ports),{state:'held',reason:'superseded_or_expired'})
  assert.ok(!aborted.trace.some(x=>Array.isArray(x)&&x[0]==='read'))
})

test('independently bound exact public job hint can point to a different reviewed owned site; the hint is never read', async () => {
  const publicHint = 'https://job-boards.greenhouse.io/example/jobs/101?source=public'
  const x = fake()
  const reviewed: Review = {
    ...x.review, hintBinding: { kind: 'independently_reviewed_exact_hint', exactHintUrl: publicHint, companyKey: x.review.companyKey },
  }
  const proof = fake({async readIndependentOrigin(q) {
    assert.equal(q.exactHintUrl, publicHint)
    assert.equal(q.hintedOrigin, 'https://job-boards.greenhouse.io')
    return reviewed
  }})
  assert.equal((await verifyCompanyWebsite(on,scope,{...candidate,hintUrl:publicHint},proof.ports)).state,'verified')
  assert.deepEqual(proof.trace.flatMap(x=>Array.isArray(x)&&x[0]==='read'?[x[1]]:[]),[robots,identity])
  assert.ok(!JSON.stringify(proof.trace).includes(publicHint))
  for (const receipt of [
    x.review, {...reviewed, hintBinding:{...reviewed.hintBinding!,exactHintUrl:publicHint.replace('/101','/102')}},
    {...reviewed, hintBinding:{...reviewed.hintBinding!,exactHintUrl:publicHint.split('?')[0]}},
    {...reviewed, hintBinding:{...reviewed.hintBinding!,companyKey:'other-company'}},
    {...reviewed, scope:{...scope,job:'copied-old-job'}},
  ]) {
    const denied=fake({async readIndependentOrigin(){return receipt}})
    assert.deepEqual(await verifyCompanyWebsite(on,scope,{...candidate,hintUrl:publicHint},denied.ports),{state:'held',reason:'identity_unknown'})
    assert.deepEqual(denied.trace,[])
  }
})

test('mutable caller candidate cannot replace the original cross-origin hint during review',async()=>{
  const original='https://job-boards.greenhouse.io/example/jobs/101'
  const copied='https://job-boards.greenhouse.io/example/jobs/202'
  const changing={...candidate,hintUrl:original}
  const x=fake()
  const denied=fake({async readIndependentOrigin(q) {
    assert.equal(q.exactHintUrl,original)
    changing.hintUrl=copied
    return {...x.review,hintBinding:{kind:'independently_reviewed_exact_hint',exactHintUrl:copied,companyKey:x.review.companyKey}}
  }})
  assert.deepEqual(await verifyCompanyWebsite(on,scope,changing,denied.ports),{state:'held',reason:'identity_unknown'})
  assert.deepEqual(denied.trace,[])
})
