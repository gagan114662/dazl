// Read-only same-process staging preflight. It does not read keys, tickets,
// fixtures or network. It never arms work and must not be mounted as a route.
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type Database from 'better-sqlite3'
import { strictLocalTopologySupported } from '../scan/qa-provider-policy.ts'
type Scope=Readonly<{ release:string;tenantId:string;actorId:string;workspaceRevision:string }>
type Host=Readonly<{
  // Provisioned by the staging supervisor, not request args or inferred
  // from a generic env boolean. The same-process bootstrap must own both.
  webRoot:string; privateSqlitePath:string; servingRelease:string; runtime:'staging'
}>
type Env=Readonly<Record<string,string|undefined>>
export function preflightProtectedStagingScorecard(db:Database.Database,host:Host,scope:Scope,env:Env=process.env){
  const held=(reason:'environment'|'release'|'database'|'workspace')=>({state:'held' as const,reason})
  try{
    if(host.runtime!=='staging'||env.DAZL_ENV!=='staging'||env.DATABASE_URL||
       !strictLocalTopologySupported('sqlite',env)||db.inTransaction)return held('environment')
    if(!/^[0-9a-f]{40}$/.test(scope.release)||host.servingRelease!==scope.release||!isAbsolute(host.webRoot))return held('release')
    const mark=join(host.webRoot,'.build-commit'), file=lstatSync(mark)
    if(!file.isFile()||file.size>64||readFileSync(mark,'utf8').trim()!==scope.release)return held('release')
    if(!isAbsolute(host.privateSqlitePath)||!lstatSync(host.privateSqlitePath).isFile()||
       realpathSync(host.privateSqlitePath)!==host.privateSqlitePath||db.pragma('foreign_keys',{simple:true})!==1)return held('database')
    const main=db.prepare('PRAGMA database_list').all() as {name:string;file:string}[]
    if(main.filter(x=>x.name!=='temp').length!==1||main.find(x=>x.name==='main')?.file!==host.privateSqlitePath)return held('database')
    if(!/^[0-9a-f]{64}$/.test(scope.workspaceRevision)||!db.prepare(`SELECT 1 FROM organizations o
      JOIN memberships m ON m.tenant_id=o.id AND m.role='owner'
      JOIN users u ON u.id=m.member_id WHERE o.id=? AND u.id=?
      AND o.company_first_scorecard_enabled=1 AND o.company_first_scorecard_revision=?
      AND NOT EXISTS (SELECT 1 FROM tenant_tombstones d WHERE d.deleted_tenant IN(o.id,u.id))`).get(scope.tenantId,scope.actorId,scope.workspaceRevision))
      return held('workspace')
    // Not authorization to execute: issuer, reviewed binder and canonical
    // verifier must still be present and the launcher rechecks under lock.
    return {state:'preflight_passed' as const}
  }catch{return held('database')}
}
