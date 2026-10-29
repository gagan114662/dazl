#!/usr/bin/env node
// Deploy-time smoke check (ops/staging/deploy.sh; docs/STAGING.md): one GET of /api/health, exit 0 only when it answers
// 200 with ok: true and the expected commit. Anything else (not reachable, 503 because a database does not answer, the
// old commit, a body that is not JSON) exits 1 with the reason on stderr, and the deploy rolls back. Loopback only;
// reports nowhere else. Usage: node ops/health-smoke.mjs <base url> <commit> [timeout ms]
const [base, commit, timeoutMs = '5000'] = process.argv.slice(2)
if (!base || !commit) { console.error('usage: health-smoke.mjs <base url> <commit> [timeout ms]'); process.exit(2) }
const no = (why) => { console.error(`health-smoke: ${why}`); process.exit(1) }
let res, body
try { res = await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(Number(timeoutMs)), cache: 'no-store' }) }
catch (e) { no(`not reachable (${e?.name ?? 'error'})`) }
try { body = await res.json() } catch { no(`HTTP ${res.status}, body is not JSON`) }
if (body?.commit !== commit) no(`serves commit ${JSON.stringify(body?.commit ?? null)}, expected ${commit}`)
if (res.status !== 200 || body.ok !== true) {
  const down = Object.entries(body.checks ?? {}).filter(([, c]) => c && c.ok === false).map(([k]) => k)
  no(`HTTP ${res.status}, not ok${down.length ? ` (${down.join(', ')} not answering)` : ''}`)
}
console.log(`health-smoke: ok, commit ${commit}`)
