import test from 'node:test'
import assert from 'node:assert/strict'
import { runCompanyFirst,type Scope } from '../lib/company-first/company-first-evidence.ts'
import { proveCompanyFirstContact } from '../lib/company-first/company-first-contact-proof.ts'
import { bindGuardedCompanyFirstContact,readGuardedOwnRoleReceipt,readGuardedOwnRolePage } from '../lib/company-first/company-first-guarded-contact.ts'
import type { ObservedSafeGet } from '../lib/sources/http.ts'
const scope:Scope={tenant:'fixture-tenant',job:'fixture-job',attempt:'1'}
const origin='https://company.example', identity=origin+'/about',directory=origin+'/team', bio=origin+'/team/person'
const name='Jane Quinn', title='Purchasing Director',company='Example Manufacturing',email='jane.quinn@company.example'
const linked='https://www.linkedin.com/in/jane-quinn-example'
const signal=new AbortController().signal
const record=(fields:string)=>'<html><body>'+fields+'</body></html>'
const navigation=record('<p>This page identifies the company and its current team directory.</p><a href="/team">Our team</a>')
const directoryPage=record('<article><h2>'+name+'</h2><p>'+title+'</p><a href="/team/person">'+name+'</a></article>')
const bioPage=record('<article><h1>'+name+'</h1><p>'+title+'</p><p itemprop="worksFor">'+company+'</p><a href="'+linked+'">'+name+' on LinkedIn</a><a href="mailto:'+email+'">'+email+'</a></article>')
async function finding(){
 const day=new Date().toISOString().slice(0,10)
 const result=await runCompanyFirst({enabled:true},scope,{category:'fixture',place:'fixture',event:'fixture-event',from:day,through:day},{
  async reserveBeforeDispatch(){return true},async isCurrent(){return true},
  async discover(){return [{name:company}]},
  async verifyWebsite(){return {status:'verified',candidateName:company,companyKey:'verified-key',website:origin,identitySource:identity}},
  async verifyDatedSignal(){const sourceUrl=origin+'/careers',quote='Opening business roles from this published listing.'
    return {companyKey:'verified-key',place:'fixture',event:'fixture-event',date:day,sourceUrl,quote,
      literalSourceText:quote+' '+day,dateProof:{kind:'first_party_event_date',sourceUrl,day,literalDate:day}}
  },
 })
 const f=result.findings[0]
 assert.ok(f.state==='signal_verified')
 return f
}
function fixture(overrides:Partial<Record<string,string>>={}, deny?:string){
 const reads:string[]=[], permits:string[]=[]
 const pages:Record<string,string|undefined>={[identity]:navigation,[directory]:directoryPage,[bio]:bioPage,...overrides}
 const wire:ObservedSafeGet=async url=>{
   reads.push(url)
   if(url.endsWith('/robots.txt'))return {status:404,body:'',finalUrl:url,complete:true,contentType:'text/plain',contentEncoding:'identity'}
   const body=pages[url]
   assert.ok(typeof body==='string',url)
   return {status:200,body,finalUrl:url,complete:true,contentType:'text/html',contentEncoding:'identity'}
 }
 const reader=bindGuardedCompanyFirstContact(scope,{publicRead:{
  async isCurrent(){return true},async reserveCurrentRead(r){permits.push(r.exactUrl);return r.exactUrl!==deny},
 },async isCurrent(){return true},async reserveBeforeDispatch(){return true}},wire)
 return {reader,reads,permits}
}
test('original finding, actual guarded exact navigation/directory/bio produce strictly attributed literal contact; official live-role receipt is branded without any profile transport',async()=>{
 const f=await finding(),{reader,reads,permits}=fixture()
 assert.equal(await reader.isCurrent(scope,{...f}),false)
 assert.equal(await reader.isCurrent({...scope,attempt:'foreign'},f),false)
 assert.equal(await reader.isCurrent(scope,f),true)
 assert.equal(await reader.reserveBeforeDispatch({scope,stage:'directory',signal}),true)
 const dir=await reader.readDirectory(origin,signal)
 assert.deepEqual(dir?.people,[{name,title,bioUrl:bio}])
 assert.equal(await reader.reserveBeforeDispatch({scope,stage:'bio',signal}),true)
 const actual=await reader.readBio(bio,signal)
 assert.deepEqual(actual?.profiles,[{url:linked,named:name}])
 assert.deepEqual(actual?.publications,[{named:name,address:email,literalLine:email}])
 assert.equal(await reader.reserveBeforeDispatch({scope,stage:'profile',signal}),true)
 const stampStart=Date.now()-2000
 assert.ok(actual)
 const receipt=await reader.verifyOwnRole(actual,f,signal)
 assert.ok(receipt&&receipt.observedAtMs>=stampStart&&receipt.observedAtMs<=Date.now())
 assert.deepEqual(receipt,{kind:'official_own_role',sourceUrl:bio,observedAtMs:receipt.observedAtMs,name,title,company,linkedin:linked,literalRoleQuote:title,literalNameQuote:name})
 assert.equal(readGuardedOwnRoleReceipt(actual,scope,f),receipt)
 const original=readGuardedOwnRolePage(actual,scope,f)
 assert.ok(original)
 assert.equal(original.observedAtMs,receipt.observedAtMs)
 assert.equal(original.url,bio)
 assert.equal(readGuardedOwnRolePage({...actual},scope,f),null)
 assert.equal(readGuardedOwnRoleReceipt(actual,scope,{...f}),null)
 assert.equal(readGuardedOwnRoleReceipt(actual,{...scope,tenant:'other'},f),null)
 assert.equal(readGuardedOwnRoleReceipt(actual,scope,f,receipt.observedAtMs+300_001),null)
 assert.deepEqual(reads,[origin+'/robots.txt',identity,origin+'/robots.txt',directory,origin+'/robots.txt',bio])
 assert.deepEqual(reads,permits)
 const proof=await proveCompanyFirstContact(f,[title],scope,fixture().reader,signal)
 assert.equal(proof.status,'contact_proof')
 assert.equal(proof.buyer.ownRole?.sourceUrl,bio)
 assert.equal(proof.buyer.ownRole?.quote,title)
 assert.equal(proof.published.address,email)
})
test('unknown/foreign or opaque navigation, cross-card role or bio, and physical refusal never fabricate evidence',async()=>{
 const f=await finding()
 for(const [pages,reason] of [
  [{[identity]:navigation.replace('href="/team"','href="https://evil.example/team"')},'directory_unavailable'],
  [{[identity]:navigation.replace('<a ','<a hidden ')},'directory_unavailable'],
  [{[directory]:directoryPage.replace('<p>','<p hidden>')},'directory_unavailable'],
  [{[directory]:directoryPage.replace('</body>','<article><h2>'+name+'</h2><p>Former Director</p></article></body>')},'directory_unavailable'],
  [{[directory]:directoryPage.replace('/team/person','/team/../person')},'directory_unavailable'],
  [{[bio]:bioPage.replace(company,'Different Company')},'bio_unconfirmed'],
  [{[bio]:bioPage.replace('<article>','<section aria-label="Former team"><article>').replace('</article>','</article></section>')},'bio_unconfirmed'],
  [{[bio]:bioPage.replace(title,'Former '+title)},'bio_unconfirmed'],
  [{[bio]:bioPage.replace('mailto:'+email,'mailto:info@company.example')},'email_unconfirmed'],
  [{[bio]:bioPage.replace(name+' on LinkedIn','Someone Else on LinkedIn')},'bio_unconfirmed'],
  [{[bio]:bioPage.replace('<a href="mailto:','<a hidden href="mailto:')},'email_unconfirmed'],
 ] as const){
   const {reader,reads}=fixture(pages)
   assert.deepEqual(await proveCompanyFirstContact(f,[title],scope,reader,signal),{status:'held',reason})
   assert.ok(reads.every(url=>new URL(url).origin===origin))
 }
 const {reader,reads}=fixture({},directory)
 assert.deepEqual(await proveCompanyFirstContact(f,[title],scope,reader,signal),{status:'held',reason:'directory_unavailable'})
 assert.equal(reads.includes(directory),false)
})
test('verified employer role without LinkedIn mints a nullable receipt, not a profile or network call',async()=>{
 const f=await finding()
 const {reader,reads}=fixture({[bio]:bioPage.replace('<a href="'+linked+'">'+name+' on LinkedIn</a>','')})
 assert.equal(await reader.isCurrent(scope,f),true)
 assert.equal(await reader.reserveBeforeDispatch({scope,stage:'directory',signal}),true)
 assert.ok(await reader.readDirectory(origin,signal))
 assert.equal(await reader.reserveBeforeDispatch({scope,stage:'bio',signal}),true)
 const actual=await reader.readBio(bio,signal)
 assert.ok(actual)
 assert.equal(await reader.verifyOwnRole(actual,f,signal),null)
 assert.equal(await reader.reserveBeforeDispatch({scope,stage:'profile',signal}),true)
 const role=await reader.verifyOwnRole(actual,f,signal)
 assert.ok(role)
 assert.equal(role.linkedin,null)
 assert.equal(role,readGuardedOwnRoleReceipt(actual,scope,f))
 const noLink=fixture({[bio]:bioPage.replace('<a href="'+linked+'">'+name+' on LinkedIn</a>','')})
 const contact=await proveCompanyFirstContact(f,[title],scope,noLink.reader,signal)
 assert.equal(contact.status,'contact_proof')
 assert.equal(contact.buyer.linkedin,null)
 assert.equal(contact.buyer.ownRole?.quote,title)
 assert.ok(reads.every(url=>new URL(url).origin===origin))
})
