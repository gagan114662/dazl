// Exercise the actual client event handlers with fenced authenticated route
// responses. The separate rendered check lives in ui/reuse-profile.ui.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const client=readFileSync(new URL('../app/app/leads/leads-client.tsx',import.meta.url),'utf8')
const tree=ts.createSourceFile('leads-client.tsx',client,ts.ScriptTarget.ESNext,true,ts.ScriptKind.TSX)
const handlers=new Map<string,string>()
function visit(n:ts.Node){
  if(ts.isFunctionDeclaration(n)&&n.name)handlers.set(n.name.text,n.getText(tree))
  ts.forEachChild(n,visit)
}
visit(tree)
const names=['receiveOfferConflict','run','confirmRun','chooseDirectOffer']
const compiled=ts.transpileModule(names.map(n=>handlers.get(n)??'').join('\n'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
const helper=await import('../app/app/leads/offer-preflight.ts').catch(()=>({}))
const stale={summary:'Independent dental practice owners', who:['Practice owner'], where:['New York City'], industries:['Dental']}
const saved='Dental appointment reminder software', stated='dazl'
const query='Find small marketing and creative agencies in Toronto hiring an SDR. I sell dazl.'
function mount({answer=stated,defer=false}:{answer?:string;defer?:boolean}={}){
  const requests:{path:string;body:Record<string,unknown>}[]=[]
  const s={conflict:null as null|{stated:string;saved:string;direct:boolean},estimate:null as null|{est:{ack:string};query:string;withIcp:unknown;offer?:string;reviewed?:boolean}, error:''}
  const latestOfferQuery={current:query}
  let release=()=>{}
  const delayed=defer?new Promise<void>(resolve=>{release=resolve}):Promise.resolve()
  const ctx={
    query,latestOfferQuery,startIcp:stale,priorIcp:stale,startReviewed:false,budgetCheck:{},
    useGithub:false,useYoutube:false,useV2ex:false,useJobboards:false,useBrreg:false,feedText:'',pageText:'',advPick:[],
    setError:(error:string)=>{s.error=error},setStarting:()=>{},setTrialRefused:()=>{},setLinkNote:()=>{},
    setPendingEst:(o:typeof s.estimate)=>{s.estimate=o},setOfferConflict:(o:typeof s.conflict)=>{s.conflict=o},
    buildSources:()=>null,asResearchBlock:()=>null,
    fetch:async(path:string,init:{body:string})=>{
      const body=JSON.parse(init.body)
      requests.push({path,body})
      if(path.endsWith('/estimate')){
        await delayed
        return body.offer===answer?
          {status:200,ok:true,json:async()=>({estimate:{ack:'reviewed-fixture'}})}:
          {status:409,ok:false,json:async()=>({error:'offer_conflict',stated,saved})}
      }
      return {status:400,ok:false,json:async()=>({error:'fenced fixture; do not start'})}
    },
    knownErrorCopy:()=>null,...helper,
  }
  const run=new Function(...Object.keys(ctx),compiled+'\nreturn {run,confirmRun,chooseDirectOffer}')(...Object.values(ctx))
  const settle=()=>new Promise(resolve=>setImmediate(resolve))
  return {s,run,requests,latestOfferQuery,release,settle}
}
test('direct offer conflict precedes cost and choosing another offer drops stale historical buyer for both requests',async()=>{
  const f=mount()
  await f.run.run(stale,undefined,false)
  assert.equal(f.s.conflict?.stated,stated,'estimate should display Use: dazl before any cost panel')
  assert.equal(f.s.estimate,null)
  assert.equal(f.requests.length,1)
  f.run.chooseDirectOffer(stated,saved)
  await f.settle()
  const e=f.s.estimate!
  assert.equal(e.est.ack,'reviewed-fixture')
  assert.deepEqual(f.requests[1],{path:'/api/scan/estimate',body:{query,offer:stated}})
  await f.run.confirmRun(e.est.ack,e.query,e.withIcp,e.offer,e.reviewed)
  assert.deepEqual(f.requests[2],{path:'/api/scan',body:{estimate_ack:'reviewed-fixture',query,offer:stated}})
  assert.match(stale.summary,/dental/,'saved/history data is not edited')
})
test('explicit keep saved carries the old profile without claiming a new review',async()=>{
  const f=mount({answer:saved})
  await f.run.run(stale,undefined,false)
  assert.equal(f.s.conflict?.saved,saved)
  f.run.chooseDirectOffer(saved,saved)
  await f.settle()
  assert.deepEqual(f.requests[1].body,{query,offer:saved,icp:stale,reviewed:false})
})
test('a response for the old sentence never prompts a new choice, estimate or scan',async()=>{
  const f=mount({defer:true})
  const pending=f.run.run(stale,undefined,false)
  f.latestOfferQuery.current='another request'
  f.release()
  await pending
  assert.equal(f.s.conflict,null)
  assert.equal(f.s.estimate,null)
  await f.run.confirmRun('old-ack',query,null,stated)
  assert.equal(f.requests.length,1)
})

test('an ambiguous request without a saved offer stays a manual choice', async () => {
  const { scanOfferConflict } = await import('../app/app/leads/offer-preflight.ts')
  const result = scanOfferConflict(409, { error: 'offer_conflict', stated: null, saved: '', ambiguous: true })
  assert.deepEqual(result, { stated: null, saved: '', ambiguous: true })
  assert.equal(scanOfferConflict(409, { error: 'offer_conflict', stated: null, saved: '' }), null)
})
