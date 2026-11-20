import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { companyFirstPublicReader, type PublicPageReadAuthority } from '../lib/company-first/company-first-public-reader.ts'
import { observedSafeGet, type ObservedSafeGet } from '../lib/sources/http.ts'
import { guardedLookup } from '../lib/scan/fetch-page.ts'

const scope={tenant:'test-tenant',job:'test-job',attempt:'1'}
const own='https://fixture.example', page=own+'/about', robots=own+'/robots.txt'
const schema=' { "@context":"https://schema.org", "@type":"Organization", "name":"Example Entity" } '
const html=`<!doctype html><html><head><title>Irrelevant title</title><script type="application/ld+json">${schema}</script>
<script>document.write('Hidden In Code')</script></head><body>
<main><h1>Example Entity</h1><p>Actual organization text.</p></main>
<div hidden>Hidden attribute</div><span aria-hidden="&#116;rue">Encoded aria trap</span><em style="display&#58;none">Encoded style trap</em>
<div class="hidd&#101;n">Encoded class trap</div><dialog>Dialog trap</dialog><details>Details trap</details>
<textarea></div>Raw textarea trap</textarea><iframe></div>Raw iframe trap</iframe>
<template><div>Hidden template</div><script type="application/ld+json">{"name":"Hidden schema"}</script></template>
<!-- <p>HTML comment trap</p> --><p>Next <span>isolated</span> token</p></body></html>`
const sig=()=>new AbortController().signal
function fixture(overrides:Partial<PublicPageReadAuthority>={},wire?:ObservedSafeGet) {
  const calls:string[]=[]
  const authority:PublicPageReadAuthority={
    async isCurrent(s){assert.deepEqual(s,scope);return true},
    async reserveCurrentRead({scope:s,step,exactUrl}){
      assert.deepEqual(s,scope);calls.push('reserve:'+step+':'+exactUrl);return true
    },
    ...overrides,
  }
  const transport:ObservedSafeGet=async (url,opts)=>{
    calls.push('read:'+url)
    assert.equal(opts?.userAgent,'dazl-contact-check/1.0 (+https://dazl.ai)')
    return wire?wire(url,opts):{status:url===robots?404:200,body:url===robots?'':html,
      complete:true,finalUrl:url,contentType:url===robots?'text/plain':'text/html; charset=UTF-8',contentEncoding:'identity'}
  }
  return {calls,reader:companyFirstPublicReader(scope,authority,transport)}
}

test('guarded observed HTML yields only literal JSON-LD and separated static visible text, not authority',async()=>{
  const f=fixture()
  const r=await f.reader.readPublicHtml(page,sig())
  assert.deepEqual(r,{url:page,finalUrl:page,contentType:'text/html',
    visibleText:'Example Entity | Actual organization text. | Next | isolated | token',jsonLd:[schema]})
  assert.deepEqual(f.calls,['reserve:robots:'+robots,'read:'+robots,'reserve:html:'+page,'read:'+page])
  assert.ok(r&&!('owner' in r)&&!('body' in r))
})

test('actual robots parser blocks policy, redirects, wrong MIME and delays without reading HTML',async()=>{
  for(const [status,body,contentType] of [
    [200,'User-agent: dazl-contact-check\nDisallow: /about\n','text/plain'],
    [200,'User-agent: dazl\nCrawl-delay: 1\n','text/plain'],
    [200,'not a robots file','text/html'],
    [200,'<!doctype html><html>not a robots file</html>','text/plain'],
    [403,'Denied','text/plain'],
    [302,'','text/plain'],
  ] as const){
    const f=fixture({},async url=>({status,body,finalUrl:url,complete:true,contentType,contentEncoding:'identity'}))
    assert.equal(await f.reader.readPublicHtml(page,sig()),null)
    assert.deepEqual(f.calls,['reserve:robots:'+robots,'read:'+robots])
  }
})

test('no body on wrong/missing MIME, incompleteness, redirect, compression, redirect-like HTML or limits',async()=>{
  for(const x of [
    {contentType:null},{contentType:'application/json'},{contentType:'text/html; charset=latin1'},
    {complete:false},{status:302},{finalUrl:own+'/different'},{location:own+'/another'},
    {contentEncoding:'gzip'},{truncated:true},{body:'x'.repeat(128_001)},
    {body:html.replace('<title>','<meta http-equiv="refresh"><title>')},
  ]){
    const f=fixture({},async url=>({status:url===robots?404:200,body:url===robots?'':html,finalUrl:url,
      complete:true,contentType:'text/html',contentEncoding:'identity',...(url===page?x:{})}))
    assert.equal(await f.reader.readPublicHtml(page,sig()),null)
    assert.equal(f.calls.filter(x=>x.startsWith('read:')).length,2)
  }
})

test('per-scope reserve/currentness, public URL policy and cap are fail closed',async()=>{
  const f=fixture()
  for(const url of ['http://fixture.example/about','https://127.0.0.1/about','https://[::1]/about',
    'https://user@fixture.example/about','https://fixture.internal/about',page+'?private=1',own+':444/about']){
    assert.equal(f.reader.allowPublicUrl(url),false)
    assert.equal(await f.reader.readPublicHtml(url,sig()),null)
  }
  assert.equal(f.calls.length,0)
  for(let i=0;i<8;i++)assert.ok(await f.reader.readPublicHtml(page,sig()))
  assert.equal(await f.reader.readPublicHtml(page,sig()),null)
  assert.equal(f.calls.filter(x=>x.startsWith('read:')).length,16)
  const denied=fixture({async reserveCurrentRead(){return false}})
  assert.equal(await denied.reader.readPublicHtml(page,sig()),null);assert.deepEqual(denied.calls,[])
  const stale=fixture({async isCurrent(){return false}})
  assert.equal(await stale.reader.readPublicHtml(page,sig()),null)
})

test('native observed getter uses actual headers, exact TLS URL, guarded lookup and whole bytes (mocked wire only)',async t=>{
  let called=0, mode:'normal'|'duplicate'|'bad_utf8'|'partial'='normal'
  t.mock.method(https,'request',((url:URL,opts:https.RequestOptions,callback:(res:EventEmitter)=>void)=>{
    called++
    assert.equal(url.href,page)
    assert.equal(opts.lookup,guardedLookup)
    assert.equal(opts.agent,false)
    assert.equal(opts.method,'GET')
    const req=new EventEmitter() as EventEmitter&{end():void;destroy():void}
    req.destroy=()=>{}
    req.end=()=>{
      const res=Object.assign(new EventEmitter(),{
        statusCode:200,headers:{},headersDistinct:{'content-type':mode==='duplicate'?['text/html','text/plain']:['text/html; charset=utf-8']},
        complete:mode!=='partial',destroy(){},resume(){},
      })
      callback(res)
      res.emit('data',mode==='bad_utf8'?Buffer.from([0xff]):Buffer.from(html))
      res.emit('end')
    }
    return req
  }) as typeof https.request)
  const r=await observedSafeGet(page,{accept:'text/html'})
  assert.deepEqual(r,{status:200,body:html,finalUrl:page,contentType:'text/html; charset=utf-8',contentEncoding:'identity',complete:true})
  mode='duplicate';assert.equal((await observedSafeGet(page))?.contentType,null)
  mode='partial';assert.equal((await observedSafeGet(page))?.complete,false)
  mode='bad_utf8';assert.equal(await observedSafeGet(page),null)
  assert.equal(await observedSafeGet('https://127.0.0.1/about'),null)
  assert.equal(called,4)
})
