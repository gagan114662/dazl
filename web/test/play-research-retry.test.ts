import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {migrateAllSqlite} from '../lib/db/sqlite-migrations.ts'
import {sqliteDb,StatementFailedInTx,type Db} from '../lib/db/client.ts'
import {savePlayResearch,playResearchCards,PlayResearchError} from '../lib/scan/play-research.ts'
const id='e'.repeat(24),input={company:'Epoch',signal:'Seed claim',source_url:'https://epoch.example',excerpt:'Epoch announced a seed round in London.'}
function setup(){const raw=new Database(':memory:');migrateAllSqlite(raw);raw.exec("INSERT INTO users(id,email,password_hash,salt) VALUES('E','e@example.test','test','test')");raw.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,offer) VALUES(?,'E','Original','SaaS','London','running','London SaaS seed','CRM setup')").run(id);raw.exec("UPDATE scan_jobs SET status='done'");return sqliteDb(raw)}
for(const phase of ['initial','final'])for(const wrapped of [true,false])test(`${phase} retries ${wrapped?'wrapped statement':'direct commit'} transient cause without another source fetch`,async()=>{
 const base=setup();let transactions=0,failures=0,fetches=0
 const db:Db={...base,async tx(body,isolation){transactions++;if(transactions===(phase==='initial'?1:2)){failures++;const error=Object.assign(new Error('injected serialization'),{code:'40001'});throw wrapped?new StatementFailedInTx(error):error}return base.tx(body,isolation)}}
 const result=await savePlayResearch(db,'E',id,input,async()=>{fetches++;return {title:'Epoch',text:input.excerpt,retrievedAt:1793286117}})
 assert.equal(failures,1);assert.equal(fetches,1);assert.equal((await playResearchCards(base,'E',id))[0].id,result.id);await base.close()
})
test('exhausted nested deadlock refuses as research context error; unrelated unique error not swallowed',async()=>{
 const base=setup();let fetches=0
 const db:Db={...base,async tx(){throw new StatementFailedInTx(Object.assign(Error('deadlock'),{code:'40P01'}))}}
 await assert.rejects(savePlayResearch(db,'E',id,input,async()=>{fetches++;throw Error()}),PlayResearchError);assert.equal(fetches,0)
 const bad:Db={...base,async tx(){throw new StatementFailedInTx(Object.assign(Error('unrelated constraint'),{code:'23505'}))}}
 await assert.rejects(savePlayResearch(bad,'E',id,input),/unrelated constraint/);await base.close()
})
