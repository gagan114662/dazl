// Isolated fixtures (in-memory DB, synthetic tenants). No production data, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrateScan, createJob, exportLeads } from '../lib/scan/store.ts'
import { storeEvidenceCopy, purgeTenantEvidence, evidenceCopyForLead, evidencePurgedAt, purgeExpiredEvidenceCopies } from '../lib/scan/evidence-copies.ts'
import { exportEvidenceOrigin } from '../lib/scan/evidence-origin.ts'

const hex = () => randomBytes(12).toString('hex')
const page = (n: string, text = `evidence text for ${n} `.repeat(30)) => ({ url: `https://src.example/${n}`, title: `Title ${n}`, text, sha256: createHash('sha256').update(text).digest('hex'), heldAt: 1_700_000_000 })
function fixture(file = ':memory:') {
  const db = new Database(file); migrateScan(db)
  const mk = (tenant: string, n: string) => {
    const job = createJob(db, tenant, { business_name: tenant, industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status='running', attempts=1 WHERE id=?").run(job)
    const copy = storeEvidenceCopy(db, tenant, job, 1, page(n)); const lead = hex()
    db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,confidence,evidence_origin,own_fetch_failure,evidence_copy_id) VALUES (?,?,?,?,?,70,'tinyfish_copy','blocked_by_site',?)").run(lead, job, `${n}Co`, 's', `https://src.example/${n}`, copy)
    return { job, copy, lead }
  }
  return { db, a: mk('A', 'a1'), a2: mk('A', 'a2'), b: mk('B', 'b1') }
}
const REQ = { tenantId: 'A', confirmTenantId: 'A', operator: 'ops-jane', reason: 'Written deletion request, ticket 4411' }

test('ordinary use stays immutable: no edit, no delete of retained evidence, no audit edits; the delete gate is closed', () => {
  const { db } = fixture()
  assert.throws(() => db.prepare('UPDATE lead_evidence_copies SET text = ?').run('x'), /immutable/)
  assert.throws(() => db.prepare("DELETE FROM lead_evidence_copies WHERE tenant_id = 'A'").run(), /retention period/)
  assert.throws(() => db.prepare('DELETE FROM lead_evidence_copies').run(), /retention period/)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM evidence_purge_gate').get() as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM lead_evidence_copies').get() as { n: number }).n, 3)
})
test('refused without confirmation, operator or reason; dry run changes nothing', () => {
  const { db } = fixture()
  for (const bad of [{ ...REQ, confirmTenantId: 'B' }, { ...REQ, confirmTenantId: '' }, { ...REQ, operator: '' }, { ...REQ, reason: 'short' }, { ...REQ, tenantId: '', confirmTenantId: '' }])
    assert.throws(() => purgeTenantEvidence(db, { ...bad, execute: true }), /purge refused/)
  const dry = purgeTenantEvidence(db, REQ)
  assert.deepEqual([dry.dryRun, dry.copies, dry.leads, dry.auditId], [true, 2, 2, null])
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM lead_evidence_copies').get() as { n: number }).n, 3)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM evidence_purge_audit').get() as { n: number }).n, 0)
})
test('an authorized purge removes ONLY the named tenant\'s evidence, audits it, and leaves the other tenant intact and recoverable', () => {
  const { db, a, a2, b } = fixture()
  const bBefore = evidenceCopyForLead(db, 'B', b.lead)!
  const r = purgeTenantEvidence(db, { ...REQ, execute: true })
  assert.deepEqual([r.dryRun, r.copies, r.leads], [false, 2, 2]); assert.ok(r.auditId)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM lead_evidence_copies WHERE tenant_id = 'A'").get() as { n: number }).n, 0)
  assert.deepEqual(evidenceCopyForLead(db, 'B', b.lead), bBefore, 'tenant B: row, title, text and hashes untouched')
  assert.equal(evidenceCopyForLead(db, 'B', b.lead)!.integrity, 'ok')
  assert.equal((db.prepare('SELECT evidence_copy_id FROM leads WHERE id = ?').get(b.lead) as { evidence_copy_id: string }).evidence_copy_id, b.copy, 'B\'s link and no purge mark')
  assert.equal(evidencePurgedAt(db, 'B', b.lead), null)
  const audit = db.prepare('SELECT * FROM evidence_purge_audit').all() as Record<string, unknown>[]
  assert.equal(audit.length, 1); assert.deepEqual([audit[0].tenant_id, audit[0].operator, audit[0].copies_deleted, audit[0].leads_unlinked], ['A', 'ops-jane', 2, 2]); assert.match(String(audit[0].reason), /ticket 4411/)
  assert.ok(Number(audit[0].bytes_deleted) > 0)
  // the gate is closed again and the protection is back
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM evidence_purge_gate').get() as { n: number }).n, 0)
  assert.throws(() => db.prepare('DELETE FROM lead_evidence_copies').run(), /retention period/)
  assert.throws(() => db.prepare('UPDATE evidence_purge_audit SET operator = ?').run('x'), /append-only/); assert.throws(() => db.prepare('DELETE FROM evidence_purge_audit').run(), /append-only/)
  // A's leads: link gone, marked purged; recovery and labels say so
  for (const l of [a.lead, a2.lead]) {
    assert.equal(evidenceCopyForLead(db, 'A', l), null); assert.ok(evidencePurgedAt(db, 'A', l))
    assert.equal((db.prepare('SELECT evidence_copy_id FROM leads WHERE id = ?').get(l) as { evidence_copy_id: string | null }).evidence_copy_id, null)
  }
  const row = (exportLeads(db, 'A') as Record<string, unknown>[])[0]
  const label = exportEvidenceOrigin(row as never)
  assert.match(label, /copy of the page fetched by TinyFish/); assert.match(label, /deleted at the account owner's request/); assert.match(label, /can no longer be shown or re-checked/)
  assert.doesNotMatch(exportEvidenceOrigin({ ...(exportLeads(db, 'B')[0] as object), evidence_purged_at: null } as never), /deleted/)
})
test('a second purge is harmless and audited; expired-row cleanup still works for everyone', () => {
  const { db, b } = fixture()
  purgeTenantEvidence(db, { ...REQ, execute: true }); const again = purgeTenantEvidence(db, { ...REQ, execute: true })
  assert.deepEqual([again.copies, again.leads], [0, 0]); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM evidence_purge_audit').get() as { n: number }).n, 2)
  assert.equal(purgeExpiredEvidenceCopies(db), 0); assert.ok(evidenceCopyForLead(db, 'B', b.lead))
})
test('a failure inside the purge rolls everything back and leaves the gate closed', () => {
  const { db } = fixture()
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON evidence_purge_audit BEGIN SELECT RAISE(ABORT, 'audit write failed'); END")
  assert.throws(() => purgeTenantEvidence(db, { ...REQ, execute: true }), /audit write failed/)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM lead_evidence_copies WHERE tenant_id = 'A'").get() as { n: number }).n, 2, 'no audit, no deletion')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM evidence_purge_gate').get() as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM leads WHERE evidence_purged_at IS NOT NULL').get() as { n: number }).n, 0)
})
test('operator script: dry run by default, deletes only with --execute, refuses a wrong confirmation (throwaway file DB)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'purge-')); const file = join(dir, 'x.db')
  try {
    const f = fixture(file); f.db.close()
    const run = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/purge-tenant-evidence.mts', '--tenant', 'A', '--operator', 'ops-jane', '--reason', 'Written deletion request, ticket 4411', ...a], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, DAZL_DB_PATH: file }, encoding: 'utf8' })
    const count = () => { const d = new Database(file); try { return (d.prepare('SELECT COUNT(*) AS n FROM lead_evidence_copies').get() as { n: number }).n } finally { d.close() } }
    const wrong = run('--confirm', 'B', '--execute'); assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /purge refused/); assert.equal(count(), 3)
    const dry = run('--confirm', 'A'); assert.equal(dry.status, 0); assert.match(dry.stdout, /"dryRun":true/); assert.equal(count(), 3)
    const real = run('--confirm', 'A', '--execute'); assert.equal(real.status, 0, real.stderr); assert.match(real.stdout, /"dryRun":false/); assert.equal(count(), 1, 'only tenant B\'s copy is left')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
