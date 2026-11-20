import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { allowStagingProof, projectStagingSample } from '../lib/company-first/scorecard-staging-proof.ts'
import type { VerifiedScorecardTicket } from '../lib/company-first/scorecard-admission.ts'

const hash = (c:string) => c.repeat(64)
const release='e'.repeat(40)
const key=hash('a')
const env={ NODE_ENV:'test' as const, DAZL_ENV:'staging', DAZL_COMMIT_SHA:release, DAZL_STAGING_SCORECARD_PROOF_KEY:key }
const ticket:VerifiedScorecardTicket={tenantId:'test-tenant',actorId:'test-owner',jobId:'test-job',attempt:1,release,
  workspaceRevision:hash('b'),cohort:hash('c'),ordinal:1,nonce:hash('d'),subjectMac:hash('e'),expiresAt:100_000,lane:'new',presets:[]}
const expiresAt=90_000
const mac=createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify(['dazl-staging-scorecard-proof/v1',
  ticket.tenantId,ticket.actorId,ticket.jobId,ticket.attempt,release,ticket.workspaceRevision,ticket.cohort,ticket.ordinal,ticket.nonce,
  ticket.subjectMac,expiresAt])).digest('hex')
const request={expiresAt,mac}

test('staging proof opt-in requires signed exact private case, owner, lane, release, job and time',()=>{
  assert.equal(allowStagingProof(ticket,request,80_000,env),true)
  assert.equal(allowStagingProof(ticket,undefined,80_000,env),false)
  assert.equal(allowStagingProof(ticket,request,expiresAt,env),false)
  assert.equal(allowStagingProof(ticket,request,80_000,{...env,DAZL_ENV:'production'}),false)
  assert.equal(allowStagingProof(ticket,request,80_000,{...env,DAZL_COMMIT_SHA:release.slice(0,8)}),false)
  for(const edit of [{actorId:'other'},{tenantId:'other'},{jobId:'other'},{attempt:2},{subjectMac:hash('f')},{workspaceRevision:hash('f')},
    {nonce:hash('f')},{expiresAt:89_999},{lane:'old' as const},{cohort:hash('f')},{ordinal:2}]){
    assert.equal(allowStagingProof({...ticket,...edit},request,80_000,env),false,JSON.stringify(edit))
  }
})
test('sample exposes only three public values and strips no secrets by silently repairing invalid evidence',()=>{
  assert.deepEqual(projectStagingSample('Example Company','https://example.com/','Jane Quinn'),{
    company:'Example Company',website:'https://example.com',buyer:'Jane Quinn',
  })
  for(const website of ['https://user:token@example.com/','https://example.com/?token=abc','https://example.com/team','https://example.com/#brief']){
    assert.equal(projectStagingSample('Example Company',website,'Jane Quinn'),null)
  }
  assert.equal(projectStagingSample('Example Company','https://example.com/','private@example.com'),null)
})
