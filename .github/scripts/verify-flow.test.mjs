// verify-flow must FAIL on a missing secret or any failed step (CI follow-up 1). Runs in never-again (.github/scripts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('../../ops/acceptance/checks/verify-flow.mjs', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'vf-'))
// a preload that replaces fetch with a scripted fake server
function run(routes, env = {}) {
  const pre = join(dir, `pre${Math.random()}.mjs`)
  writeFileSync(pre, `const R=${JSON.stringify(routes)};globalThis.__verifyFlowFetch=async(u,o)=>{const p=new URL(u).pathname+(o.body&&JSON.parse(o.body).action?':'+JSON.parse(o.body).action:'');const k=Object.keys(R).find(k=>p.startsWith(k));const r=R[k]||{s:404,j:{}};return new Response(JSON.stringify(r.j),{status:r.s,headers:r.c?{'set-cookie':'dazl_session=abc; Path=/'}:{}})}`)
  return spawnSync(process.execPath, ['--import', pre, SCRIPT], { encoding: 'utf8', env: { ...process.env, BASE_URL: 'https://x.test', DAZL_QA_EMAIL: 'qa@x.test', DAZL_QA_PASSWORD: 'p', VERIFY_FLOW_POLL_MS: '1', ...env } })
}
const ID = 'a'.repeat(24), MID = 'b'.repeat(24)
const good = {
  '/api/auth/signin': { s: 200, j: { ok: true }, c: 1 },
  '/api/scan/status': { s: 200, j: { status: 'done', leads: [{ id: 1 }] } },
  '/api/scan': { s: 202, j: { job_id: ID } },
  '/api/outreach/sequences': { s: 200, j: { messageId: MID } },
  [`/api/outreach/${MID}:approve`]: { s: 200, j: { ok: true } },
  [`/api/outreach/${MID}:send`]: { s: 200, j: { result: 'sent' } },
  '/api/outreach': { s: 200, j: { messages: [{ id: MID, status: 'draft' }] } },
}
test('every step works -> PASS', () => { const r = run(good); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /verify-flow: PASS/) })
test('missing secret -> FAIL', () => { const r = run(good, { DAZL_QA_PASSWORD: '' }); assert.equal(r.status, 1); assert.match(r.stdout, /missing secrets: DAZL_QA_PASSWORD/) })
test('search finishes with 0 leads -> FAIL', () => { const r = run({ ...good, '/api/scan/status': { s: 200, j: { status: 'done', leads: [] } } }); assert.equal(r.status, 1); assert.match(r.stdout, /0 leads/) })
test('send refused -> FAIL', () => { const r = run({ ...good, [`/api/outreach/${MID}:send`]: { s: 409, j: { error: 'x' } } }); assert.equal(r.status, 1); assert.match(r.stdout, /FAIL send/) })
test('fixture already sent -> FAIL (no false PASS from a repeat)', () => { const r = run({ ...good, '/api/outreach': { s: 200, j: { messages: [{ id: MID, status: 'sent' }] } } }); assert.equal(r.status, 1); assert.match(r.stdout, /already sent/) })
test('sign-in rejected -> FAIL', () => { const r = run({ ...good, '/api/auth/signin': { s: 401, j: { error: 'no' } } }); assert.equal(r.status, 1); assert.match(r.stdout, /FAIL sign-in/) })
