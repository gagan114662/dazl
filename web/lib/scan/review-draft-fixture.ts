import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createVerificationFixture } from './verification-fixture.ts'
import { createSequence } from '../outreach/sequences.ts'

// Synthetic provenance display only. The reserved .invalid address is permanently
// suppressed; test=0 prevents the own-inbox evidence exemption. No approval, send,
// provider call, claimed human confirmation, or external contact is created.
export const REVIEW_DRAFT_COMPANY = 'dazl review-to-draft fixture (test only)'
export function createReviewDraftFixture(db: Database.Database, tenantId: string) {
  createVerificationFixture(db, tenantId) // existing tenant/allowlist gate
  return db.transaction(() => {
    const existing = db.prepare('SELECT l.id,l.scan_job_id FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE j.user_id=? AND j.business_name=? AND l.company=?').get(tenantId, REVIEW_DRAFT_COMPANY, REVIEW_DRAFT_COMPANY) as {id:string;scan_job_id:string}|undefined
    if (existing) return {jobId:existing.scan_job_id,leadId:existing.id,created:false}
    const leadId=randomBytes(12).toString('hex'), messageId=randomBytes(12).toString('hex')
    const email=`fixture-${leadId}@dazl.invalid`
    const signal='Synthetic display fixture only. No real buyer, published contact, verified quote or buying intent.'
    // Use the same supported fixture running-job insertion convention.
    // A completed job cannot legally return to running, so create a dedicated job.
    const jobId=randomBytes(12).toString('hex')
    db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status) VALUES(?,?,?,'test only','test only','running')").run(jobId,tenantId,REVIEW_DRAFT_COMPANY)
    db.prepare("INSERT INTO leads(id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,review_reason,source_kind) VALUES(?,?,?,?,?,'https://dazl.ai/test-only-verification-fixture',?,'quote_unconfirmed','test')").run(leadId,jobId,REVIEW_DRAFT_COMPANY,email,signal,signal)
    db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,test) VALUES(?,?,?,?,?,?,0)").run(messageId,tenantId,leadId,email,'Test-only provenance display, never send',`${signal}\nThis draft was seeded by the labelled display fixture, not created from a real published contact.`)
    const sequenceId=createSequence(db,tenantId,messageId,{businessName:'Test-only fixture'})
    // Do not use suppress(): its normal lifecycle side effects would skip the
    // display drafts. Keep the safety rail while preserving draft-state pixels.
    db.prepare("INSERT INTO suppressions(tenant_id,email,reason) VALUES(?,?,'manual')").run(tenantId,email)
    db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(jobId)
    return {jobId,leadId,messageId,sequenceId,created:true}
  })()
}

export function deleteReviewDraftFixtures(db:Database.Database,tenantId:string) {
  const jobs=db.prepare('SELECT id FROM scan_jobs WHERE user_id=? AND business_name=? AND industry=\'test only\' AND location=\'test only\'').all(tenantId,REVIEW_DRAFT_COMPANY) as {id:string}[]
  for(const job of jobs) {
    const leads=db.prepare('SELECT id,contact FROM leads WHERE scan_job_id=? AND company=? AND source_kind=\'test\'').all(job.id,REVIEW_DRAFT_COMPANY) as {id:string;contact:string}[]
    for(const lead of leads) {
      db.prepare('DELETE FROM sequence_steps WHERE tenant_id=? AND sequence_id IN (SELECT id FROM sequences WHERE tenant_id=? AND lead_id=?)').run(tenantId,tenantId,lead.id)
      db.prepare('DELETE FROM sequences WHERE tenant_id=? AND lead_id=?').run(tenantId,lead.id)
      db.prepare('DELETE FROM outreach_messages WHERE tenant_id=? AND lead_id=?').run(tenantId,lead.id)
      db.prepare('DELETE FROM leads WHERE id=? AND scan_job_id=?').run(lead.id,job.id)
      // Suppression is intentionally retained: cleanup never unsuppresses an address.
    }
    db.prepare('DELETE FROM scan_jobs WHERE id=? AND user_id=?').run(job.id,tenantId)
  }
}
