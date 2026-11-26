import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'

test('#1849: two same-day runs of the same query show distinct local times', () => {
  const source = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const markup = source.match(/<dd>[^\n]+(?=<\/div>)/g)?.find(item => item.includes('j.created_at'))
  assert.ok(markup, 'the Past scans row renders the run date')
  const { outputText } = ts.transpileModule(`export default (${markup})`, {
    fileName: 'past-scan-time.tsx',
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  assert.match(source, /pastJobs\.map\(j =>[\s\S]+?<div key=\{j\.id\}/)
  const query = 'Find teams looking for an installation service'
  const jobs = [
    { id: 'a'.repeat(24), query, created_at: new Date(2026, 10, 25, 7, 39, 13).getTime() / 1000 },
    { id: 'b'.repeat(24), query, created_at: new Date(2026, 10, 25, 7, 39, 39).getTime() / 1000 },
  ]
  const labels = jobs.map(j => {
    const exports: { default?: Parameters<typeof renderToStaticMarkup>[0] } = {}
    runInNewContext(outputText, { exports, j, Date, require: () => jsxRuntime })
    assert.ok(exports.default)
    return renderToStaticMarkup(exports.default)
  })
  assert.notEqual(labels[0], labels[1])
  const formats = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' } as const
  assert.deepEqual(labels, jobs.map(j => `<dd>${new Date(j.created_at * 1000).toLocaleString(undefined, formats)}</dd>`))
})
