import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { guardedLookup } from '../lib/scan/fetch-page.ts'
import type { ObservedSafeGet } from '../lib/sources/http.ts'
import { createPublicRdapRegistrantReader as create, isPublicRdapRegistrantFor as witnessed,
  type RdapBinding, type ReviewedRdapPrefix, type PublicRdapAuthority } from '../lib/company-first/company-first-public-rdap.ts'

const scope={tenant:'fixture-tenant',job:'fixture-job',attempt:'1'}
const bootstrap='https://data.iana.org/rdap/dns.json'
const prefix='https://registry.example.net/rdap/'
const host='fixture-official.co.uk'
const record=prefix+'domain/'+host
const now=1_900_000_000_000, cutoff=now+600_000
const cfg:ReviewedRdapPrefix={ exactBaseUrl:prefix,reviewVersion:'reviewed-fixture',expiresAtMs:cutoff,
  directPublicRegistrant:{field:'test_fixture_direct_registration',equals:true}}
const b:RdapBinding={scope,registrableDomain:host,expectedOrganization:'Fixture Organization',reviewVersion:cfg.reviewVersion,expiresAtMs:cutoff}
const map=(services:unknown[][]=[[['uk'],['https://earlier.example.net/rdap/']],[['co.uk'],[prefix]]])=>JSON.stringify({
  publication:new Date(now-86400_000).toISOString(),version:'1.0',services})
const entity={objectClassName:'entity',roles:['registrant'],test_fixture_direct_registration:true,
  vcardArray:['vcard',[
    ['version',{},'text','4.0'],['kind',{},'text','org'],['org',{},'text',b.expectedOrganization],
    ['fn',{},'text','Do Not Output'],['email',{},'text','do-not-output@example.invalid'],
    ['adr',{type:'work'},'text',['','','fixture address','fixture city','fixture state','fixture postal','fixture country']],
  ]]}
const domain={objectClassName:'domain',ldhName:host,rdapConformance:['rdap_level_0'],status:['active'],
  events:[{eventAction:'expiration',eventDate:new Date(now+10_000_000).toISOString()}],
  entities:[{objectClassName:'entity',roles:['registrar']},entity]}
const res=(u:string,raw= u===bootstrap?map():JSON.stringify(domain),extra:Record<string,unknown>={})=>({
  status:200,complete:true,finalUrl:u,contentEncoding:'identity',contentType:u===bootstrap?'application/json':'application/rdap+json',body:raw,...extra})
const signal=()=>new AbortController().signal
function fixture(fn?:ObservedSafeGet, opt:Partial<PublicRdapAuthority>={}){
  const calls:string[]=[]
  const authority:PublicRdapAuthority={
    async isCurrent(s){assert.deepEqual(s,scope);return true},
    async reserveCurrentRead(x){assert.deepEqual(x.scope,scope);calls.push('reserve:'+x.step+':'+x.exactUrl);return true},
    async suspendOrigin(x){calls.push('suspend:'+x.origin)},
    ...opt,
  }
  const wire:ObservedSafeGet=async(u,o)=>{calls.push('get:'+u);return fn?fn(u,o):res(u)}
  return {calls,authority,get:(settings:ReviewedRdapPrefix|null=cfg,binding:RdapBinding|null=b,clock=()=>now)=>create(settings,binding,authority,wire,clock)}
}

test('selects exact longest IANA bootstrap prefix; output is live-proof branded public org only',async()=>{
  const f=fixture(),get=f.get()
  const v=await get(signal())
  assert.deepEqual(v,{kind:'public_rdap_registrant_org',scope,registrableDomain:host,organization:b.expectedOrganization,
    exactSourceUrl:record,registryBaseUrl:prefix,reviewVersion:cfg.reviewVersion,checkedAtMs:now,expiresAtMs:now+120_000})
  assert.ok(witnessed(v,scope,host,now))
  assert.ok(!witnessed(v,{...scope,attempt:'2'},host,now))
  assert.ok(!witnessed(v,scope,host,now+120_000))
  assert.ok(v&&!witnessed({...v},scope,host,now))
  assert.equal(await get(signal()),null)
  assert.deepEqual(f.calls,['reserve:bootstrap:'+bootstrap,'get:'+bootstrap,'reserve:rdap:'+record,'get:'+record])
  assert.ok(!/Do Not Output|email|address/i.test(JSON.stringify(v)))
})

test('unsupported, stale, private suffix, IP/subdomain, aliases and ambiguity do not dispatch RDAP',async()=>{
  for(const setting of [null,{...cfg,expiresAtMs:now},{...cfg,exactBaseUrl:'http://registry.example.net/rdap/'},cfg]){
    const f=fixture()
    for(const hostname of ['127.0.0.1','com','sub.'+host,host.toUpperCase(),'shared.github.io','host.invalid',host+'.']){
      assert.equal(await f.get(setting,{...b,registrableDomain:hostname})(signal()),null)
    }
    assert.equal(f.calls.length,0)
  }
  for(const advertised of [
    map([[['uk'],[prefix]],[['co.uk'],['https://not-reviewed.example.net/rdap/']]]),
    map([[['co.uk'],[prefix]],[['co.uk'],[prefix]]]),
    map([[['co.uk'],[prefix+'alias/']]]),
    map([[['co.uk'],['http://registry.example.net/rdap/']]]),
    map([[['co.uk'],[prefix,prefix]]]),
  ]){
    const f=fixture(async u=>res(u,advertised))
    assert.equal(await f.get()(signal()),null)
    assert.deepEqual(f.calls,['reserve:bootstrap:'+bootstrap,'get:'+bootstrap])
  }
})

test('rejects wrong/expired, duplicate/malformed/redacted, proxy-flagged, private or non-organization records',async()=>{
  const withEntity=(x:unknown)=>({...domain,entities:[x]})
  const invalid=[
    {...domain,ldhName:'wrong.co.uk'}, {...domain,objectClassName:'entity'},
    {...domain,status:['pending transfer']}, {...domain,redacted:[{name:'Registrant Organization'}]},
    {...domain,events:[{eventAction:'expiration',eventDate:new Date(now-1).toISOString()}]},
    {...domain,entities:[entity,entity]}, {...domain,entities:[entity,{objectClassName:'entity',roles:['proxy']}]},
    withEntity({...entity,roles:['registrar']}),withEntity({...entity,roles:['registrant','reseller']}),
    withEntity({...entity,roles:['registrant','administrative']}),
    withEntity({...entity,test_fixture_direct_registration:false}),
    withEntity({...entity,remarks:[{title:'Privacy service'}]}),
    withEntity({...entity,redacted:[{name:'registrant'}]}),
    withEntity({...entity,vcardArray:['vcard',[['kind',{},'text','individual'],['org',{},'text',b.expectedOrganization]]]}),
    withEntity({...entity,vcardArray:['vcard',[['kind',{},'text','org'],['fn',{},'text',b.expectedOrganization]]]}),
    withEntity({...entity,vcardArray:['vcard',[['kind',{},'text','org'],['org',{},'text','Privacy Proxy']]]}),
  ]
  const raws=[...invalid.map(x=>JSON.stringify(x)),JSON.stringify(domain).replace('"ldhName":"'+host+'"','"ldhName":"other.co.uk","ldh\\u004eame":"'+host+'"')]
  for(const bad of raws){
    const f=fixture(async u=>u===bootstrap?res(u):res(u,bad))
    assert.equal(await f.get()(signal()),null)
    assert.equal(f.calls.length,4)
  }
})

test('quota suspension is durable port call only; authorization refusal and no fallback or retry',async()=>{
  for(const step of [bootstrap,record]){
    const f=fixture(async u=>u===step?res(u,'',{status:429}):res(u)),get=f.get()
    assert.equal(await get(signal()),null);assert.equal(await get(signal()),null)
    assert.equal(f.calls.filter(x=>x.startsWith('get:')).length,step===bootstrap?1:2)
    assert.equal(f.calls.at(-1),'suspend:'+new URL(step).origin)
  }
  const denied=fixture(undefined,{async reserveCurrentRead(){return false}})
  assert.equal(await denied.get()(signal()),null)
  assert.deepEqual(denied.calls,[])
})

test('actual observed HTTPS uses pinned exact URL and guarded wire; redirects, MIME, incomplete and bad UTF-8 hold',async t=>{
  let variant='ok', physical=0
  t.mock.method(https,'request',((url:URL,opts:https.RequestOptions,cb:(res:EventEmitter)=>void)=>{
    physical++
    assert.ok(url.href===bootstrap||url.href===record)
    assert.equal(opts.lookup,guardedLookup);assert.equal(opts.agent,false);assert.equal(opts.method,'GET')
    assert.ok(!Object.hasOwn(opts.headers??{},'authorization'));assert.ok(!Object.hasOwn(opts.headers??{},'cookie'))
    const boot=url.href===bootstrap
    const mime=boot?'application/json':'application/rdap+json; charset=utf-8'
    assert.equal((opts.headers as Record<string,string>).accept,boot?'application/json':'application/rdap+json')
    const req=new EventEmitter() as EventEmitter&{end():void;destroy():void}
    req.destroy=()=>{}
    req.end=()=>{
      const mode=boot?'ok':variant
      const r=Object.assign(new EventEmitter(),{statusCode:mode==='redirect'?302:200,
        headers:mode==='redirect'?{location:'https://unreviewed.example.net/domain/else'}:{},
        headersDistinct:{'content-type':mode==='mime'?['application/json','text/html']:[mime],
          ...(mode==='encoding'?{'content-encoding':['gzip']}:{})},
        complete:mode!=='partial',destroy(){},resume(){}})
      cb(r)
      r.emit('data',mode==='utf8'?Buffer.from([0xff]):Buffer.from(mode==='oversize'?'x'.repeat(128_001):boot?map():JSON.stringify(domain)))
      r.emit('end')
    }
    return req
  }) as typeof https.request)
  for(const mode of ['ok','redirect','mime','encoding','partial','utf8','oversize']){
    variant=mode
    const f=fixture()
    assert.equal(Boolean(await create(cfg,b,f.authority,undefined,()=>now)(signal())),mode==='ok',mode)
  }
  assert.equal(physical,14)
})
