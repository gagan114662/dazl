// #844: every external / cost-bearing API route has a declared ownership requirement (lib/ops/cost-actions.ts).
// A new route that imports a cost-bearing call fails here until it is listed with what it requires.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COST_BEARING_ROUTES, costCallsIn, undeclaredCostRoutes } from '../lib/ops/cost-actions.ts'

const web = fileURLToPath(new URL('../', import.meta.url))
const ACTION_REQ = new Set(['read', 'export', 'operate', 'send', 'configure', 'members', 'billing', 'owners'])

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? routeFiles(p) : n === 'route.ts' ? [p] : [] })
}
function apiRoutes(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of routeFiles(join(web, 'app/api'))) out['/' + relative(join(web, 'app'), f).replace(/\\/g, '/').replace(/\/route\.ts$/, '')] = readFileSync(f, 'utf8')
  return out
}

test('every API route that imports a cost-bearing call declares its ownership requirement', () => {
  assert.deepEqual(undeclaredCostRoutes(apiRoutes()), [], 'add the route to COST_BEARING_ROUTES in lib/ops/cost-actions.ts with what it costs and who may trigger it')
})

test('a new cost-bearing route with no declared requirement fails the guard', () => {
  const fake = { '/api/new-paid-thing': "import { polishDraft } from '@/lib/outreach/draft-llm'\nexport async function POST() {}" }
  assert.deepEqual(undeclaredCostRoutes(fake), ['/api/new-paid-thing'])
  assert.deepEqual(undeclaredCostRoutes({ '/api/x': "import { kickRunner as k } from '@/lib/scan/runner.ts'" }), ['/api/x'])
  assert.deepEqual(undeclaredCostRoutes({ '/api/y': "import { recentBriefs } from '@/lib/seo/brief'" }), [], 'a read-only import is not cost-bearing')
})

test('every inventory entry is a real route that still makes a cost-bearing call and checks what it declares', () => {
  const routes = apiRoutes()
  for (const [r, d] of Object.entries(COST_BEARING_ROUTES)) {
    assert.ok(Object.hasOwn(routes, r), `${r} is listed but has no route file`)
    assert.ok(costCallsIn(routes[r]).length > 0, `${r} is listed but imports no cost-bearing call: remove it`)
    assert.ok(d.kinds.length > 0, `${r} needs at least one kind`)
    const src = routes[r]
    if (ACTION_REQ.has(d.requires)) assert.match(src, new RegExp(`denied\\([^)]*'${d.requires}'|load\\([^)]*'${d.requires}'|guard\\([^)]*'${d.requires}'`), `${r} declares '${d.requires}' but does not check it`)
    else if (d.requires === 'signed_in') { assert.match(src, /requireUser\(/, `${r} declares signed_in but never asks for a user`); assert.doesNotMatch(src, /denied\(/, `${r} checks a role: declare the action instead`) }
    else if (d.requires === 'operator_secret') assert.match(src, /AUTOPILOT_TICK_SECRET/, `${r} declares operator_secret but does not check it`)
    else if (d.requires === 'public') { assert.doesNotMatch(src, /requireUser\(/, `${r} declares public but requires a user`); assert.match(src, /rateLimit\(/, `${r} is public and must be rate-limited`) }
  }
})
