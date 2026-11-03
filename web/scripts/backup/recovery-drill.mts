// Full-service recovery drill for one backup (issue #360; docs/RECOVERY.md). Extends restore-drill.ts (content) with
// the two things a database file alone does not prove, and times every step:
//   1. content: restoreDrill() into an isolated work directory (sidecar sha256, integrity, schema, row counts and full
//      content hashes, backup untouched);
//   2. key recovery: every registered ciphertext (lib/secrets-rewrap.ts REWRAP_COLUMNS: LLM keys, connector secrets,
//      Gmail refresh tokens) decrypts in full under the RECOVERED master key, read from --key-file (the key's own,
//      separate storage). Plaintexts are dropped at once; only counts are reported;
//   3. send safety: what must be reconciled before sending may be re-enabled on a restored store: claims still
//      'sending', 'uncertain' sends, unexpired worker leases, tenants with autopilot on (counts only);
//   4. app readability (--app <built web dir>): that release's production build is started on the restored copy with
//      sending disabled (AUTOPILOT_KILL=1, no tick secret so /api/internal/tick is 404, and the network fence: no
//      connection leaves the machine, so no email, Stripe, Gmail or LLM call is possible). Required: /api/ready ok, the
//      tick refused, and for the tenant with the most leads a session (created in the restored COPY only) reads its scans,
//      its leads and its key status, and /app/leads renders.
// RPO at drill time = the backup's age (sidecar createdAt). Measured RTO = the drill's wall time from start to app ready;
// a real recovery adds provisioning the host and moving the file. The restored copy holds real data: the work
// directory is created mode 700, must not exist beforehand, and is deleted at the end unless --keep-work-dir.
//   node --experimental-strip-types scripts/backup/recovery-drill.mts --backup FILE --key-file FILE --work-dir DIR \
//     [--app WEB_DIR] [--report OUT.json] [--keep-work-dir]
// Exit 0 = every step passed; 1 = a step failed (named); 2 = refused (usage, guards).
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { restoreDrill } from './lib.ts'
import { decryptSecret } from '../../lib/secrets.ts'
import { REWRAP_COLUMNS } from '../../lib/secrets-rewrap.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const refuse = (why: string): never => { console.error(`recovery-drill: refused: ${why}`); process.exit(2) }
const backup = arg('--backup'), keyFile = arg('--key-file'), workArg = arg('--work-dir'), app = arg('--app'), reportPath = arg('--report')
const keep = process.argv.includes('--keep-work-dir')
if (!backup || !keyFile || !workArg) refuse('usage: recovery-drill.mts --backup FILE --key-file FILE --work-dir DIR [--app WEB_DIR] [--report OUT.json] [--keep-work-dir]')
const work = path.resolve(workArg!)
if (existsSync(work)) refuse(`${work} already exists: the drill only uses a directory it creates`)
for (const v of ['DB_PATH', 'PROD_DB_PATH']) {
  const live = process.env[v]; if (!live) continue
  if (path.resolve(live) === path.resolve(backup!)) refuse(`--backup is ${v} itself: drill a backup file, never the live database`)
  if ((work + path.sep).startsWith(path.dirname(path.resolve(live)) + path.sep)) refuse(`--work-dir is inside ${v}'s directory`)
}
// the recovered key: base64 of 32 bytes in a file only its owner can read
const keySt = statSync(keyFile!)
if ((keySt.mode & 0o077) !== 0) refuse('--key-file must not be readable by group or others (chmod 600)')
const master = Buffer.from(readFileSync(keyFile!, 'utf8').trim(), 'base64')
if (master.length !== 32) refuse('--key-file must hold base64 of exactly 32 bytes')
if (app && !existsSync(path.join(path.resolve(app), '.next/BUILD_ID'))) refuse(`--app ${app} has no production build`)

type Step = { step: string; ok: boolean; ms: number; detail: Record<string, unknown> }
const steps: Step[] = []
const t0 = Date.now()
const step = async (name: string, f: () => Promise<{ ok: boolean; detail: Record<string, unknown> }>) => {
  const s = Date.now()
  try { const r = await f(); steps.push({ step: name, ok: r.ok, ms: Date.now() - s, detail: r.detail }); return r.ok }
  catch (e) { steps.push({ step: name, ok: false, ms: Date.now() - s, detail: { error: e instanceof Error ? e.message : String(e) } }); return false }
}
mkdirSync(work, { mode: 0o700 })
const restoreDir = path.join(work, 'restore')
let restored: string | null = null
let backupCreatedAt: string | null = null
try { backupCreatedAt = JSON.parse(readFileSync(`${backup}.json`, 'utf8')).createdAt ?? null } catch { /* no sidecar: restoreDrill warns */ }

const contentOk = await step('content', async () => {
  const r = await restoreDrill({ backupPath: backup!, workDir: restoreDir, keepWorkDir: true })
  restored = r.workDirKept ? path.join(r.workDirKept, 'restored.db') : null
  return { ok: r.verdict === 'pass' && !!restored, detail: { verdict: r.verdict, reasons: r.reasons, warnings: r.warnings, sidecar_verified: r.sidecarVerified, tables: r.tablesChecked, rows: r.restoredMetrics?.tables.reduce((a, t) => a + (t.rows ?? 0), 0) ?? null, backup_unchanged: r.backupUnchangedAfterDrill } }
})

if (contentOk && restored) {
  await step('key recovery', async () => {
    const db = new Database(restored!, { readonly: true })
    const columns: Record<string, { total: number; decrypted: number; failed: number }> = {}
    try {
      for (const spec of REWRAP_COLUMNS) {
        const c = columns[`${spec.table}.${spec.column}`] = { total: 0, decrypted: 0, failed: 0 }
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(spec.table)) continue
        for (const row of db.prepare(`SELECT ${spec.pk.map(k => `"${k}"`).join(', ')}, "${spec.column}" AS blob FROM "${spec.table}" WHERE "${spec.column}" IS NOT NULL`).all() as Record<string, string>[]) {
          c.total++
          try { decryptSecret(row.blob, spec.ctx(row), master); c.decrypted++ } catch { c.failed++ } // plaintext discarded
        }
      }
    } finally { db.close() }
    const total = Object.values(columns).reduce((a, c) => a + c.total, 0), failed = Object.values(columns).reduce((a, c) => a + c.failed, 0)
    return { ok: failed === 0 && total > 0, detail: { columns, total, failed, ...(total === 0 ? { note: 'no encrypted rows: the key is not proven by this backup' } : {}) } }
  })

  await step('send safety (reconcile before enabling sending)', async () => {
    const db = new Database(restored!, { readonly: true })
    const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
    const n = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n
    const now = Math.floor(Date.now() / 1000)
    try {
      const detail = {
        messages_sending: has('outreach_messages') ? n("SELECT count(*) AS n FROM outreach_messages WHERE status = 'sending'") : 0,
        messages_uncertain: has('outreach_messages') ? n("SELECT count(*) AS n FROM outreach_messages WHERE status = 'uncertain'") : 0,
        sequence_steps_unresolved: has('sequence_steps') ? n("SELECT count(*) AS n FROM sequence_steps WHERE status IN ('sending','uncertain')") : 0,
        followups_unresolved: has('followup_messages') ? n("SELECT count(*) AS n FROM followup_messages WHERE status IN ('sending','uncertain')") : 0,
        leases_unexpired_at_drill: has('app_leases') ? n('SELECT count(*) AS n FROM app_leases WHERE expires_at > ?', now) : 0,
        tenants_autopilot_on: has('autopilot_settings') ? n('SELECT count(*) AS n FROM autopilot_settings WHERE enabled = 1 AND paused = 0') : 0,
      }
      // a report, not a failure: these must be reconciled (resolveUncertain, lease expiry) before sending is re-enabled
      return { ok: true, detail }
    } finally { db.close() }
  })

  if (app) {
    await step('app readability (sending disabled)', async () => {
      const web = path.resolve(app)
      // a session for the tenant with the most leads, in the restored COPY only
      const db = new Database(restored!)
      let tenant: { id: string; leads: number } | undefined
      const token = randomBytes(32).toString('hex')
      try {
        tenant = db.prepare('SELECT u.id, count(l.id) AS leads FROM users u JOIN scan_jobs j ON j.user_id = u.id LEFT JOIN leads l ON l.scan_job_id = j.id GROUP BY u.id ORDER BY leads DESC LIMIT 1').get() as typeof tenant
        if (tenant) db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), tenant.id, Math.floor(Date.now() / 1000) + 3600)
      } finally { db.close() }
      const port = await new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)) }) })
      const base = `http://127.0.0.1:${port}`
      const env = {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', DB_PATH: restored!, PUBLIC_BASE_URL: base,
        AUTOPILOT_KILL: '1', SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', STRIPE_PRICE_PRO: 'price_drill',
        // the fence deletes *KEY*/*SECRET* names; test/smoke/stripe-test-env.mjs restores these neutral ones
        SMOKE_MASTER_B64: master.toString('base64'), SMOKE_STRIPE_SK: 'sk_test_drill' + randomBytes(6).toString('hex'), SMOKE_STRIPE_WHSEC: 'whsec_' + randomBytes(12).toString('hex'),
        NODE_OPTIONS: `--experimental-strip-types --import ${path.join(web, 'test/helpers/net-fence.ts')} --import ${path.join(web, 'test/smoke/stripe-test-env.mjs')}`,
      } as unknown as NodeJS.ProcessEnv
      const started = Date.now()
      const server = spawn(process.execPath, [path.join(web, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: web, env, stdio: ['ignore', 'ignore', 'ignore'] })
      const get = (p: string, init: RequestInit = {}) => fetch(base + p, { redirect: 'manual', ...init, headers: { cookie: `dazl_session=${token}`, ...(init.headers ?? {}) } }).then(async r => ({ status: r.status, body: await r.text() }))
      try {
        let readyMs: number | null = null
        for (let i = 0; i < 300 && server.exitCode === null; i++) {
          try { const r = await fetch(`${base}/api/ready`); if (r.status === 200 && (await r.json()).ok === true) { readyMs = Date.now() - started; break } } catch { /* starting */ }
          await new Promise(r => setTimeout(r, 200))
        }
        const tick = await get('/api/internal/tick', { method: 'POST' })
        const detail: Record<string, unknown> = { ready_ms: readyMs, tick_status: tick.status, tenant_leads_in_db: tenant?.leads ?? 0 }
        let ok = readyMs !== null && tick.status === 404
        if (tenant) {
          const jobs = await get('/api/scan/jobs')
          const ids = [...new Set(jobs.body.match(/\b[0-9a-f]{24}\b/g) ?? [])]
          let leadsRead = 0
          for (const id of ids) { const l = await get(`/api/leads?job_id=${id}`); if (l.status === 200) { try { const j = JSON.parse(l.body); leadsRead += Array.isArray(j.leads) ? j.leads.length : 0 } catch { /* counted as 0 */ } } }
          const keys = await get('/api/settings/llm-key'), page = await get('/app/leads')
          Object.assign(detail, { scans_status: jobs.status, scans_read: ids.length, leads_read: leadsRead, key_status: keys.status, leads_page_status: page.status })
          ok &&= jobs.status === 200 && keys.status === 200 && page.status === 200 && (tenant.leads === 0 || leadsRead > 0)
        } else detail.note = 'no tenant with scans in this backup: reads not checked'
        return { ok, detail }
      } finally { server.kill('SIGTERM') }
    })
  }
}

const report = {
  kind: 'dazl recovery drill', version: 1, started_at: new Date(t0).toISOString(), backup: path.basename(backup!),
  backup_created_at: backupCreatedAt, rpo_at_drill_s: backupCreatedAt ? Math.round((t0 - Date.parse(backupCreatedAt)) / 1000) : null,
  measured_rto_ms: Date.now() - t0, sending: app ? 'disabled: AUTOPILOT_KILL=1, no tick secret, network fence' : 'app not started',
  ok: steps.length > 0 && steps.every(s => s.ok) && (!app || steps.some(s => s.step.startsWith('app'))), steps,
  work_dir: keep ? work : null,
}
if (!keep) rmSync(work, { recursive: true, force: true })
const json = JSON.stringify(report, null, 2) + '\n'
if (reportPath) writeFileSync(reportPath, json, { mode: 0o600 })
for (const s of steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step} (${s.ms} ms) ${JSON.stringify(s.detail)}`)
console.log(`${report.ok ? 'recovery drill passed' : 'RECOVERY DRILL FAILED'}: RPO at drill ${report.rpo_at_drill_s ?? '?'} s, measured ${report.measured_rto_ms} ms${reportPath ? `; report ${reportPath}` : ''}`)
process.exit(report.ok ? 0 : 1)
