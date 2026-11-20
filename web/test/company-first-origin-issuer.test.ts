import assert from 'node:assert/strict'
import { test } from 'node:test'
import { issueCompanyFirstWebsite, type CanonicalOffice, type IndependentEntity, type OwnedIdentityBlock, type OriginIssuerPorts } from '../lib/company-first/company-first-origin-issuer.ts'

const scope = { tenant: 'local-fixture-tenant', job: 'job-0', attempt: 'attempt-0' }
const own = 'https://company.example', identity = own + '/identity', robots = own + '/robots.txt'
const hint = 'https://jobs.example/official/job/1'
const candidate = { name: 'Example Enterprise', hintUrl: hint }
const on = { enabled: true }
const id = { issuerKey: 'authority-key', jurisdictionKey: 'jurisdiction-key', legalId: 'ENT-030' }
const office: CanonicalOffice = {
  placeKey: 'locality-binding', countryKey: 'country-key', street: '31 Sample Avenue', locality: 'Fixture Locality',
  region: 'Fixture Region', postal: 'A1-1000', country: 'Fixture Country',
}
const visible = (includeId = true, addr = office) =>
  `<html><head><title>${candidate.name}</title></head><body><address data-owned-block>${candidate.name}; ${includeId ? id.legalId + '; ' : ''}${addr.street}; ${addr.locality}; ${addr.region}; ${addr.postal}; ${addr.country}</address></body></html>`
function fixture(overrides: Partial<OriginIssuerPorts> = {}, html = visible()) {
  const record: IndependentEntity = { scope, reviewVersion: 'revision-1', expiresAtMs: Date.now() + 50_000,
    companyKey: 'bound-entity-key', legalName: candidate.name, legalIdentity: id, recordAuthorityOrigin: 'https://registry.example',
    exactSourceRecordUrl: 'https://registry.example/entity/ENT-030', websiteField: own + '/', exactOwnedIdentityUrl: identity,
    exactLinkedHintUrl: hint, canonicalOffice: office,
  }
  const calls: string[] = []
  const ports: OriginIssuerPorts = {
    async readIndependentRecords(q) {
      calls.push('authority')
      assert.equal(q.exactHintUrl, hint)
      assert.deepEqual(q.scope,scope)
      return [record]
    },
    async authorizeAndReserve(r) { assert.equal(r.reviewVersion,'revision-1'); calls.push('reserve:' + r.exactUrl); return true },
    async read(url) { calls.push('read:' + url); assert.ok([robots,identity].includes(url)); return { status: url === robots ? 404 : 200, body: url === robots ? '' : html } },
    parsePage(html) { return {title: /<title>([^<>]+)<\/title>/i.exec(html)?.[1] ?? ''} },
    parseRobots() { return {allows:()=>true,delayMs:0} },
    readOwnedIdentityBlocks(body, url) {
      assert.equal(url,identity)
      const m = /<address data-owned-block>([^<>]+)<\/address>/.exec(body)
      if (!m) return []
      return [{ start:m.index, end:m.index+m[0].length, legalName:candidate.name,
        ...(m[1].includes(id.legalId) ? { legalIdentity:id } : {}), office }]
    },
    ...overrides,
  }
  return { record, calls, ports }
}

test('independent exact record followed by two reserved owned reads corroborates either printed ID or complete office', async()=>{
  for(const [html, place] of [[visible(),undefined],[visible(false),office.placeKey]] as const) {
    const f=fixture({},html)
    assert.deepEqual(await issueCompanyFirstWebsite(on,scope,candidate,place,f.ports), {
      state:'verified',site:{status:'verified',website:own,identitySource:identity,companyKey:'bound-entity-key',candidateName:candidate.name},
    })
    assert.deepEqual(f.calls,['authority','reserve:'+robots,'read:'+robots,'reserve:'+identity,'read:'+identity,'authority'])
  }
})

test('exact published legal ID proves identity without claiming an unverified place',async () => {
  const initial = fixture()
  const { canonicalOffice: _office, ...record } = initial.record
  const html = '<html><head><title>' + candidate.name + '</title></head><body><p>' + candidate.name + '; ' + id.legalId + '</p></body></html>'
  const f = fixture({
    async readIndependentRecords() { return [record] },
    readOwnedIdentityBlocks(body) {
      return [{ start: body.indexOf('<p>'), end: body.indexOf('</p>'), legalName: candidate.name, legalIdentity: id }]
    },
  },html)
  assert.equal((await issueCompanyFirstWebsite(on, scope, candidate, undefined, f.ports)).state, 'verified')
  assert.deepEqual(await issueCompanyFirstWebsite(on, scope, candidate, office.placeKey, f.ports), {state:'held',reason:'identity_unknown'})
})

test('no reservation or read without an independently attributable unique exact company and domain relation',async()=>{
  const {record}=fixture()
  for (const rows of [
    null,[],[record,record],[{...record,expiresAtMs:0}],[{...record,scope:{...scope,tenant:'different'}}],
    [{...record,scope:{...scope,attempt:'old'}}],[{...record,legalName:'Wrong Enterprise'}],
    [{...record,websiteField:'https://namesake.example/'}],[{...record, exactLinkedHintUrl:hint+'/other'}],
    [{...record, exactSourceRecordUrl:own+'/registry'}],[{...record,exactOwnedIdentityUrl:'https://mirror.company.example/identity'}],
  ]) {
    const f = fixture({async readIndependentRecords(){return rows}})
    assert.deepEqual(await issueCompanyFirstWebsite(on,scope,candidate,office.placeKey,f.ports),{state:'held',reason:'identity_unknown'})
    assert.deepEqual(f.calls,[])
  }
  const disabled=fixture()
  assert.deepEqual(await issueCompanyFirstWebsite({},scope,candidate,office.placeKey,disabled.ports),{state:'held',reason:'disabled'})
  assert.deepEqual(disabled.calls,[])
})

test('wrong locality or legal ID, indirect customer address, fake span and ambiguous blocks cannot corroborate',async()=>{
  const off={
    ...office, placeKey:'other-place',locality:'Other Place',
  }
  const b: OwnedIdentityBlock = {start:0,end:visible().length,legalName:candidate.name,legalIdentity:id,office}
  for (const [html, block] of [
    [visible(true,off),[{...b,end:visible(true,off).length,office:off}]],
    [visible(true),[{...b,legalIdentity:{...id,legalId:'ENT-999'}}]],
    [visible(true),[{...b,legalIdentity:{...id,jurisdictionKey:'unrelated'}}]],
    [visible(false),[{...b,end:visible(false).length,legalIdentity:id}]],
    [visible(),[{...b,end:20}]],
    [visible(),[b,b]],
    [visible().replace('data-owned-block','data-customer-block'),undefined],
  ] as const) {
    const f=fixture(block?{readOwnedIdentityBlocks:()=>block}:{},html)
    assert.deepEqual(await issueCompanyFirstWebsite(on,scope,candidate,office.placeKey,f.ports),{state:'held',reason:'identity_unknown'})
    assert.equal(f.calls.filter(x=>x==='authority').length,1)
  }
})

test('hostile redirect, wrong robots and reservation refusal never yield an issuer result',async()=>{
  for(const mode of ['affiliate_redirect','same_origin_redirect','robots_denial','refused'] as const) {
    let captures=0
    let dispatches=0
    const f=fixture({
      async authorizeAndReserve(req) {return mode!=='refused'||req.kind!=='identity'},
      async read(url) {
        dispatches++
        if(url===robots)return mode==='robots_denial'?{status:403,body:''}:{status:404,body:''}
        assert.equal(url,identity)
        return {status:302,body:'',location:mode==='affiliate_redirect'?'https://namesake.example/identity':own+'/different'}
      },
      readOwnedIdentityBlocks(){captures++;return []},
    })
    assert.equal((await issueCompanyFirstWebsite(on,scope,candidate,undefined,f.ports)).state,'held')
    assert.equal(captures,0)
    assert.equal(dispatches,mode==='refused'||mode==='robots_denial'?1:2)
  }
})

test('authority snapshots reject replaced and mutated records or hints even after valid guarded reads',async()=>{
  const {record}=fixture()
  const mutableCandidate={...candidate}
  for(const mode of ['stale','mutated_record','mutated_hint','abort'] as const) {
    mutableCandidate.hintUrl=hint
    const mutableId={...id}
    const mutableRecord={...record,legalIdentity:mutableId}
    let n=0
    const ac=new AbortController()
    const f=fixture({
      async readIndependentRecords(query) {
        assert.equal(query.exactHintUrl,hint)
        if(n++===0)return [mutableRecord]
        if(mode==='stale')return [{...mutableRecord,expiresAtMs:0}]
        if(mode==='mutated_record')mutableId.legalId='ENT-999'
        if(mode==='mutated_hint'){
          mutableCandidate.hintUrl=hint+'/other'
          return [{...mutableRecord,exactLinkedHintUrl:mutableCandidate.hintUrl}]
        }
        if(mode==='abort')ac.abort()
        return [mutableRecord]
      },
    })
    assert.deepEqual(await issueCompanyFirstWebsite({...on,signal:ac.signal},scope,mutableCandidate,office.placeKey,f.ports),{state:'held',reason:'superseded_or_expired'})
    assert.equal(n,2)
  }
})
