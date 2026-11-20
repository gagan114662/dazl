import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { applyReviewedScorecardEnrollment } from '../lib/company-first/scorecard-enrollment.ts'
import { requireScorecardWorkspace } from '../lib/company-first/scorecard-workspace.ts'

bothEngines('approved workspace switch uses current-owner and exact release CAS, then revoke invalidates the old epoch', async ({db})=>{
  const tenantId='fixture-enrollment-workspace', actorId='fixture-enrollment-actor'
  const release='a'.repeat(40), enabled='b'.repeat(64), revoked='c'.repeat(64), key=Buffer.alloc(32,19)
  const at=1785000000000
  await db.run('INSERT INTO users (id,email,password_hash,salt) VALUES (?,?,?,?)',[actorId,'enroll@example.invalid','fixture','fixture'])
  await db.run("INSERT INTO organizations (id,kind,created_by,created_at) VALUES (?,'team',?,1)",[tenantId,actorId])
  await db.run("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)",[tenantId,actorId])
  function approve(body: unknown[]) {
    const encoded=Buffer.from(JSON.stringify(body)).toString('base64url')
    return encoded+'.'+createHmac('sha256',key).update('dazl-scorecard-enrollment:v1\n').update(encoded).digest('hex')
  }
  const on=[tenantId,actorId,release,null,enabled,false,true,at+5000]
  const off=[tenantId,actorId,release,enabled,revoked,true,false,at+5000]
  const use=(token:string, now=at, exact=release)=>applyReviewedScorecardEnrollment(db,exact,token,key,()=>now)
  const active=(revision=enabled)=>db.tx(t=>requireScorecardWorkspace(t,{tenantId,actorId,workspaceRevision:revision}))
  assert.equal(await active(),false)
  assert.equal(await use(approve(on),at,'f'.repeat(40)),false)
  assert.equal(await use(approve(on),at+5000),false)
  assert.equal(await use(approve(on).slice(0,-1)+'q'),false)
  assert.deepEqual(await Promise.all([use(approve(on)),use(approve(on))]).then(rows=>rows.sort()),[false,true])
  assert.equal(await active(),true)
  assert.equal(await use(approve(off)),true)
  assert.equal(await active(),false)
  assert.equal(await active(revoked),false)
  assert.equal(await use(approve(on)),false)
  await db.run("UPDATE memberships SET role='admin' WHERE tenant_id=? AND member_id=?",[tenantId,actorId])
  assert.equal(await use(approve([tenantId,actorId,release,revoked,enabled,false,true,at+5000])),false)
})
