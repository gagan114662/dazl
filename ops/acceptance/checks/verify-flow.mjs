#!/usr/bin/env node
// CI follow-up 1 (Gagan, 2026-11-16 6:41pm): the real user flow on the deployed site, as the post-deploy acceptance check.
//   1. sign in as the QA account (sign-up itself was proven live for #1089; re-creating an account every deploy is not wanted)
//   2. first search: POST /api/scan, poll /api/scan/status until it finishes, and require at least one lead
//   3. send: ONLY through the own-inbox test fixture (lib/outreach/test-fixture.ts), which is addressed to the allowlisted
//      test inbox and nobody else. A real prospect is never contacted by this check.
// Exit 0 only if every step really worked. Missing secrets, a failed step, a timeout or an already-sent fixture = FAIL.
// Spend: one search per run (the QA account's funded trial, inside the C$60 cap). Run it once per deploy batch, not per issue.
//
// env (repo secrets in prod-deploy): BASE_URL (set by run-batch), DAZL_QA_EMAIL (gagan+dazlqa@getfoolish.com),
// DAZL_QA_PASSWORD, DAZL_QA_QUERY (optional, default below). Prod must have OUTREACH_TEST_TENANT_ID = the QA tenant and
// the test inbox allowlisted on it, or step 3 fails with test_tenant_only / test_inbox_not_allowlisted.
const base = (process.env.BASE_URL || '').replace(/\/$/, '')
const email = process.env.DAZL_QA_EMAIL || ''
const password = process.env.DAZL_QA_PASSWORD || ''
const query = process.env.DAZL_QA_QUERY || 'B2B SaaS startups in Toronto hiring their first sales rep'
const POLL_MS = Number(process.env.VERIFY_FLOW_POLL_MS || 5000)
const DEADLINE_MS = Number(process.env.VERIFY_FLOW_DEADLINE_MS || 15 * 60_000)
const fetchImpl = globalThis.__verifyFlowFetch || fetch

function fail(step, why) { console.log(`FAIL ${step}: ${why}`); process.exit(1) }
const missing = [['BASE_URL', base], ['DAZL_QA_EMAIL', email], ['DAZL_QA_PASSWORD', password]].filter(([, v]) => !v).map(([k]) => k)
if (missing.length) fail('setup', `missing secrets: ${missing.join(', ')}`)

let cookie = ''
async function call(method, path, body) {
  const r = await fetchImpl(base + path, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = r.headers.get('set-cookie') || ''
  const m = set.match(/dazl_session=([^;]+)/); if (m) cookie = `dazl_session=${m[1]}`
  let json = null; try { json = await r.json() } catch {}
  return { status: r.status, json }
}

const si = await call('POST', '/api/auth/signin', { email, password })
if (si.status !== 200 || !si.json?.ok || !cookie) fail('sign-in', `status ${si.status} ${JSON.stringify(si.json)}`)
console.log('ok   sign-in')

const sc = await call('POST', '/api/scan', { query })
const jobId = sc.json?.job_id
if (sc.status !== 202 || !/^[a-f0-9]{24}$/.test(jobId || '')) fail('first search', `status ${sc.status} ${JSON.stringify(sc.json)}`)
console.log(`ok   first search started (job ${jobId})`)
const t0 = Date.now(); let st
for (;;) {
  st = await call('GET', `/api/scan/status?job_id=${jobId}`)
  const s = st.json?.status
  if (s === 'done' || s === 'complete' || s === 'completed') break
  if (s === 'failed' || s === 'error' || s === 'cancelled') fail('first search', `job ${s}: ${JSON.stringify(st.json).slice(0, 300)}`)
  if (Date.now() - t0 > DEADLINE_MS) fail('first search', `not finished after ${DEADLINE_MS / 60000} min (last status ${s})`)
  await new Promise(r => setTimeout(r, POLL_MS))
}
const leads = Array.isArray(st.json?.leads) ? st.json.leads : []
const count = Number(st.json?.lead_count ?? st.json?.counts?.leads ?? leads.length)
if (!(count > 0)) fail('first search', 'finished with 0 leads')
console.log(`ok   first search finished with ${count} lead(s)`)

const fx = await call('POST', '/api/outreach/sequences', { action: 'create_test_fixture' })
const messageId = fx.json?.messageId
if (fx.status !== 200 || !/^[a-f0-9]{24}$/.test(messageId || '')) fail('send', `test fixture: status ${fx.status} ${JSON.stringify(fx.json)}`)
const list = await call('GET', '/api/outreach')
const before = (list.json?.messages || []).find(m => m.id === messageId)?.status
if (before === 'sent') fail('send', 'the own-inbox test message was already sent earlier; a fresh send is not proven (reset the fixture on the box)')
const ap = await call('POST', `/api/outreach/${messageId}`, { action: 'approve' })
if (ap.status !== 200 && before !== 'approved') fail('send', `approve: status ${ap.status} ${JSON.stringify(ap.json)}`)
const sd = await call('POST', `/api/outreach/${messageId}`, { action: 'send' })
if (sd.status !== 200 || sd.json?.result !== 'sent') fail('send', `status ${sd.status} ${JSON.stringify(sd.json)}`)
console.log('ok   send accepted (own-inbox test message only)')
console.log('verify-flow: PASS (sign-in, first search with leads, send)')
