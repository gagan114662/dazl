import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const load = (path, dependencies, globals = {}) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(output, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`)
    return dependencies[name]
  }, process: { env: {} }, console, Error, ...globals, setTimeout: () => { throw new Error('Unexpected automatic recheck') }, clearTimeout() {} })
  return exports
}
class CrmPushError extends Error { outcome = 'unknown' }
function route(provider, outcome = 'unknown') {
  const calls = []
  const lead = { id: 'lead-1', scan_job_id: 'job-1', company: 'Example', name: 'Owner' }
  const record = name => (...args) => { calls.push({ name, args }); return true }
  const crm = {
    CrmPushError, getCrmConfig: () => ({ provider }), crmDestination: cfg => cfg.provider,
    claimPush: () => { calls.push({ name: 'claim' }); return { attemptId: 'attempt-1' } },
    finishClaim: record('finish'), auditPush: record('auditPush'), resolveClaim: record('resolve'),
    claimState: () => ({ state: 'unknown', externalId: null }),
    disconnectCrm() {}, saveCrmConfig() {},
    pushLead: async () => { calls.push({ name: 'push' }); if (outcome === 'unknown') throw new CrmPushError(provider === 'webhook' ? 'Webhook answered with a redirect; delivery is uncertain' : 'CRM delivery is uncertain'); return { message: 'Sent', externalId: null } },
  }
  const api = load('../app/api/crm/route.ts', {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
    '@/lib/scan/service': { requireUser: async () => ({ tenantId: 'tenant-1' }), getScanDb: () => ({ prepare: () => ({ get: () => lead }) }) },
    '@/lib/crm/index': crm, '@/lib/net/public-fetch': {}, '@/lib/same-origin': { sameOriginJson: () => true },
    '@/lib/ops/errors': { captureError() {} }, '@/lib/ops/request-log': { requestIdOf: () => 'request-1' },
    '@/lib/rate-limit': { rateLimit: async () => ({ ok: true }) }, '@/lib/audit-route': { audit: async () => {} },
    '@/lib/workspace-access': { denied: () => null, stale: () => null },
  })
  return { calls, post: body => api.POST({ json: async () => ({ lead_id: 'lead-1', ...body }) }) }
}
function component(replies) {
  // Exact component, controlled React hook lifecycle and HTTP boundary. No network, providers or timers.
  let state, cursor = 0
  const refs = []
  const requests = []
  const hooks = {
    useState: initial => { state ??= initial; return [state, value => { state = value }] },
    useRef: initial => { const index = cursor++; refs[index] ??= { current: initial }; return refs[index] },
    useEffect: effect => { effect() },
  }
  const api = load('../app/app/leads/crm-push.tsx', {
    react: hooks, 'react/jsx-runtime': require('react/jsx-runtime'),
  }, { fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); const reply = replies.shift(); assert.ok(reply, 'unexpected POST'); return { ok: reply.status < 400, json: async () => reply.body } } })
  // The loader takes fetch as a dependency-free global, with no fallback to a real network.
  const render = () => { cursor = 0; return api.CrmPush({ leadId: 'lead-1' }) }
  return { render, requests, get state() { return state }, async click(label) {
    const find = node => {
      if (!node || typeof node !== 'object') return null
      if (node.type === 'button' && node.props.children === label) return node
      const children = node.props?.children
      return (Array.isArray(children) ? children.flat(Infinity) : [children]).map(find).find(Boolean)
    }
    const button = find(render()); assert.ok(button, label)
    await button.props.onClick(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
  } }
}
test('webhook UNKNOWN route result renders check-endpoint guidance, no native resolution or retry', async () => {
  const api = route('webhook')
  const reply = await api.post({ action: 'push' })
  assert.equal(reply.status, 502); assert.equal(reply.body.outcome, 'unknown'); assert.equal(reply.body.resolution, 'webhook_endpoint')
  assert.deepEqual(api.calls.map(x => x.name), ['push', 'auditPush'])
  const refused = await api.post({ action: 'resolve', created: false }); assert.equal(refused.status, 409)
  assert.equal(api.calls.filter(x => x.name === 'resolve').length, 0)
  const ui = component([reply]); await ui.click('Push to CRM')
  const html = renderToStaticMarkup(ui.render())
  assert.match(html, /delivery is uncertain/); assert.match(html, /original webhook endpoint/); assert.match(html, /final address/)
  assert.doesNotMatch(html, /<button|It is in my CRM|It is not there|Try again|Check again/)
  assert.equal(ui.state.kind, 'webhook_unknown'); assert.deepEqual(ui.requests, [{ action: 'push', lead_id: 'lead-1' }])
  await new Promise(resolve => setTimeout(resolve, 20)); ui.render(); assert.equal(ui.requests.length, 1)
  if (process.env.CRM_UNKNOWN_PREVIEW) { mkdirSync(process.env.CRM_UNKNOWN_PREVIEW, { recursive: true }); writeFileSync(`${process.env.CRM_UNKNOWN_PREVIEW}/webhook.html`, html) }
})
for (const provider of ['hubspot', 'pipedrive']) test(`${provider} UNKNOWN retains native claim and user resolution, without automatic retry`, async () => {
  const api = route(provider); const reply = await api.post({ action: 'push' })
  assert.equal(reply.body.outcome, 'unknown'); assert.equal(reply.body.resolution, undefined)
  assert.deepEqual(api.calls.map(x => x.name), ['claim', 'push', 'finish', 'auditPush'])
  const ui = component([reply, { status: 200, body: { ok: true } }]); await ui.click('Push to CRM')
  const html = renderToStaticMarkup(ui.render()); assert.match(html, /It is in my CRM/); assert.match(html, /It is not there/); assert.doesNotMatch(html, /Try again/)
  assert.equal(ui.requests.length, 1); await ui.click('It is in my CRM')
  assert.deepEqual(ui.requests.map(x => x.action), ['push', 'resolve']); assert.equal(ui.state.kind, 'done')
  const resolution = await api.post({ action: 'resolve', created: true }); assert.equal(resolution.status, 200)
  assert.equal(api.calls.filter(x => x.name === 'push').length, 1)
  if (process.env.CRM_UNKNOWN_PREVIEW) writeFileSync(`${process.env.CRM_UNKNOWN_PREVIEW}/${provider}.html`, html)
})
test('direct webhook success remains done with no native claim', async () => {
  const api = route('webhook', 'ok'); const reply = await api.post({ action: 'push' })
  assert.equal(reply.status, 200); assert.equal(reply.body.ok, true)
  const ui = component([reply]); await ui.click('Push to CRM'); assert.equal(ui.state.kind, 'done')
  assert.deepEqual(api.calls.map(x => x.name), ['push', 'auditPush'])
})
