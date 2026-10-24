import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Regression for the nested approve() inside approveSequence's outer transaction under cross-process write contention.
// The script (test/support) uses temp WAL files and a child process that holds the write lock. No keys, no network, no sends.
test('approveSequence with nested approve(): happy, atomic rollback, timeout-0 BUSY without partial state, default timeout waits', () => {
  const web = fileURLToPath(new URL('..', import.meta.url))
  const script = fileURLToPath(new URL('./support/approve-sequence-contention.script.ts', import.meta.url))
  const out = execFileSync(process.execPath, ['--experimental-strip-types', script], { cwd: web, env: { ...process.env, DAZL_REPO_WEB: web }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] })
  const line = (p: string) => JSON.parse(out.split('\n').find(l => l.startsWith(p))!.slice(p.length))
  const h = line('1 happy:'); assert.equal(h.msg.status, 'approved'); assert.equal(h.seq.status, 'approved'); assert.equal(h.ctx, 1)
  const r = line('2 rollback:'); assert.equal(r.threw, 'sender_identity_missing'); assert.equal(r.msg.status, 'draft'); assert.equal(r.seq.status, 'draft'); assert.equal(r.ctx, 0)
  const b = line('3 busy-timeout0:'); assert.match(b.threw, /^SQLITE_BUSY/); assert.equal(b.msg.status, 'draft'); assert.equal(b.ctx, 0)
  assert.equal(line('3 retry-after-release:').msg.status, 'approved')
  const w = line('4 wait-then-acquire:'); assert.equal(w.outcome, 'ok'); assert.equal(w.msg.status, 'approved'); assert.ok(w.elapsed_ms >= 500 && w.elapsed_ms < 5000)
})
