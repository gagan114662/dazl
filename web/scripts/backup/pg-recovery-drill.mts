// Postgres recovery drill for one pg-backup.mts dump (issue #360, part 3; docs/RECOVERY.md "Postgres cutover"): content
// against the sidecar fingerprint in a scratch database this drill creates and drops, every registered ciphertext under
// the RECOVERED key (--key-file, the key's own storage), and the send-safety counts to reconcile before sending is
// re-enabled. Timed: RPO at drill = the dump's age, measured RTO = the drill's wall time. The scratch database holds
// real data; it is dropped at the end unless --keep-scratch.
//   node --experimental-strip-types scripts/backup/pg-recovery-drill.mts --backup FILE.dump --key-file FILE \
//     --admin-url postgres://user@127.0.0.1:5432/postgres [--report OUT.json] [--keep-scratch]
// --admin-url: a server where this role may CREATE DATABASE; the drill only creates and drops its own randomly named
// database there. Exit 0 = every step passed; 1 = a step failed (named); 2 = refused (usage, guards).
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { pgRecoveryDrill } from './pg-lib.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const refuse = (why: string): never => { console.error(`pg-recovery-drill: refused: ${why}`); process.exit(2) }
const backup = arg('--backup'), keyFile = arg('--key-file'), adminUrl = arg('--admin-url'), reportPath = arg('--report')
if (!backup || !keyFile || !adminUrl) refuse('usage: pg-recovery-drill.mts --backup FILE.dump --key-file FILE --admin-url URL [--report OUT.json] [--keep-scratch]')
if ((statSync(keyFile!).mode & 0o077) !== 0) refuse('--key-file must not be readable by group or others (chmod 600)')
const master = Buffer.from(readFileSync(keyFile!, 'utf8').trim(), 'base64')
if (master.length !== 32) refuse('--key-file must hold base64 of exactly 32 bytes')

const report = await pgRecoveryDrill({ backup: backup!, master, adminUrl: adminUrl!, keep: process.argv.includes('--keep-scratch') })
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
for (const s of report.steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step} (${s.ms} ms) ${JSON.stringify(s.detail)}`)
console.log(`${report.ok ? 'pg recovery drill passed' : 'PG RECOVERY DRILL FAILED'}: RPO at drill ${report.rpo_at_drill_s ?? '?'} s, measured ${report.measured_rto_ms} ms; app ${report.app}${reportPath ? `; report ${reportPath}` : ''}`)
process.exit(report.ok ? 0 : 1)
