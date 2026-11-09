// Route boundary for the compiled plan on /api/scan/icp (#876): the real route, the real compiler. previewIcp is stubbed at the module boundary (no runner,
// no network, no provider, no model call); the plan is computed from the request and the draft profile exactly as a run reads them, and nothing is written.
process.env.DB_PATH = ':memory:'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { setAuthDb } from './scan-route-auth-db.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { setPreviewIcp } from './scan-route-stub-runner.ts'
import { POST } from '../../app/api/scan/icp/route.ts'
import type { PlanView, PlanViewNode } from '../../lib/scan/targeting.ts'

const request = (body: unknown) => new NextRequest('http://localhost/api/scan/icp', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify(body),
})
const ICP = { summary: 'London B2B SaaS startups', who: ['Founder'], industries: [], sizes: [], where: ['London, UK'], signals: [], exclude: [] }
const conds = (n: PlanViewNode | null): { id: string; kind: string; window: string | null; means: string }[] => !n ? [] : n.op === 'cond' ? [n] : (n.op === 'not' ? [n.of] : n.of).flatMap(conds)

test('POST /api/scan/icp returns the compiled plan with the draft; the plan changes nothing and costs nothing', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db); setScanDb(db); setAuthDb(db)
    let calls = 0
    setPreviewIcp(async () => { calls++; return { icp: ICP, inferred: true } as never })
    const tables = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t: unknown) => [(t as { name: string }).name, (db.prepare(`SELECT COUNT(*) AS n FROM "${(t as { name: string }).name}"`).get() as { n: number }).n]))
    const before = tables()

    // funding OR a completed hire: either is enough, each keeps its own clock
    const orR = await POST(request({ query: 'London B2B SaaS startups that raised seed funding in the last 90 days or hired their first VP of Sales within 30 days' }))
    assert.equal(orR.status, 200)
    const orJ = await orR.json() as { icp: unknown; inferred: boolean; plan: PlanView }
    assert.equal(orJ.inferred, true); assert.deepEqual(orJ.icp, ICP, 'the draft is unchanged by the plan')
    assert.equal(orJ.plan.explicit, true); assert.equal(orJ.plan.root?.op, 'or')
    assert.deepEqual(conds(orJ.plan.root).map(c => [c.kind, c.window]), [['funding', 'within 90 days'], ['hire_made', 'within 30 days']])
    assert.match(conds(orJ.plan.root)[1].means, /completed first hire.*not a vacancy/, 'a completed first hire is never worded as an open vacancy')

    // funding AND hiring: both required
    const andJ = await (await POST(request({ query: 'startups that raised seed funding and are hiring account executives' }))).json() as { plan: PlanView }
    assert.equal(andJ.plan.root?.op, 'and'); assert.deepEqual(conds(andJ.plan.root).map(c => c.kind), ['funding', 'hiring'])
    assert.match(conds(andJ.plan.root)[1].means, /an open role.*job posting/, 'hiring wording stays an open role')

    // an exclusion stays a hard NOT
    const notJ = await (await POST(request({ query: 'startups that raised seed funding, excluding competitors' }))).json() as { plan: PlanView }
    assert.ok(JSON.stringify(notJ.plan.root).includes('"op":"not"'), JSON.stringify(notJ.plan.root))

    // a request with no trigger it can read: an honest empty plan, nothing invented
    const emptyJ = await (await POST(request({ query: 'dentists in Ohio' }))).json() as { plan: PlanView }
    assert.equal(emptyJ.plan.root, null); assert.equal(emptyJ.plan.explicit, false)

    assert.equal(calls, 4, 'one preview per request: the plan adds no model or provider call')
    assert.equal(tables(), before, 'nothing was written: no job, no profile, no record')

    // failures still carry no plan (nothing to show for a refused preview)
    setPreviewIcp(async () => ({ error: 'spend_limit' }) as never)
    const refused = await POST(request({ query: 'startups that raised seed funding' })); assert.equal(refused.status, 429)
    assert.equal('plan' in (await refused.json() as object), false)
  } finally { setPreviewIcp(null); db.close() }
})
