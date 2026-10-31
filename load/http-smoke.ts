// Dependency-free HTTP read-path concurrency probe for a LOCALLY running dazl instance.
// Never point this at production: it exists to exercise a local dev/preview server only.
//
//   LOAD_BASE_URL=http://127.0.0.1:3100 node --experimental-strip-types load/http-smoke.ts
//
// Knobs (env): LOAD_VUS=20 LOAD_DURATION_S=30 LOAD_COOKIE='dazl_session=...'
//   LOAD_ALLOW_AUTH=1   (enables authenticated GETs with LOAD_COOKIE; read-only routes only)
//
// Measures GET latency distribution per route under fixed concurrency. Issues no writes:
// POST /api/scan and every other mutating route are deliberately absent. Authenticated
// scan-pipeline load belongs to load/runner-bench.ts, which mocks the provider instead
// of spending real keys.
const BASE = (process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '')
const VUS = Number(process.env.LOAD_VUS ?? 20)
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 30)
const COOKIE = process.env.LOAD_COOKIE ?? ''
const AUTH = process.env.LOAD_ALLOW_AUTH === '1' && COOKIE.length > 0

if (/^https?:\/\/(dazl\.ai|www\.dazl\.ai)/.test(BASE) || process.env.LOAD_ALLOW_REMOTE !== '1') {
  const host = new URL(BASE).hostname
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host)
  if (!local) {
    console.error(`Refusing to load-test non-local host ${host}. Set LOAD_ALLOW_REMOTE=1 only for a throwaway preview box you own.`)
    process.exit(1)
  }
}

const routes: { path: string; auth: boolean }[] = [
  { path: '/api/health', auth: false },
  { path: '/', auth: false },
  { path: '/sign-in', auth: false },
  ...(AUTH ? [{ path: '/api/leads', auth: true }] : []),
]

interface Rec { n: number; errs: number; lat: number[] }
const per: Record<string, Rec> = Object.fromEntries(routes.map(r => [r.path, { n: 0, errs: 0, lat: [] }]))
let stop = false

function pct(s: number[], p: number) { return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : 0 }

async function worker(idx: number) {
  while (!stop) {
    const r = routes[idx % routes.length]
    const t0 = performance.now()
    try {
      const res = await fetch(BASE + r.path, { headers: r.auth ? { cookie: COOKIE } : {}, redirect: 'manual' })
      await res.arrayBuffer()
      per[r.path].lat.push(performance.now() - t0)
      per[r.path].n++
      if (res.status >= 500) per[r.path].errs++
    } catch {
      per[r.path].errs++
    }
  }
}

const workers = Array.from({ length: VUS }, (_, i) => worker(i))
setTimeout(() => { stop = true }, DURATION_S * 1000)
await Promise.all(workers)

const out: Record<string, unknown> = { base: BASE, vus: VUS, duration_s: DURATION_S, authenticated_routes: AUTH }
for (const [path, r] of Object.entries(per)) {
  const s = [...r.lat].sort((a, b) => a - b)
  out[path] = { requests: r.n, errors_5xx_or_network: r.errs, p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), p99: +pct(s, 99).toFixed(1), max: +(s[s.length - 1] ?? 0).toFixed(1), rps: +(r.n / DURATION_S).toFixed(1) }
}
console.log(JSON.stringify(out, null, 2))
