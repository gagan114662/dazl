// #1037 (F-go step 1): the worker carries tenants' session cookies, so it listens on 127.0.0.1 unless HOST names another address,
// and it refuses to start without a token or with a bad port (a process that 401s everything would look healthy to systemd).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { reap } from './boot-util.ts'

const boot = (env: Record<string, string>) => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/server.ts'], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
// Bounded: a worker that starts anyway (the old behaviour) is stopped after 5 s and reported as still running (code null).
const exited = (c: ChildProcess) => new Promise<{ code: number | null; err: string }>(res => { let err = ''; c.stderr?.on('data', d => { err += String(d) }); const t = setTimeout(() => { void reap(c).then(() => res({ code: null, err: `${err}(still running after 5 s)` })) }, 5000); c.on('exit', code => { clearTimeout(t); res({ code, err }) }) })
const up = async (url: string) => { for (let i = 0; i < 100; i++) { try { const r = await fetch(url); if (r.ok) return true } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 100)) } return false }
// An address of this machine that is not loopback, when it has one (CI runners do).
const outside = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address

test('listens on 127.0.0.1 by default: reachable on loopback, refused on the machine\'s other address', async () => {
  const port = 4800 + Math.floor(Math.random() * 400)
  const c = boot({ ADVANCED_WORKER_TOKEN: 'tok-boot', PORT: String(port) })
  try {
    assert.ok(await up(`http://127.0.0.1:${port}/health`), 'up on loopback')
    if (outside) await assert.rejects(fetch(`http://${outside}:${port}/health`, { signal: AbortSignal.timeout(3000) }), `not reachable on ${outside}`)
    else test.skip?.('this machine has no non-loopback IPv4 address')
  } finally { await reap(c) }
})

test('HOST names another address when the operator asks for it', async () => {
  if (!outside) return
  const port = 4800 + Math.floor(Math.random() * 400)
  const c = boot({ ADVANCED_WORKER_TOKEN: 'tok-boot', PORT: String(port), HOST: '0.0.0.0' })
  try { assert.ok(await up(`http://${outside}:${port}/health`)) } finally { await reap(c) }
})

test('refuses to start without a token, or with a port that is not a port', async () => {
  for (const env of [{ PORT: '4999' }, { ADVANCED_WORKER_TOKEN: '   ', PORT: '4999' }, { ADVANCED_WORKER_TOKEN: 'tok', PORT: 'abc' }, { ADVANCED_WORKER_TOKEN: 'tok', PORT: '70000' }]) {
    const r = await exited(boot(env))
    assert.equal(r.code, 2, JSON.stringify(env)); assert.match(r.err, /not starting/)
  }
})
