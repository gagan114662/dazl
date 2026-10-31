// CLI correctness on synthetic work only. Never a host-capacity or provider-quality claim.
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const env={...process.env,LOAD_TENANTS:'1',LOAD_JOBS_PER_TENANT:'1',LOAD_READERS:'1',LOAD_PROVIDER_MS:'1',LOAD_FETCH_MS:'1',LOAD_BASELINE_S:'0.1'}
// LOAD_DB must never steer this control to an existing store.
delete env.LOAD_DB
const run=(args=[])=>spawnSync(process.execPath,['--experimental-strip-types','--no-warnings',...args,'load/runner-bench.ts'],{cwd:root,env,encoding:'utf8',timeout:60000})
test('complete configured synthetic work is success, an empty failed task is not',()=>{
 const positive=run();assert.equal(positive.status,0,positive.stdout+positive.stderr)
 const p=JSON.parse(positive.stdout);assert.equal(p.correctness.jobs_done,1);assert.equal(p.correctness.leads_written,5)
 const dir=mkdtempSync(path.join(tmpdir(),'runner-negative-'))
 try{
  const loader=path.join(dir,'empty.mjs')
  writeFileSync(loader,`export async function load(url,ctx,next){const r=await next(url,ctx);if(url.endsWith('/load/mock.ts'))return {...r,source:String(r.source).replace('return out','return []')};return r}`)
  const negative=run(['--loader',loader]);assert.equal(negative.status,1,negative.stdout+negative.stderr)
  const n=JSON.parse(negative.stdout);assert.equal(n.correctness.jobs_done,0);assert.equal(n.correctness.jobs_failed,1);assert.equal(n.correctness.leads_written,0);assert.equal(n.correctness.expected_leads,5)
  assert.match(negative.stderr,/completed-job and exact fixture-lead counts/)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
