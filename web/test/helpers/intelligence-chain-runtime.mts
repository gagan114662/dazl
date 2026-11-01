// Browser test RPC. Real route handlers, real SQLite transactions, real key/spend/SSRF/research logic.
// Only site/model transport, authenticated test principal and post-response runner dispatch are fixture boundaries.
import readline from 'node:readline'
import Database from 'better-sqlite3'
import {randomBytes} from 'node:crypto'
import {NextRequest} from 'next/server'
import {setScanDb,setUser} from './tenant-route-db.ts'
import {migrateScan} from '../../lib/scan/store.ts'
import {migrateKeys,saveKey} from '../../lib/llm/key-store.ts'
import {migratePlans} from '../../lib/plans.ts'
import {migratePlatform} from '../../lib/db/platform-tables.ts'
import {POST as readSite} from '../../app/api/scan/icp-from-url/route.ts'
import {POST as estimate} from '../../app/api/scan/estimate/route.ts'
import {POST as admit} from '../../app/api/scan/route.ts'
process.env.DAZL_MASTER_KEY=randomBytes(32).toString('base64')
const db=new Database(':memory:');migrateScan(db);migrateKeys(db);migratePlans(db);migratePlatform(db);setScanDb(db)
setUser({id:'chain-tenant',actorId:'chain-actor',business_name:'Fixture'})
saveKey(db,'chain-tenant','anthropic','sk-fixture-never-network')
let modelCalls=0
const draft={sells:'Booking',draft:{summary:'Clinics buying scheduling software',who:[],industries:[],sizes:[],where:[],signals:[],exclude:[]},offers:[{id:'o1',name:'Booking'}],items:[{offer:'o1',kind:'persona',text:'Clinic managers',url:'https://seller.example/',quote:'Booking helps Clinic managers schedule patient appointments.'}]}
globalThis.fetch=(async(u:unknown)=>{const url=String(u)
 if(url.endsWith('/v1/messages/count_tokens'))return Response.json({input_tokens:100})
 if(url.includes('api.anthropic.com/v1/messages')){modelCalls++;return Response.json({id:'fixture',content:[{type:'text',text:JSON.stringify(draft)}],usage:{input_tokens:100,output_tokens:100},stop_reason:'end_turn'})}
 if(url==='https://seller.example/'||url==='https://other.example/')return new Response('<html><title>Booking</title><body>'+('Booking helps Clinic managers schedule patient appointments. '.repeat(8))+'</body></html>',{headers:{'content-type':'text/html'}})
 throw Error('unexpected fixture transport '+url)
}) as typeof fetch
const request=(path:string,body:unknown)=>new NextRequest('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json',host:'localhost'},body:JSON.stringify(body)})
for await(const line of readline.createInterface({input:process.stdin})){
 try{const msg=JSON.parse(line);let result
 if(msg.op==='website'){const r=await readSite(request('/api/scan/icp-from-url',msg.body));result={status:r.status,body:await r.json()}}
 else if(msg.op==='estimate'){const r=await estimate(request('/api/scan/estimate',msg.body));result={status:r.status,body:await r.json()}}
 else if(msg.op==='admit'){const r=await admit(request('/api/scan',msg.body));result={status:r.status,body:await r.json()}}
 else if(msg.op==='finish'){db.prepare("UPDATE scan_jobs SET status='running',attempts=1 WHERE status='pending'").run();db.prepare("UPDATE scan_jobs SET status='done' WHERE status='running'").run();result={ok:true}}
 else if(msg.op==='inspect')result={decisions:db.prepare('SELECT tenant_id,actor_id,job_id,site,offer_id,action,text FROM seller_decisions ORDER BY created_at').all(),jobs:db.prepare('SELECT id,query FROM scan_jobs').all(),modelCalls}
 else throw Error('unknown op')
 process.stdout.write(JSON.stringify({id:msg.id,result})+'\n')
 }catch(e){process.stdout.write(JSON.stringify({error:String(e)})+'\n')}
}
db.close()
