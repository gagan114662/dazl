// Route boundary for /api/scan/icp: the preview's spend and provider failures keep their truthful names and statuses
// (the same mapping as the website profile read), never a blanket 402 "key_rejected". previewIcp is stubbed at the
// module boundary; no runner, no network, no provider.
// The shared rate-limit store is the file app DB by default: counts would persist across test runs and eventually
// refuse (30/hour). An in-memory store keeps each run's counting real but fresh.
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

const request = (body: unknown) => new NextRequest('http://localhost/api/scan/icp', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify(body),
})

test('POST /api/scan/icp: spend and provider failures map to their own names and statuses', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db)
    setScanDb(db); setAuthDb(db)
    const cases: [Record<string, unknown>, number, string][] = [
      [{ error: 'spend_limit' }, 429, 'spend_limit'],
      [{ error: 'model_unpriced' }, 503, 'model_unpriced'],
      [{ error: 'accounting_pending' }, 503, 'accounting_pending'],
      [{ error: 'spend_unavailable' }, 503, 'spend_unavailable'],
      [{ error: 'provider_failed' }, 502, 'provider_failed'],
      [{ error: 'key_rejected' }, 402, 'key_rejected'],
      [{ error: 'key_unreadable' }, 400, 'key_unreadable'],
      [{ error: 'no_api_key' }, 400, 'no_api_key'],
      [{ error: 'trial_key_invalid' }, 503, 'trial_key_invalid'],
    ]
    for (const [out, status, name] of cases) {
      setPreviewIcp(async () => out as never)
      const r = await POST(request({ query: 'fintech founders in Europe' }))
      const j = await r.json() as { error?: string; message?: string }
      assert.equal(r.status, status, `${name}: ${JSON.stringify(j)}`)
      assert.equal(j.error, name)
      if (name === 'spend_limit' || name === 'model_unpriced' || name === 'spend_unavailable') {
        assert.ok(typeof j.message === 'string' && /nothing was charged|no new charge/i.test(j.message), `${name}: honest no-charge copy`)
        assert.ok(!/key was rejected|rejected your key|invalid key/i.test(j.message!), `${name}: never mislabeled as a key problem`)
      }
      if (name === 'accounting_pending') {
        // The unsettled call may be THIS request's (the provider was called, then the settle failed): the copy must
        // be safe for current OR earlier uncertain accounting, never a false "no new charge was made for this request".
        assert.ok(typeof j.message === 'string' && /may still be billed/i.test(j.message), 'accounting_pending: says a call may still be billed')
        assert.ok(!/no new charge was made for this request|nothing was charged/i.test(j.message!), 'accounting_pending: never claims this request was not billed')
        assert.ok(!/key was rejected|rejected your key|invalid key/i.test(j.message!), 'accounting_pending: never mislabeled as a key problem')
      }
      if (name === 'provider_failed') assert.ok(/key was not rejected/i.test(j.message ?? ''), 'provider_failed: says the key is fine')
    }
    // A good preview still passes through.
    setPreviewIcp(async () => ({ icp: { summary: 'Fintech founders', who: ['Founder'], industries: [], sizes: [], where: [], signals: [], exclude: [] }, inferred: true }) as never)
    const ok = await POST(request({ query: 'fintech founders in Europe' }))
    assert.equal(ok.status, 200)
    assert.equal((await ok.json() as { inferred?: boolean }).inferred, true)

    // "Review profile first" with a prior profile: the fresh inference's fields come back, and the prior profile's
    // research block - the rejection, the hold, the typed answer - rides along whole. Decisions are never reset.
    const PRIOR_RESEARCH = {
      v: 1, site: 'acme.example', q: 'Who buys this?', ans: { q: 'Who buys this?', o: 'o1', t: 'Practice managers' },
      offers: [{ i: 'o1', n: 'Acme Booking' }],
      hyps: [
        { i: 'h1', o: 'o1', k: 'persona', t: 'Practice managers', s: 'reviewed', u: 'https://acme.example/', q: 'for practice managers', at: 1800000000 },
        { i: 'h2', o: 'o1', k: 'persona', t: 'Dental influencers', s: 'rejected', u: 'https://acme.example/', q: null, at: null },
      ],
      u: [{ n: ['acme booking'], k: 'persona', t: '', s: 'reviewed', w: true, o: true }],
    }
    const prior = { summary: 'Dental practices that need booking software.', who: ['Practice managers'], industries: [], sizes: [], where: [], signals: [], exclude: [], research: PRIOR_RESEARCH }
    setPreviewIcp(async () => ({ icp: { summary: 'Fresh inference', who: ['Owner'], industries: [], sizes: [], where: [], signals: [], exclude: [] }, inferred: true }) as never)
    const carried = await POST(request({ query: 'orthodontists in Texas', prior_icp: prior }))
    assert.equal(carried.status, 200)
    const cj = await carried.json() as { icp: { summary: string; research?: unknown } }
    assert.equal(cj.icp.summary, 'Fresh inference', 'the fields are the fresh inference')
    const cr = cj.icp.research as { hyps: { s: string }[]; u?: { n: string[]; w?: boolean }[]; ans?: { t?: string } }
    assert.deepEqual(cr.hyps.map(h => h.s), ['reviewed', 'rejected'], 'the reviewed statement and the rejection carry verbatim')
    assert.equal(cr.ans?.t, 'Practice managers', 'the typed answer carries')
    assert.equal(cr.u?.length, 1, 'the held offer carries')
    assert.equal(cr.u?.[0].w, true)
    assert.deepEqual(cr.u?.[0].n, ['acme booking'])
    // The fresh inference produced research of its OWN: fresh model research is not new provenance (no site
    // recrawl), so the prior block carries WHOLE - every decision with its exact binding, the hold, the typed
    // answer - and the fresh research is discarded outright. No merge, no conditional.
    const FRESH_RESEARCH = {
      v: 1, site: 'acme.example', q: null, ans: null,
      offers: [{ i: 'f1', n: 'Acme Booking' }],
      hyps: [{ i: 'g1', o: 'f1', k: 'persona', t: 'Clinic owners', s: 'hypothesis', u: null, q: null, at: null }],
    }
    setPreviewIcp(async () => ({ icp: { summary: 'Fresh inference', who: ['Owner'], industries: [], sizes: [], where: [], signals: [], exclude: [], research: FRESH_RESEARCH }, inferred: true }) as never)
    const merged = await POST(request({ query: 'orthodontists in Texas', prior_icp: prior }))
    assert.equal(merged.status, 200)
    const mj = (await merged.json() as { icp: { research: { offers: { i: string; n: string }[]; hyps: { i: string; o: string; t: string; s: string }[]; u?: { n: string[]; w?: boolean }[]; q?: string | null; ans?: { o: string; t?: string } | null } } }).icp.research
    const byText = new Map(mj.hyps.map(h => [h.t, h]))
    assert.equal(byText.get('Practice managers')?.s, 'reviewed', 'the reviewed statement carries verbatim')
    assert.equal(byText.get('Dental influencers')?.s, 'rejected', 'the rejection carries verbatim')
    assert.equal(byText.get('Practice managers')?.o, 'o1', 'the ORIGINAL binding is kept - no remap onto fresh offer ids')
    assert.deepEqual(mj.offers.map(o => o.i), ['o1'], 'the prior offers, not the fresh ones')
    assert.equal(byText.has('Clinic owners'), false, 'fresh model research is discarded: not new provenance')
    assert.equal(mj.ans?.t, 'Practice managers')
    assert.equal(mj.ans?.o, 'o1')
    assert.equal(mj.q, 'Who buys this?')
    assert.equal(mj.u?.length, 1)
    assert.equal(mj.u?.[0].w, true)
    // A prior whose block is absent adds nothing (the fresh research passes through as it is); a malformed prior is
    // ignored, never fatal.
    const bare = await POST(request({ query: 'orthodontists in Texas', prior_icp: { who: [] } }))
    assert.equal(bare.status, 200)
    assert.deepEqual((await bare.json() as { icp: { research?: unknown } }).icp.research, FRESH_RESEARCH, 'no prior decisions: the fresh research is the draft as inferred')
    setPreviewIcp(async () => ({ icp: { summary: 'Fresh inference', who: ['Owner'], industries: [], sizes: [], where: [], signals: [], exclude: [] }, inferred: true }) as never)
    const bare2 = await POST(request({ query: 'orthodontists in Texas', prior_icp: { who: [] } }))
    assert.equal(bare2.status, 200)
    assert.equal((await bare2.json() as { icp: { research?: unknown } }).icp.research, undefined)
  } finally { setPreviewIcp(null); db.close() }
})
