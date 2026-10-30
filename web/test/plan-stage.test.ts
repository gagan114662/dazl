// #380 wired: the typed query plan on a finished verification - hard exclusions enforced, per-condition state in the run report. Invented companies; stubbed pages; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyQueryPlan } from '../lib/scan/plan-stage.ts'
import { SCENARIOS, fixtureFor } from './helpers/global-scenarios.ts'
import { runFixture } from './helpers/acceptance-harness.ts'

const lead = (company: string, signal: string, o: Partial<{ source_url: string; event_date: string | null; excerpt: string }> = {}) => ({ company, name: '', signal, excerpt: o.excerpt ?? `${company} ${signal}`, source_url: o.source_url ?? `https://news.example/${company.replace(/ /g, '')}`, event_date: o.event_date === undefined ? '2026-10-10' : o.event_date })

test('exclusions are enforced in code: "excluding Acme" drops Acme (company, name or signal) and keeps the rest', () => {
  const leads = [lead('Acme Robotics', 'raised a seed round'), lead('Beta Labs', 'raised a seed round'), lead('Gamma Co', 'raised a seed round, a spin-off of Acme')]
  const r = applyQueryPlan('Find London startups that raised a seed round, excluding Acme', ['London'], leads, [])
  assert.deepEqual(r.leads.map(l => l.company), ['Beta Labs']); assert.equal(r.excluded, 2)
  assert.deepEqual(r.report!.excluded.map(e => e.company).sort(), ['Acme Robotics', 'Gamma Co'])
})

test('per-condition state: each clause is true only on its own proof, joined across a company\'s leads; an unproven clause is UNKNOWN, never true', () => {
  const both = [lead('Acme', 'raised a seed round'), lead('Acme', 'is hiring sales staff')]
  const r = applyQueryPlan('Find London startups that raised a seed round and are hiring sales staff', ['London'], both, [])
  assert.equal(r.report!.plan, 'raised a seed round AND are hiring sales staff'); assert.equal(r.report!.leads.length, 1)
  assert.deepEqual(r.report!.leads[0].conditions.map(c => c.state), ['true', 'true']); assert.equal(r.report!.leads[0].state, 'true')
  const one = applyQueryPlan('Find London startups that raised a seed round and are hiring sales staff', ['London'], [lead('Beta', 'raised a seed round')], [])
  assert.deepEqual(one.report!.leads[0].conditions.map(c => [c.state, c.missing]), [['true', null], ['unknown', 'not checked or not found yet']]); assert.equal(one.report!.leads[0].state, 'unknown')
  assert.equal(one.leads.length, 1, 'an unproven condition reports unknown; it does not drop or re-grade the lead')
})

test('a clause\'s own window: a proof dated outside THAT clause\'s window is not true', () => {
  const r = applyQueryPlan('Find startups that raised seed funding within 30 days', [], [lead('Acme', 'raised seed funding', { event_date: '2025-01-05' })], [])
  assert.equal(r.report!.leads[0].conditions[0].state === 'true', false)
})

test('nothing readable and nothing excluded: no report, nothing changes', () => {
  const leads = [lead('Acme', 'x')]
  const r = applyQueryPlan('dentists in New York', ['New York'], leads, [])
  assert.equal(r.report, null); assert.equal(r.leads, leads); assert.equal(r.excluded, 0)
})

test('end to end through the real scan: the excluded company is dropped and counted; the run report carries the plan', async () => {
  const s = SCENARIOS[0], f = fixtureFor(s)
  const ex = await runFixture({ ...f, request: `${s.request} Exclude ${s.company}.` })
  const rows = ex.db.prepare('SELECT company, review_reason FROM leads').all() as { company: string; review_reason: string | null }[]
  assert.ok(!rows.some(r => r.company === s.company && r.review_reason === null), 'the excluded company is not a verified lead')
  const rep = JSON.parse((ex.db.prepare('SELECT report FROM scan_run_report').get() as { report: string }).report)
  assert.equal(rep.funnel.dropped >= 1 || rep.candidates.some((c: { fate: string }) => /excluded_by_request/.test(c.fate)), true, JSON.stringify(rep.funnel))
  const plain = await runFixture(f)
  assert.ok((plain.db.prepare('SELECT company FROM leads WHERE review_reason IS NULL').all() as { company: string }[]).some(r => r.company === s.company), 'control: without the exclusion it is verified')
})
