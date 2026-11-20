import Database from 'better-sqlite3'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import {preflightProtectedStagingScorecard as check} from '../lib/company-first/scorecard-staging-preflight.ts'
test('same-process staging stamp, private DB and exact enabled owner, no writes or launch',()=>{
 const webRoot=mkdtempSync(join(tmpdir(),'staging-preflight-'))
 const privateSqlitePath=join(webRoot,'private.sqlite')
 const release='a'.repeat(40), workspaceRevision='b'.repeat(64)
 const host={webRoot,privateSqlitePath,servingRelease:release,runtime:'staging' as const}
 const scope={release,workspaceRevision,tenantId:'fixture',actorId:'owner'}, env={DAZL_ENV:'staging'}
 writeFileSync(join(webRoot,'.build-commit'),release+'\n')
 const db=new Database(privateSqlitePath)
 try{
  db.exec(`CREATE TABLE organizations(id TEXT,company_first_scorecard_enabled INTEGER,company_first_scorecard_revision TEXT);
   CREATE TABLE memberships(tenant_id TEXT,member_id TEXT,role TEXT); CREATE TABLE users(id TEXT);
   CREATE TABLE tenant_tombstones(deleted_tenant TEXT); INSERT INTO users VALUES('owner');
   INSERT INTO memberships VALUES('fixture','owner','owner');`)
  db.prepare("INSERT INTO organizations VALUES ('fixture',0,?)").run(workspaceRevision)
  assert.deepEqual(check(db,host,scope,env),{state:'held',reason:'workspace'})
  db.exec('UPDATE organizations SET company_first_scorecard_enabled=1')
  assert.deepEqual(check(db,host,scope,env),{state:'preflight_passed'})
  assert.deepEqual(check(db,host,scope,{...env,DATABASE_URL:'dummy'}),{state:'held',reason:'environment'})
  assert.deepEqual(check(db,{...host,servingRelease:'c'.repeat(40)},scope,env),{state:'held',reason:'release'})
  assert.deepEqual(check(db,{...host,privateSqlitePath:join(webRoot,'.build-commit')},scope,env),{state:'held',reason:'database'})
  assert.deepEqual(check(db,host,{...scope,actorId:'foreign'},env),{state:'held',reason:'workspace'})
  db.exec("INSERT INTO tenant_tombstones VALUES('owner')")
  assert.deepEqual(check(db,host,scope,env),{state:'held',reason:'workspace'})
 }finally{db.close();rmSync(webRoot,{recursive:true,force:true})}
})
