// Private staging process composition. Not a signer, route, loader, scheduler,
// or deploy step. A release entry file must statically supply the production
// verifier/finder binding. Never select a module or provider from a grant.
import { lstatSync, realpathSync } from 'node:fs'
import Database from 'better-sqlite3'
import { TextDecoder } from 'node:util'
import { launchReviewedLocalScorecardArm } from './scorecard-local-launch.ts'
import type { ScorecardSubjectInput } from './scorecard-admission.ts'
import type { StagingProofRequest } from './scorecard-staging-proof.ts'

type LaunchPorts=Parameters<typeof launchReviewedLocalScorecardArm>[2]
type Material=Readonly<{tenantId:string;actorId:string;jobId:string;signedToken:string;reviewedInput:ScorecardSubjectInput;proofRequest:StagingProofRequest}>
export type StagingCaseOneBinder=(db:Database.Database, scope:Parameters<LaunchPorts['loadBinding']>[0])=>
  ReturnType<LaunchPorts['loadBinding']>
const MAX_MATERIAL_BYTES=46_000
const PUBLIC_REFUSAL=Object.freeze({state:'held',reason:'staging_launcher_not_authorized'} as const)
const sha=/^[a-f0-9]{40}$/
const tag=/^[a-f0-9]{64}$/
const id=/^[a-zA-Z0-9_-]{1,100}$/
const job=/^[a-f0-9]{24}$/
const ticket=/^[a-zA-Z0-9_-]+\.[a-f0-9]{64}$/
const stagingRoot='/srv/dazl-staging'
const stagingDb='/var/lib/dazl-staging/app.db'

function object(value:unknown, required:readonly string[], optional:readonly string[]=[]):value is Record<string,unknown>{
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)return false
  const x=value as object
  return required.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>required.includes(k)||optional.includes(k))
}
export function parseStagingCaseOneMaterial(raw:Uint8Array):Material|null{
  if(raw.byteLength>MAX_MATERIAL_BYTES)return null
  try{
    const x:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))
    if(!object(x,['tenantId','actorId','jobId','signedToken','reviewedInput','proofRequest'])||
      typeof x.tenantId!=='string'||!id.test(x.tenantId)||typeof x.actorId!=='string'||!id.test(x.actorId)||
      typeof x.jobId!=='string'||!job.test(x.jobId)||typeof x.signedToken!=='string'||x.signedToken.length>2000||!ticket.test(x.signedToken)||
      !object(x.proofRequest,['expiresAt','mac'])||typeof x.proofRequest.expiresAt!=='number'||
      !Number.isSafeInteger(x.proofRequest.expiresAt)||typeof x.proofRequest.mac!=='string'||!tag.test(x.proofRequest.mac)||
      !object(x.reviewedInput,['query','icp'],['sources','seller','offer'])||typeof x.reviewedInput.query!=='string'||
      typeof x.reviewedInput.icp!=='string'||(['sources','seller','offer'] as const).some(k=>x.reviewedInput&&
        (x.reviewedInput as Record<string,unknown>)[k]!=null&&typeof (x.reviewedInput as Record<string,unknown>)[k]!=='string')) return null
    return Object.freeze({tenantId:x.tenantId,actorId:x.actorId,jobId:x.jobId,signedToken:x.signedToken,
      proofRequest:Object.freeze({expiresAt:x.proofRequest.expiresAt,mac:x.proofRequest.mac}),
      reviewedInput:Object.freeze({...x.reviewedInput} as ScorecardSubjectInput)})
  }catch{return null}
}
async function privateInput():Promise<Material|null>{
  if(process.stdin.isTTY)return null
  const chunks:Buffer[]=[]
  let size=0
  for await(const raw of process.stdin){
    const part=Buffer.isBuffer(raw)?raw:Buffer.from(raw)
    if((size+=part.byteLength)>MAX_MATERIAL_BYTES)return null
    chunks.push(part)
  }
  const material=Buffer.concat(chunks)
  try{return parseStagingCaseOneMaterial(material)}
  finally{material.fill(0);for(const c of chunks)c.fill(0)}
}

// Invoked by trusted staging code only. The operator holds the same staging
// deploy lock as deploy.sh while this runs; this function independently
// verifies exact realpaths, stamped code, root release identity and SQLite.
export async function runTrustedStagingCaseOneEntry(bind:StagingCaseOneBinder, signal:AbortSignal){
  let key:Buffer|undefined
  let db:Database.Database|undefined
  try{
    const expected=process.argv[2], secret=process.env.DAZL_STAGING_CASE_ONE_SIGNING_KEY
    if(process.argv.length!==3||!sha.test(expected??'')||process.env.DAZL_ENV!=='staging'||
      process.env.DAZL_COMMIT_SHA!==expected||process.env.DATABASE_URL||process.env.DB_PATH!==stagingDb||
      secret===process.env.DAZL_SCORECARD_SIGNING_KEY||secret===process.env.DAZL_STAGING_SCORECARD_PROOF_KEY||
      !tag.test(secret??'')||signal.aborted||typeof bind!=='function')return PUBLIC_REFUSAL
    const webRoot=`${stagingRoot}-releases/${expected}/web`
    const info=lstatSync(stagingDb)
    if(realpathSync(`${stagingRoot}/current/web`)!==webRoot||process.cwd()!==webRoot||
      !info.isFile()||info.nlink!==1||realpathSync(stagingDb)!==stagingDb)return PUBLIC_REFUSAL
    const x=await privateInput()
    if(!x||signal.aborted)return PUBLIC_REFUSAL
    key=Buffer.from(secret!,'hex')
    db=new Database(stagingDb,{fileMustExist:true,timeout:2000})
    db.pragma('foreign_keys=ON')
    const connection=db
    const result=await launchReviewedLocalScorecardArm(connection,{tenantId:x.tenantId,actorId:x.actorId,release:expected},
      {signer:key,stagingCaseOne:{host:{webRoot,privateSqlitePath:stagingDb,servingRelease:expected,runtime:'staging'},proofRequest:x.proofRequest},
       // loadBinding is asked only after the signed subject and exact owner
       // are verified. Composition is local, synchronous or read-only; no spend.
       loadBinding:scope=>bind(connection,scope)},x,signal)
    return result.state==='measured'&&result.arm==='new'&&result.stagingProof?
      Object.freeze({state:'measured' as const,jobId:x.jobId,proven:result.proven,held:result.stagingProof.held,
        candidates:result.candidates,rightPlace:result.rightPlace,actualMicros:result.actualMicros,samples:result.stagingProof.samples}):
      Object.freeze({state:'held' as const,reason:result.state==='held'?result.reason:'settled_proof_refused'})
  }catch{return PUBLIC_REFUSAL}
  finally{key?.fill(0);db?.close()}
}
