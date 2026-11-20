import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { deleteTenant, exportTenant, tenantScope } from '../lib/tenant/lifecycle.ts'
import { migrateTenantLifecycle } from '../lib/db/tenant-guard.ts'
import { SCORECARD_ADMISSION_DDL } from '../lib/company-first/scorecard-admission.ts'

bothEngines('company-first private scorecard database metadata is erased, not exported; canonical cost follows retention policy',async ({db,raw})=>{
  const tables=['company_scorecard_cohorts','company_scorecard_claims','company_scorecard_calls']
  const ids=['scorecard-for-delete','scorecard-not-deleted']
  for(const ddl of SCORECARD_ADMISSION_DDL) await db.run(ddl)
  if (raw) migrateTenantLifecycle(raw)
  for(const id of ids){
    await db.run("INSERT INTO users (id,email,name,business_name,password_hash,salt) VALUES (?,?,'','','','')",[id,id+'@example.test'])
    await db.run("INSERT INTO organizations (id,kind,created_by,created_at) VALUES (?,'personal',?,1)",[id,id])
    await db.run("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)",[id,id])
    await db.run("INSERT INTO company_scorecard_cohorts (cohort,tenant_id,actor_id,workspace_revision,release,roster,next_ordinal) VALUES (?,?,?,'revision','release','[]',1)",
      [id,id,id])
    await db.run("INSERT INTO company_scorecard_claims (nonce,tenant_id,cohort,ordinal,job_id,subject_mac,attempt,expires_at,lane,status) VALUES (?,?,?,1,?,?,1,2,0,'complete')",
      [id,id,id,id,'a'.repeat(64)])
    await db.run("INSERT INTO scan_spend_calls (id,user_id,scan_job_id,attempt,kind,reserve_usd,actual_usd,status,created_at,settled_at) VALUES (?,?,?,1,'llm.anthropic',1,1,'settled',1,2)",
      [id,id,id])
    await db.run('INSERT INTO company_scorecard_calls (reservation_id,tenant_id,nonce,lane) VALUES (?,?,?,0)',[id,id,id])
  }
  const scope=await tenantScope(db)
  const exported=await exportTenant(db,ids[0])
  for(const table of tables){
    assert.ok(scope.some(s=>s.table===table&&s.how==='direct'&&s.col==='tenant_id'))
    assert.equal(exported.tables[table],undefined)
    assert.ok(exported.excluded[table])
  }
  await assert.rejects(deleteTenant(db,ids[0],{requestedBy:'fixture',policy:{suppressions:'erase',retainTables:[tables[2]]}}),/always deleted/)
  const result=await deleteTenant(db,ids[0],{requestedBy:'fixture',policy:{suppressions:'erase',retainTables:['scan_spend_calls']}})
  assert.equal(result.state,'completed')
  for(const t of tables) assert.deepEqual((await db.all<{tenant_id:string}>(`SELECT tenant_id FROM ${t}`)).map(r=>r.tenant_id),[ids[1]])
  assert.equal((await db.all('SELECT id FROM scan_spend_calls')).length,2)
})
