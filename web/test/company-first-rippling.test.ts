import test from 'node:test'
import assert from 'node:assert/strict'
import { companyFirstPublicReader } from '../lib/company-first/company-first-public-reader.ts'
import { discoverOwnedRipplingPostings } from '../lib/company-first/company-first-rippling.ts'
import { runCompanyFirst } from '../lib/company-first/company-first-evidence.ts'
import { atsPostingRef } from '../lib/sources/ats-posting.ts'
import type { ObservedSafeGet } from '../lib/sources/http.ts'

const scope={tenant:'example-tenant',job:'example-job',attempt:'1'}
const site='https://company.example/',owned=site+'about'
const board='https://ats.rippling.com/example-employer/jobs'
const id='3cb7e12a-2041-44e4-bb84-58ae20737053'
const path='/example-employer/jobs/'+id, post=board+'/'+id
const foreign='https://ats.rippling.com/foreign-employer/jobs/'+id
const person='Sample Legal Organization'
const candidate={name:person,hintUrl:owned}
const verified={status:'verified' as const,candidateName:person,companyKey:'verified-company',website:new URL(site).origin,identitySource:owned}
const urlAnchor=(href:string,label='Explore open roles')=>`<a href="${href}">${label}</a>`
const html=(body:string,head='')=>`<!doctype html><html><head>${head}</head><body><h1>Verified fixture content</h1>${body}</body></html>`
const signal=()=>new AbortController().signal
const listing=html(urlAnchor(path,'Sample position in one region')+urlAnchor(foreign,'Foreign job')+
  urlAnchor(post+'?tracker=id','Tracking URL')+urlAnchor('https://outside.example/jobs/'+id,'Nonpublisher'))
const job=html('<h2>Sample position in one region</h2><p>'+person+' is seeking qualified applicants for this role.</p><p>Remote eligible in fixture area.</p>')
function fixture(o:{owned?:string; listing?:string; job?:string; override?:ObservedSafeGet; disabled?:boolean}={}){
  const requests:string[]=[]
  const reader=companyFirstPublicReader(scope,{
    async isCurrent(s){assert.deepEqual(s,scope);return true},
    async reserveCurrentRead({scope:s,exactUrl,step}){assert.deepEqual(s,scope);requests.push('reserve:'+step+':'+exactUrl);return !o.disabled},
  },async(u,p)=>{
    requests.push('read:'+u)
    if(o.override)return o.override(u,p)
    const robot=u.endsWith('/robots.txt')
    const raw=robot?'':u===owned?o.owned??html(urlAnchor(board)):u===board?o.listing??listing:u===post?o.job??job:null
    return raw!==null?{body:raw,status:robot?404:200,complete:true,finalUrl:u,contentEncoding:'identity',contentType:robot?'text/plain':'text/html'}:null
  })
  return {reader,requests,discover:()=>discoverOwnedRipplingPostings(scope,candidate,verified,reader.readCareerHtml,signal())}
}

test('verified owned literal anchor -> exact Rippling board -> literal same-slug exact posting, no date or geography grant',async()=>{
  const f=fixture()
  const hints=await f.discover()
  assert.equal(atsPostingRef(post),null,'existing posted-date/legacy contract unchanged')
  assert.equal(hints.length,1)
  assert.deepEqual(hints[0],{
    kind:'owned_rippling_posting_hypothesis',scope,companyKey:verified.companyKey,websiteOrigin:verified.website,
    exactOwnedLinkSource:owned,exactBoardUrl:board,exactPostingUrl:post,literalBoardHref:board,literalPostingHref:path,linkedLabel:'Sample position in one region',
  })
  const pageReads=f.requests.filter(u=>u.startsWith('read:')&&!u.endsWith('/robots.txt'))
  assert.deepEqual(pageReads,['read:'+owned,'read:'+board,'read:'+post])
  assert.ok(!('date' in hints[0])&&!('place' in hints[0])&&!('quote' in hints[0]))
})

test('hidden, script, comments, empty anchors, entity-encoded aliases and HTML base cannot mint link',async()=>{
  for(const what of [
    html('<section hidden>'+urlAnchor(board)+'</section>'),
    html('<section aria-hidden=true>'+urlAnchor(board)+'</section>'),
    html('<section style="color:red">'+urlAnchor(board)+'</section>'),
    html('<script>document.write('+JSON.stringify(urlAnchor(board))+')</script>'),
    html('<!--'+urlAnchor(board)+'-->'), html(urlAnchor(board,' ')),
    html(urlAnchor(board.replace('https:', 'https&#58;'))),
    html(urlAnchor(board),'<base href=\"https://outside.example/\">'),
    html(urlAnchor(board)+urlAnchor(board.replace('example-employer','other'))),
    html(urlAnchor(board.replace('https://','//'))), html(urlAnchor(board.replace('rippling.com','rippling.com.invalid'))),
  ]){
    const f=fixture({owned:what})
    assert.deepEqual(await f.discover(),[])
    assert.deepEqual(f.requests.filter(u=>u.startsWith('read:')&&!u.endsWith('/robots.txt')),['read:'+owned])
  }
})

test('wrong role publisher tenant, redirected board, missing named employer, closed and blocked pages are never accepted',async()=>{
  const foreignOnly=fixture({listing:html(urlAnchor(foreign))})
  assert.deepEqual(await foreignOnly.discover(),[])
  assert.ok(!foreignOnly.requests.some(x=>x.includes(foreign)))
  for(const raw of [
    html('<p>Unknown employer, ordinary static layout.</p>'),
    html('<p>'+person+' — this position was filled.</p>'),
  ]){
    assert.deepEqual(await fixture({job:raw}).discover(),[])
  }
  const redirect=fixture({override:async u=>({
    body:u===owned?html(urlAnchor(board)):'',status:u.endsWith('/robots.txt')?404:u===board?302:200,
    finalUrl:u,complete:true,contentEncoding:'identity',contentType:u.endsWith('/robots.txt')?'text/plain':'text/html',
    ...(u===board?{location:'https://outside.example/'}:{}),
  })})
  assert.deepEqual(await redirect.discover(),[])
  assert.ok(!redirect.requests.some(x=>x.includes('outside.example')))
  const disabled=fixture({disabled:true})
  assert.deepEqual(await disabled.discover(),[])
  assert.ok(!disabled.requests.some(x=>x.startsWith('read:')))
})

test('existing core cannot qualify an external date guessed from the linked-active hypothesis',async()=>{
  const f=fixture()
  const observed=await f.discover()
  assert.equal(observed.length,1)
  const report=await runCompanyFirst({enabled:true},scope,{category:'fixture sector',place:'canonical target',
    event:'hiring_posting',from:'2026-10-01',through:'2026-11-20'},{
    discover:async()=>[candidate],
    reserveBeforeDispatch:async()=>true,isCurrent:async()=>true,
    verifyWebsite:async()=>verified,
    verifyDatedSignal:async({input})=>{
      assert.equal(input.postingUrl,undefined)
      return {companyKey:verified.companyKey,place:input.place,event:input.event,date:'2026-11-01',
        sourceUrl:observed[0].exactPostingUrl,quote:'Sample position in one region.',literalSourceText:'Sample position in one region.',
        dateProof:{kind:'ats_first_published',day:'2026-11-01',sourceUrl:observed[0].exactPostingUrl}}
    },
  })
  assert.equal(report.observed?.signals_verified,0)
  assert.deepEqual(report.findings,[{state:'held',reason:'signal_unknown',count:1}])
})
