import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import { bothEngines } from './helpers/engines.ts'
import { homeResults } from '../lib/outreach/home-results.ts'

bothEngines('#1772: Home signal rows and the Leads row total use the same count', async ({ db }) => {
  const now = 1_800_000_000
  const job = 'a'.repeat(24)
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'A', 'Fixture', 'services', 'region', 'running', ?)", [job, now])
  for (const [id, company, kind, source] of [
    ['a1', 'Repeated company', 'hiring', 'discover'],
    ['a2', 'Repeated company', null, 'discover'],
    ['a3', 'Other company', 'hiring', 'watch'],
  ]) {
    await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, signal_kind, source_kind, created_at) VALUES (?, ?, ?, 'Fixture signal', 'https://example.test/proof', ?, ?, ?)", [id, job, company, kind, source, now])
  }

  const results = await homeResults(db, 'A', now)
  assert.equal(results.companies, 2, 'two distinct companies')
  assert.deepEqual(results.by_signal.map(row => [row.signal, row.leads]), [['hiring', 2], ['source:discover', 1]])
  const displayedLeadsTotal = results.tiles.leads
  assert.equal(displayedLeadsTotal, 3, 'all three lead rows count once')
  assert.equal(results.by_signal.reduce((total, row) => total + row.leads, 0), displayedLeadsTotal)

  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  assert.match(read('../app/app/home-results.tsx'), /fetch\('\/api\/home\/results'\)/)
  const leads = read('../app/app/leads/leads-client.tsx')
  const load = leads.match(/void (fetch\('\/api\/home\/results'[\s\S]+?)\n    return \(\) => request.abort\(\)/)?.[1]
  assert.ok(load, 'Leads reads the same result as Home')
  const markup = leads.match(/<p[^>]+data-testid="leads-overall-row-total"[^>]*>[\s\S]+?<\/p>/)?.[0]
  assert.ok(markup, 'Leads renders the workspace total')
  const options = { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  const runnable = ts.transpileModule(load, { compilerOptions: options }).outputText
  const rendered = ts.transpileModule(`export default (${markup})`, { fileName: 'lead-row-total.tsx', compilerOptions: options }).outputText

  async function renderTotal(response: Response) {
    const request = new AbortController()
    let leadRowTotal: unknown
    await runInNewContext(runnable, {
      fetch: async (url: string) => {
        assert.equal(url, '/api/home/results')
        return response
      },
      request, AbortSignal,
      setLeadRowTotal: (total: unknown) => { leadRowTotal = total },
    })
    const exports: { default?: Parameters<typeof renderToStaticMarkup>[0] } = {}
    runInNewContext(rendered, { exports, leadRowTotal, require: () => jsxRuntime })
    assert.ok(exports.default)
    return renderToStaticMarkup(exports.default)
  }

  assert.match(await renderTotal(Response.json(results)), /Across your workspace, last 30 days: 3 lead rows found\./)
  assert.match(await renderTotal(new Response(null, { status: 503 })), /Could not load the total number of lead rows\./)
})
