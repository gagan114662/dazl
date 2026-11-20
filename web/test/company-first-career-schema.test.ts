import assert from 'node:assert/strict'
import test from 'node:test'
import { companyFirstPublicReader } from '../lib/company-first/company-first-public-reader.ts'
import { discoverOwnedCareerSchema } from '../lib/company-first/company-first-career-schema.ts'
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
