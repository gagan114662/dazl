// Protected server control-plane module; never import from an ordinary request
// handler. Neither scheduling nor a provider request occurs here.
import type Database from 'better-sqlite3'
import type { Param, Tx, TxBody } from '../db/client.ts'
import { scanQuota } from '../plans.ts'
import { strictLocalTopologySupported } from '../scan/qa-provider-policy.ts'
import { pickVendor } from '../scan/runner.ts'
import { countActiveJobs, createQueryJob, pinAdmittedStrictJob } from '../scan/store.ts'
import { authorizeScorecardSubject, registerScorecardTicket, SCORECARD_ANCHOR, scorecardRawBudget, type ScorecardSubjectInput, type VerifiedScorecardTicket } from './scorecard-admission.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'

const refusal = () => new Error('scorecard_admission_refused')

// SQLite's existing pin API requires a synchronous outer IMMEDIATE
// transaction. Use the same raw handle and only repository Tx statements;
// no nested transaction, await, context launch or callback during commit.
function registerInCurrentSqliteTx(db: Database.Database, ticket: VerifiedScorecardTicket, proof: NonNullable<ReturnType<typeof authorizeScorecardSubject>>, clock: () => number): boolean {
  if (!db.inTransaction) throw refusal()
  const t: Tx = {
    kind: 'sqlite',
    *get<T>(sql: string, params: Param[] = []): TxBody<T|undefined> { return (yield {op:'get',sql,params}) as T|undefined },
    *all<T>(sql: string, params: Param[] = []): TxBody<T[]> { return (yield {op:'all',sql,params}) as T[] },
    *run(sql: string, params: Param[] = []): TxBody<{changes:number}> { return (yield {op:'run',sql,params}) as {changes:number} },
  }
  const g = registerScorecardTicket(t,ticket,requireScorecardWorkspace,proof,clock)
  let n = g.next()
  while (!n.done) {
    const {op,sql,params} = n.value, stmt = db.prepare(sql)
    n = g.next(op === 'run' ? {changes:stmt.run(...params).changes} : op === 'all' ? stmt.all(...params) : stmt.get(...params))
  }
  return n.value
}

/** Requires a verified protected issuer ticket whose exact approved job bytes
 * are checked in memory; only an opaque primary financial anchor is stored.
 * The caller must still reserve the normal strict-local worker slot before
 * admission and submit committed jobs only to the guarded private dispatcher.
 * Never returns private input text, signed material, or an authorization to
 * dispatch outside the canonical spend guard. */
export function armProtectedScorecardJobSqlite(db: Database.Database, ticket: VerifiedScorecardTicket,
  input: ScorecardSubjectInput, clock = Date.now): {ok:true; jobId:string} | {ok:false} {
  if (db.inTransaction || db.pragma('foreign_keys', {simple:true}) !== 1 || !strictLocalTopologySupported('sqlite') || ticket?.attempt !== 1 ||
      typeof input?.query !== 'string' || input.query.trim().length < 3 || !input.icp) return {ok:false}
  try {
    return db.transaction(() => {
      if (pickVendor(db,ticket.tenantId) !== 'anthropic' || countActiveJobs(db,ticket.tenantId) >= 1 ||
          !scanQuota(db,ticket.tenantId).allowed) throw refusal()
      const proof = authorizeScorecardSubject(ticket,input,clock)
      if (!proof) throw refusal()
      const budget = scorecardRawBudget()
      // Use the existing non-targeting query-job display defaults. Only the
      // generic label enters this transaction; erase even that query field
      // before commit, and never pass the licensed private subject here.
      createQueryJob(db,ticket.tenantId,{id:ticket.jobId,query:SCORECARD_ANCHOR.business_name,runBudget:budget})
      if (db.prepare("UPDATE scan_jobs SET query=NULL WHERE id=? AND user_id=? AND status='pending' AND attempts=0 AND query=?")
        .run(ticket.jobId,ticket.tenantId,SCORECARD_ANCHOR.business_name).changes !== 1) throw refusal()
      pinAdmittedStrictJob(db,ticket.tenantId,ticket.jobId,budget)
      if (!registerInCurrentSqliteTx(db,ticket,proof,clock)) throw refusal()
      const marked = db.prepare(`UPDATE scan_jobs SET company_scorecard_claim_nonce=?
        WHERE id=? AND user_id=? AND attempts=1 AND status='running' AND error IS NULL AND funded_by='user'
          AND company_scorecard_claim_nonce IS NULL AND company_scorecard_dispatch_started_at IS NULL`)
        .run(ticket.nonce,ticket.jobId,ticket.tenantId)
      if (marked.changes !== 1) throw refusal()
      return {ok:true as const,jobId:ticket.jobId}
    }).immediate()
  } catch { return {ok:false} }
}
