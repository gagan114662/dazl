import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { guardedLookup } from '../lib/scan/fetch-page.ts'
import type { ObservedSafeGet } from '../lib/sources/http.ts'
import { issueCompanyFirstWebsite } from '../lib/company-first/company-first-origin-issuer.ts'
import { createOfficialEntityReader, type ReviewedOfficialRegistry, type ReviewedEntityBinding, type OfficialRegistryReadAuthority } from '../lib/company-first/company-first-official-entity.ts'

const scope={tenant:'fixture-tenant',job:'fixture-job',attempt:'1'}
const now=1_900_000_000_000
const expires=now+60_000
const place='canonical-place', country='canonical-country'
const official='https://registry.fixture.example', homepage='https://entity.fixture.example/', identity=homepage+'identity'
const exactRecordUrl=official+'/records/item-0001'
const registry:ReviewedOfficialRegistry={issuerKey:'registry-fixture',jurisdictionKey:'jurisdiction-fixture',reviewVersion:'approval-v1',expiresAtMs:expires,
  authorityOrigin:official,recordPathPrefix:'/records/',recordList:['entities'],activeState:'active',establishmentRole:'establishment',
  fields:{id:['id'],legalName:['name'],revision:['version'],state:['status'],validUntilMs:['validTo'],homepage:['website'],
    establishmentRole:['site','role'],officeCode:['site','placeCode'],countryCode:['site','countryCode'],
    street:['site','address','street'],locality:['site','address','locality'],region:['site','address','region'],postal:['site','address','zip'],country:['site','address','country']}}
const binding:ReviewedEntityBinding={scope,issuerKey:registry.issuerKey,jurisdictionKey:registry.jurisdictionKey,registryReviewVersion:registry.reviewVersion,
  expiresAtMs:expires,legalId:'legal-0001',legalName:'Fixture Entity',recordRevision:'revision-exact',exactRecordUrl,
  exactHomepage:homepage,exactOwnedIdentityUrl:identity,placeKey:place,countryKey:country,officialOfficeCode:'office-standard-code',officialCountryCode:'country-standard-code'}
const address={street:'First Road',locality:'Fixture City',region:'Fixture Region',zip:'AB-01',country:'Fixture Republic'}
const r={id:binding.legalId,name:binding.legalName,version:binding.recordRevision,status:registry.activeState,validTo:expires,
  website:homepage,site:{role:registry.establishmentRole,placeCode:binding.officialOfficeCode,countryCode:binding.officialCountryCode,address}}
const body=(records:unknown[]=[r])=>JSON.stringify({entities:records})
const response=(s=body(),override:Record<string,unknown>={})=>({
  status:200,complete:true,finalUrl:exactRecordUrl,contentType:'application/json; charset=UTF-8',contentEncoding:'identity',body:s,...override})
const query={scope,candidateName:binding.legalName,hintedOrigin:new URL(homepage).origin,exactHintUrl:homepage+'opening',requiredPlaceKey:place}
const signal=()=>new AbortController().signal
function fixtures(opt:Partial<OfficialRegistryReadAuthority>={},read?:ObservedSafeGet,clock=()=>now){
  const events:string[]=[]
  const authority:OfficialRegistryReadAuthority={
    async isCurrent(s){assert.deepEqual(s,scope);events.push('current');return true},
    async reserveCurrentRegistryRead(x){assert.deepEqual(x.scope,scope);assert.equal(x.exactUrl,exactRecordUrl);events.push('reserve');return true},
    ...opt}
  const transport:ObservedSafeGet=async (u,o)=>{
    events.push('physical');assert.equal(u,exactRecordUrl);assert.equal(o?.accept,'application/json')
    return read?read(u,o):response()
  }
  return {authority,transport,events,make:(cfg:ReviewedOfficialRegistry|null=registry,b:ReviewedEntityBinding|null=binding)=>createOfficialEntityReader(cfg,b,authority,transport,clock)}
}

test('actual branded registry read closure reuses only exact scope, stable ID, official homepage and explicit place',async()=>{
  const f=fixtures()
  const read=f.make()
  assert.equal(await read({...query,scope:{...scope,attempt:'2'}},signal()),null)
  assert.equal(await read({...query,requiredPlaceKey:'nearby-other'},signal()),null)
  assert.equal(await read({...query,exactHintUrl:'https://elsewhere.example/'},signal()),null)
  assert.deepEqual(f.events,[])
  const [entity]=await read(query,signal())??[]
  assert.ok(entity)
  assert.equal(entity.websiteField,homepage)
  assert.equal(entity.exactSourceRecordUrl,exactRecordUrl)
  assert.equal(entity.canonicalOffice?.placeKey,place)
  assert.equal(entity.canonicalOffice?.countryKey,country)
  assert.equal(entity.legalIdentity.legalId,binding.legalId)
  assert.deepEqual(await read(query,signal()),[entity])
  assert.equal(await read(query,signal()),null)
  assert.deepEqual(f.events,['current','reserve','physical','current','current','reserve','physical','current'])
})

test('no configuration, revoked scope, and unapproved/fallback place issue no transport request',async()=>{
  for(const args of [[null,binding],[registry,null],[
    {...registry,reviewVersion:'new-revision'},binding],[
    registry,{...binding,exactRecordUrl:'https://mirror.fixture.example/records/item-0001'}],[
    registry,{...binding,expiresAtMs:now}],[
    registry,{...binding,placeKey:''}]] as const){
    const f=fixtures()
    assert.equal(await f.make(args[0],args[1])(query,signal()),null)
    assert.deepEqual(f.events,[])
  }
  const revoked=fixtures({async isCurrent(){return false}})
  assert.equal(await revoked.make()(query,signal()),null)
  assert.deepEqual(revoked.events,[])
  const noReserve=fixtures({async reserveCurrentRegistryRead(){return false}})
  assert.equal(await noReserve.make()(query,signal()),null)
  assert.deepEqual(noReserve.events,['current'])
  let checks=0
  const revokedAfter=fixtures({async isCurrent(){return ++checks===1}})
  assert.equal(await revokedAfter.make()(query,signal()),null)
  assert.deepEqual(revokedAfter.events,['reserve','physical'])
})

test('duplicate/escaped JSON keys, reassignment, expiration, missing place and record ambiguity fail closed',async()=>{
  const raws=[
    body([r,r]),
    body().replace('"id":"legal-0001"', '"id":"wrong","i\\u0064":"legal-0001"'),
    body([{...r,id:'wrong'}]), body([{...r,version:'reassigned'}]), body([{...r,validTo:now}]),
    body([{...r,website:'https://other.fixture.example/'}]), body([{...r,status:'closed'}]),
    body([{...r,site:undefined}]), body([{...r,site:{...r.site,placeCode:'different-place'}}]),
    body([{...r,site:{...r.site,countryCode:'different-country'}}]),body([{...r,site:{...r.site,role:'registered-agent-only'}}]),
    body([{...r,site:{...r.site,address:{...address,zip:undefined}}}]),
    '{"entities":[{"@type":"Organization","name":"Fixture Entity","url":"https://entity.fixture.example/"}]}',
    '{"entities":[' + '['.repeat(18) + '0' + ']'.repeat(18) + ']}',
  ]
  for(const raw of raws){
    const f=fixtures({},async()=>response(raw))
    assert.equal(await f.make()(query,signal()),null)
    assert.equal(f.events.filter(x=>x==='physical').length,1)
  }
})

test('same exact HTTPS guarded wire, no redirect, no encoding or duplicate MIME, bad UTF-8 and oversized held',async t=>{
  let wire='ok',calls=0
  t.mock.method(https,'request',((url:URL,opts:https.RequestOptions,cb:(res:EventEmitter)=>void)=>{
    calls++
    assert.equal(url.href,exactRecordUrl)
    assert.equal(opts.lookup,guardedLookup)
    assert.equal(opts.agent,false)
    assert.equal(opts.method,'GET')
    assert.equal((opts.headers as Record<string,string>).accept,'application/json')
    assert.ok(!Object.hasOwn(opts.headers??{},'authorization'))
    assert.ok(!Object.hasOwn(opts.headers??{},'cookie'))
    const req=new EventEmitter() as EventEmitter&{end():void;destroy():void}
    req.destroy=()=>{}
    req.end=()=>{
      const res=Object.assign(new EventEmitter(),{statusCode:wire==='redirect'?302:200,
        headers:wire==='redirect'?{location:'https://other.fixture.example/'}:{},
        headersDistinct:{'content-type':wire==='duplicate'?['application/json','text/html']:['application/json'],
        ...(wire==='gzip'?{'content-encoding':['gzip']}:{})},
        complete:wire!=='partial',destroy(){},resume(){}})
      cb(res)
      res.emit('data',wire==='utf8'?Buffer.from([0xff]):Buffer.from(wire==='big'?'q'.repeat(64_001):body()))
      res.emit('end')
    }
    return req
  }) as typeof https.request)
  for(const mode of ['ok','redirect','duplicate','gzip','utf8','partial','big']){
    wire=mode
    const f=fixtures()
    const get=createOfficialEntityReader(registry,binding,f.authority,undefined,()=>now)
    assert.equal(Boolean(await get(query,signal())),mode==='ok',mode)
  }
  assert.equal(calls,7)
})

test('origin issuer consumes exact registry receipt and second fresh read; changed record remains held',async()=>{
  for(const drift of [false,true]){
    let n=0
    const f=fixtures({},async()=>response(++n===2&&drift?body([{...r,version:'rotated'}]):body()))
    const literal='Fixture Entity legal-0001 First Road Fixture City Fixture Region AB-01 Fixture Republic'
    const owned='<html><head><title>Fixture Entity</title></head><body><p>'+literal+'</p></body></html>'
    const result=await issueCompanyFirstWebsite({enabled:true},scope,{name:binding.legalName,hintUrl:query.exactHintUrl},place,{
      readIndependentRecords:f.make(),
      readOwnedIdentityBlocks(text){return [{start:text.indexOf(literal),end:text.indexOf(literal)+literal.length,legalName:binding.legalName,
        legalIdentity:{issuerKey:binding.issuerKey,jurisdictionKey:binding.jurisdictionKey,legalId:binding.legalId},
        office:{placeKey:place,countryKey:country,...address,postal:address.zip}}]},
      authorizeAndReserve:async()=>true,
      read:async u=>u.endsWith('/robots.txt')?{status:404,body:''}:{status:200,body:owned},
      parseRobots:()=>({allows:()=>true,delayMs:0}),parsePage:()=>({title:binding.legalName}),
    })
    assert.equal(result.state,drift?'held':'verified')
    assert.equal(n,2)
  }
})
