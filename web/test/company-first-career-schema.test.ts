import assert from 'node:assert/strict'
import test from 'node:test'
import { companyFirstPublicReader } from '../lib/company-first/company-first-public-reader.ts'
import { discoverOwnedCareerSchema,matchOwnedCareerSignal,readExternalCareerProof } from '../lib/company-first/company-first-career-schema.ts'
const root='https://organization.example/about', origin=new URL(root).origin
const scope={tenant:'fixture',job:'scope',attempt:'1'}, name='Fixture Employer'
const candidate={name,hintUrl:root}
const site={status:'verified' as const,companyKey:'company-key',candidateName:name,website:origin,identitySource:root}
const title='Fixture operations position'
const location={addressLocality:'Fixture Locality',addressRegion:'Fixture Region',addressCountry:'FX'}
const from='2026-10-01',through='2026-11-01',posted='2026-10-21',now=()=>Date.parse('2026-11-02')
const signal=()=>new AbortController().signal
const html=(s:string)=>'<html><head></head><body><h1>Visible public page</h1>'+s+'</body></html>'
const a=(u:string)=>'<a href="'+u+'">Visible career link</a>'
function schema(url:string,extra:Record<string,unknown>={}){
  return {'@context':'https://schema.org','@type':'JobPosting',url,title,datePosted:posted,
    'hiringOrganization':{'@type':'Organization',name,url:origin+'/'},
    'jobLocation':{'@type':'Place',address:{'@type':'PostalAddress',...location}},...extra}
}
function posting(raw:string,date=posted){
  return html('<h2>'+title+'</h2><p>'+name+'</p><p>'+location.addressLocality+'</p><p>'+location.addressRegion+
    '</p><p>'+location.addressCountry+'</p><p>Posted '+date+'</p><script type="application/ld+json">'+raw+'</script>')
}
async function readPages(pages:Record<string,string>){
  const urls:string[]=[]
  const r=companyFirstPublicReader(scope,{isCurrent:async()=>true,reserveCurrentRead:async()=>true},async u=>{
    if(!u.endsWith('/robots.txt'))urls.push(u)
    const body=pages[u]
    return body||u.endsWith('/robots.txt')?{body:body??'',complete:true,contentEncoding:'identity',status:body?200:404,finalUrl:u,
      contentType:body?'text/html':'text/plain'}:null
  })
  return {rows:await discoverOwnedCareerSchema(scope,candidate,site,{from,through},r.readCareerHtml,signal(),now),urls}
}
test('real guarded static paths for Workable, BambooHR and first-party structured posting',async()=>{
  for(const [board,job] of [
    ['https://apply.workable.com/example-employer/','https://apply.workable.com/j/EX2019131/'],
    ['https://fixture-employer.bamboohr.com/careers','https://fixture-employer.bamboohr.com/careers/42'],
    [null,origin+'/careers/typed-position'],
  ] as const){
    const pages={[root]:html(a(board??job)),[job]:posting(JSON.stringify(schema(job)))}
    if(board)pages[board]=html(a(job))
    const got=await readPages(pages)
    assert.deepEqual(got.urls,board?[root,board,job]:[root,job])
    assert.equal(got.rows.length,1)
    assert.equal(got.rows[0].day,posted)
    assert.equal(got.rows[0].sourceUrl,job)
    assert.equal(got.rows[0].ownedVisibleDate,board===null)
  }
})
test('keeps holds on missing/modified/future date, wrong link or employer, remote, ambiguity, and hidden links',async()=>{
  const u=origin+'/careers/typed-position'
  const row=schema(u)
  for(const raw of [
    JSON.stringify(schema(u,{datePosted:undefined,dateModified:posted})),
    JSON.stringify(schema(u,{datePosted:'2026-11-04'})),
    JSON.stringify(schema(u,{url:origin+'/careers/different'})),
    JSON.stringify(schema(u,{hiringOrganization:{'@type':'Organization',name:'Different employer'}})),
    JSON.stringify(schema(u,{jobLocationType:'TELECOMMUTE'})),
    JSON.stringify(schema(u,{jobLocation:[row.jobLocation,row.jobLocation]})),
    JSON.stringify({'@context':'https://schema.org','@graph':[row,row]}),
    JSON.stringify(row).replace('"datePosted":','"datePosted":"2025-01-01","date\\u0050osted":'),
  ])assert.deepEqual((await readPages({[root]:html(a(u)),[u]:posting(raw)})).rows,[])
  const hidden=await readPages({[root]:html('<section hidden>'+a(u)+'</section>'),[u]:posting(JSON.stringify(row))})
  assert.deepEqual(hidden.urls,[root])
  const b='https://fixture-employer.bamboohr.com/careers'
  const other='https://other-employer.bamboohr.com/careers/42'
  const cross=await readPages({[root]:html(a(b)),[b]:html(a(other)),[other]:posting(JSON.stringify(schema(other)))})
  assert.deepEqual(cross.urls,[root,b]);assert.deepEqual(cross.rows,[])
})


test('only exact owner-published role, place and visible first-published date can become a candidate',async()=>{
  const url=origin+'/careers/typed-position'
  const input={companyKey:site.companyKey,websiteOrigin:origin,event:'hiring_posting',place:'reviewed-place',from,through}
  const match={role:(v:string)=>v===title,place:(p:{locality:string;region:string;country:string})=>p.locality===location.addressLocality&&p.region===location.addressRegion&&p.country===location.addressCountry}
  const {rows}=await readPages({[root]:html(a(url)),[url]:posting(JSON.stringify(schema(url)))})
  const proof=matchOwnedCareerSignal(scope,input,rows,match,signal(),now)
  assert.equal(proof?.sourceUrl,url)
  assert.equal(proof?.quote,title)
  assert.equal(proof?.dateProof.kind,'first_party_event_date')
  assert.equal(proof?.dateProof.kind==='first_party_event_date'&&proof.dateProof.literalDate,'Posted '+posted)
  for(const denied of [
    matchOwnedCareerSignal({...scope,attempt:'older'},input,rows,match,signal(),now),
    matchOwnedCareerSignal(scope,{...input,websiteOrigin:'https://other.example'},rows,match,signal(),now),
    matchOwnedCareerSignal(scope,input,rows.map(r=>({...r})),match,signal(),now),
    matchOwnedCareerSignal(scope,input,rows,{...match,place:()=>false},signal(),now),
    matchOwnedCareerSignal(scope,input,rows,match,signal(),()=>now()+60_000),
    matchOwnedCareerSignal(scope,input,[...rows,...rows],match,signal(),now),
  ])assert.equal(denied,null)
  const hidden=(await readPages({[root]:html(a(url)),[url]:posting(JSON.stringify(schema(url)),'different date')})).rows
  assert.equal(matchOwnedCareerSignal(scope,input,hidden,match,signal(),now),null)
})

test('external proof keeps original private provenance, requires reviewed target and affirmative active date status',async()=>{
  for(const [board,job] of [
    ['https://apply.workable.com/example-employer/','https://apply.workable.com/j/EX2019131/'],
    ['https://fixture-employer.bamboohr.com/careers','https://fixture-employer.bamboohr.com/careers/42'],
  ]){
    const positive=posting(JSON.stringify(schema(job))).replace('</body>','<p>Applications open</p></body>')
    const pages={[root]:html(a(board)),[board]:html('<h2>'+name+'</h2>'+a(job)),[job]:positive}
    const got=await readPages(pages), r=got.rows[0]
    assert.deepEqual(got.urls,[root,board,job])
    const match=(x:{title:string;location:{locality:string;region:string;country:string}})=>x.title===title&&x.location.locality===location.addressLocality&&x.location.region===location.addressRegion&&x.location.country===location.addressCountry
    assert.equal(readExternalCareerProof(r,scope,site,match,now)?.postedDay,posted)
    assert.equal(readExternalCareerProof({...r},scope,site,match,now),null)
    assert.equal(readExternalCareerProof(r,{...scope,attempt:'different'},site,match,now),null)
    assert.equal(readExternalCareerProof(r,scope,site,()=>false,now),null)
    assert.equal(readExternalCareerProof(r,scope,site,match,()=>now()+60_001),null)
    for(const alternate of [
      {...pages,[root]:html(a(job))},
      {...pages,[board]:html(a(job))},
      {...pages,[job]:positive.replace('Posted '+posted,'Updated '+posted)},
      {...pages,[job]:positive.replace('Applications open','Apply now')},
      {...pages,[job]:positive.replace('Applications open','Applications open</p><p>Applications closed')},
      {...pages,[job]:positive.replace('<p>Applications open</p>','<p hidden>Applications open</p>')},
    ]){
      assert.ok((await readPages(alternate)).rows.every(row=>!readExternalCareerProof(row,scope,site,match,now)))
    }
  }
})
