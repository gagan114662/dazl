// Test-process-only external boundary. No application endpoint is intercepted.
import './net-fence.ts'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'

const db=process.env.DB_PATH, port=Number(process.env.DAZL_FIXTURE_SITE_PORT)
if(!db?.includes('/dazl-signed-website-review-')||!/\/app\.db$/.test(db)||!Number.isInteger(port)||port<1024||port>65535) {
  throw Error('Only the isolated signed website review harness can start this preload')
}
const log=join(dirname(db),'provider-transport.log')
const host='seller.fixture.test', offer='Fixture Booking', alternate='Fixture Analytics'
const wire='sk-ant-api03-SYNTHETICFIXTUREONLY000000000000000'
process.env.DAZL_MASTER_KEY=Buffer.alloc(32,55).toString('base64')
const fencedLookup=dns.lookup.bind(dns), fencedHttps=https.request.bind(https)
const publicPin='8.8.8.8' // synthetically returned; this process never dials it
dns.lookup=async (name, options)=>{
  if(name===host&&options?.all===true)return [{address:publicPin,family:4}]
  if(name==='localhost'||name==='127.0.0.1'||name==='::1')return fencedLookup(name,options)
  throw Error('Unexpected fixture DNS request')
}
// #1463: scan hosts resolve through c-ares (lib/net/scan-dns.ts, dns.promises.Resolver), not dns.lookup: the same fixture answer there.
const scanResolver=dns.Resolver.prototype
scanResolver.resolve4=async function(name){ if(name===host)return [publicPin]; throw Error('Unexpected fixture DNS request') }
scanResolver.resolve6=async function(name){ if(name===host)throw Object.assign(Error('no AAAA for fixture'),{code:'ENODATA'}); throw Error('Unexpected fixture DNS request') }
https.request=(url,opts,onResponse)=>{
  if(!(url instanceof URL)||url.origin!=='https://'+host) return fencedHttps(url,opts,onResponse)
  if(opts?.method!=='GET'||!['/single','/multiple'].includes(url.pathname)||url.search||url.hash)
    throw Error('Unexpected website transport fixture request')
  // Exercise the production validation of exact host and pinned address
  // before sending the fixture's bytes through a local HTTP transport.
  let pinned=false
  opts.lookup(host,{},(err,address,family)=>{pinned=!err&&address===publicPin&&family===4})
  if(!pinned)throw Error('Website reader did not pass the guarded address')
  return http.request('http://127.0.0.1:'+port+url.pathname,{method:'GET',signal:opts.signal,agent:false},onResponse)
}
syncBuiltinESMExports()
const fencedFetch=globalThis.fetch
globalThis.fetch=async(input,init)=>{
  const url=input instanceof Request?input.url:String(input)
  if(url!=='https://api.anthropic.com/v1/messages')return fencedFetch(input,init)
  const req=new Request(input,init)
  const body=await req.json()
  if(req.method!=='POST'||req.headers.get('x-api-key')!==wire||body.max_tokens!==1200||body.tools?.length)
    throw Error('Non-website-draft model call refused')
  const prompt=JSON.stringify(body.messages)
  const variant=['single','multiple'].find(p=>prompt.includes('https://'+host+'/'+p))
  if(!variant||!prompt.includes('We sell Fixture Booking')) throw Error('Website bytes were not present in the draft prompt')
  const site='https://'+host+'/'+variant
  const offers=[{id:'o1',name:offer,url:site,quote:'We sell Fixture Booking.',inferred:false}]
  if(variant==='multiple')offers.push({id:'o2',name:alternate,url:site,quote:'We sell Fixture Analytics.',inferred:false})
  const items=[
    {offer:'o1',kind:'persona',text:'operations managers',url:site,inferred:true},
    {offer:'o1',kind:'persona',text:'sales managers',url:site,inferred:true},
    ...(variant==='multiple'?[{offer:'o1',kind:'persona',text:'service coordinators',url:site,quote:'Fixture Booking helps service coordinators manage appointments.',inferred:false},{offer:'o2',kind:'persona',text:'finance managers',url:site,inferred:true}]:[]),
  ]
  appendFileSync(log,variant+'\n')
  return Response.json({id:'msg_fixture',model:'claude-sonnet-4-5',stop_reason:'end_turn',
    content:[{type:'text',text:JSON.stringify({sells:offer,draft:{summary:'Operators with dated hiring evidence',who:[],industries:[],sizes:[],where:[],signals:['hiring'],exclude:[]},offers,items})}],
    usage:{input_tokens:40,output_tokens:45}})
}
