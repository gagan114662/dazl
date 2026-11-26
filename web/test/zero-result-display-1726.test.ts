import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { zeroResultReason } from '../lib/zero-result-reason.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import { statedOffer } from '../lib/scan/play-offer-text.ts'

const source = ts.createSourceFile('leads-client.tsx', readFileSync(new URL(
  '../app/app/leads/leads-client.tsx', import.meta.url,
), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

const scan = {
  status: 'done',
  lead_count: 0,
  query: 'Find people actively looking for a service',
  run_report: [{ discover: { stop: 'end_turn', searches: 4 } }],
  quality: { candidates: 3, dropped: 3 },
}

const reason = 'The results did not match what you asked for.'
const nextStep = 'Try a broader signal.'
const action = { label: 'Edit the request', href: '/app/leads' }

function renderHelp(record: object, withAction = true, useProductionReason = false) {
  const render = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'renderZeroResultReason')
  assert.ok(render, 'Leads must render the zero-result explanation')
  const { outputText } = ts.transpileModule(render.getText(source), {
    fileName: source.fileName,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const calls: unknown[] = []
  const stub = (input: Parameters<typeof zeroResultReason>[0]) => {
    calls.push({ ...input })
    return useProductionReason ? zeroResultReason(input) : { code: 'unknown', reason, nextStep, action: withAction ? action : undefined }
  }
  const element = runInNewContext(outputText + '\nrenderZeroResultReason(scan)', {
    exports: {}, zeroResultReason: stub, statedOffer, scan: record,
    require(id: string) {
      assert.equal(id, 'react/jsx-runtime')
      return jsxRuntime
    },
  })
  const html = renderToStaticMarkup(element)
  return { html, calls }
}

test('#1726: a completed zero-lead scan displays the helper reason, next step and optional action', () => {
  const { html, calls } = renderHelp(scan)
  assert.deepEqual(calls, [{
    stop: null, query: scan.query, offer: null, searchesUsed: 4,
    searchAllowance: Infinity, candidates: 3, rejected: 3,
  }])
  assert.match(html, /data-testid="zero-result-reason"/)
  assert.ok(html.includes(reason))
  assert.ok(html.includes(nextStep))
  assert.ok(html.includes('<a href="/app/leads"'))
  assert.ok(html.includes(action.label))
  assert.doesNotMatch(renderHelp(scan, false).html, /<a\b/)
  assert.match(source.text, /renderZeroResultReason\(zeroResultScan\)/)
})

test('#1726: missing telemetry cannot look like an exhausted allowance', () => {
  const { calls } = renderHelp({ ...scan, run_report: [] })
  assert.deepEqual(calls, [{
    stop: null, query: scan.query, offer: null, searchesUsed: 0,
    searchAllowance: Infinity, candidates: 3, rejected: 3,
  }])
})

test('#1726: a working, failed or nonzero scan does not call the helper or show the explanation', () => {
  for (const record of [
    { ...scan, status: 'running' },
    { ...scan, status: 'failed' },
    { ...scan, lead_count: 1 },
  ]) {
    assert.deepEqual(renderHelp(record), { html: '', calls: [] })
  }
})

const emptyScan = { ...scan, quality: { candidates: 0, dropped: 0 } }

test('#1726: a recorded native web search exhaustion names the search limit and suggests narrowing', () => {
  const { html } = renderHelp({
    ...emptyScan,
    run_report: [{
      native_web_search: { searches: 2, max_searches: 4, evidence_diagnostic: { result_errors: { max_uses_exceeded: 1 } } },
    }],
  }, true, true)
  assert.match(html, /reached its web search limit/)
  assert.match(html, /Try a narrower request/)
  assert.doesNotMatch(html, /spending limit/)
})

test('#1726: a trial spending stop preserves the recorded reason and shows its next step', () => {
  const { html } = renderHelp({
    ...emptyScan,
    error: 'trial_budget_reached',
    run_report: [{ discover: { stop: 'search_allowance_reached', searches: 4 } }],
    outcome: {
      kind: 'stopped',
      label: 'This free scan reached its spending limit.',
      detail: 'The scan stopped before it could finish looking.',
      next: { text: 'Try a narrower search', href: '/app/leads' },
    },
  }, true, true)
  assert.match(html, /spending limit/)
  assert.match(html, /stopped before it could finish looking/)
  assert.match(html, /Try a narrower search/)
  assert.doesNotMatch(html, /web search limit/)
})

test('#1726: a recorded zero match explicitly says nothing matched and suggests widening', () => {
  const { html } = renderHelp({
    ...emptyScan,
    outcome: {
      kind: 'zero_match',
      label: 'Zero match - the sources returned nothing',
      next: { text: 'Widen the search', href: '/app/leads' },
    },
  }, true, true)
  assert.match(html, /Nothing matched this search/)
  assert.match(html, /Widen the search/)
})

test('#1726: an extraction shortfall shows the recorded cause instead of asserting a zero match', () => {
  const { html } = renderHelp({
    ...emptyScan,
    outcome: {
      kind: 'none_extracted',
      label: 'No candidates were extracted',
      detail: 'The pages read did not identify a matching company.',
      next: { text: 'See what the scan read', href: '/app/leads?job_id=example' },
    },
  }, true, true)
  assert.match(html, /The pages read did not identify a matching company/)
  assert.match(html, /Try rewording/)
  assert.doesNotMatch(html, /Nothing matched this search/)
})

const limitInput = {
  query: scan.query, candidates: 0, rejected: 0, searchesUsed: 0, searchAllowance: Infinity,
}

test('#1726: monetary stops explain the spending limit', () => {
  for (const stop of ['trial_budget_reached', 'budget_stopped', 'spend_cap_reached']) {
    const result = zeroResultReason({ ...limitInput, stop })
    assert.equal(result.code, 'budget_spent')
    assert.equal(result.reason, 'This search reached its spending limit before finding a lead that passed.')
  }
})

test('#1726: a search-count stop explains exhausted web searches', () => {
  const result = zeroResultReason({
    ...limitInput, stop: 'search_allowance_reached', searchesUsed: 5, searchAllowance: 5,
  })
  assert.equal(result.reason, 'This search used all 5 of its web searches before finding a lead that passed.')
  assert.equal(zeroResultReason({ ...limitInput, stop: 'search_limit_reached' }).reason,
    'This search reached its web search limit before finding a lead that passed.')
  assert.equal(zeroResultReason({ ...limitInput, stop: 'quota_reached' }).code, 'unknown')
})
