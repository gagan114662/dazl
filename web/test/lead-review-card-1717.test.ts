import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsx from 'react/jsx-runtime'
import ts from 'typescript'
import { reviewTimingCopy } from '../lib/scan/leads-view.ts'

const source = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

function render(fragment: string, bindings: Record<string, unknown>) {
  const { outputText } = ts.transpileModule('result = ' + fragment, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
    fileName: 'fragment.tsx',
  })
  const element = runInNewContext(outputText + '\nresult', {
    ...bindings, require: () => jsx, exports: {}, result: undefined,
  })
  return renderToStaticMarkup(element)
}

test('review copy distinguishes a stored manual entry from an AI-found hold', () => {
  const declarations = source.slice(source.indexOf('const REVIEW:'), source.indexOf('// Enrichment labels'))
  const { outputText } = ts.transpileModule(declarations + '\nresult = reviewLabel;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  })
  const reviewLabel = runInNewContext(outputText + '\nresult', { result: undefined })
  const row = source.match(/<span className="text-\[#333\] text-xs mr-3">.*reviewLabel.*<\/span>/)?.[0]
  assert.ok(row)
  const label = (source_kind: string | null, timingUnconfirmed = false) => render(row, {
    unconfirmedIds: new Set(timingUnconfirmed ? ['lead'] : []),
    l: { id: 'lead', source_kind, review_reason: 'source_review_required' }, reviewLabel, reviewTimingCopy,
  })
  assert.match(label(null), /couldn&#x27;t confirm the signal/)
  assert.doesNotMatch(label(null), /Manually supplied/)
  assert.match(label('manual_source'), /Review the source.*whether you have permission to contact them/)
  assert.match(label('hiring_feed'), /public job posting/)
  assert.match(label(null, true), /Event timing and current need are unconfirmed/)
})

test('held cards have no Approve button, eligible cards still do', () => {
  const actions = source.match(/<div [^\n]*data-testid="card-actions">[\s\S]*?<\/div>/)?.[0]
  assert.ok(actions)
  const html = (ok: boolean) => render(actions, {
    c: { approve: { ok, reason: 'No verified email' } }, l: { id: 'lead' },
    approving: {}, approved: {}, rejecting: null, Icon: () => null,
  })
  assert.doesNotMatch(html(false), />Approve<\/button>/)
  assert.match(html(true), />Approve<\/button>/)
})

test('a person with no title has only one separator before their source', () => {
  const component = source.match(/function PersonLine[\s\S]*?\n}/)?.[0]
  assert.ok(component)
  const html = render('(' + component + ')({ p: { name: "Buyer", title: null, source: "https://example.test" } })', {
    personBasis: () => 'Source page',
  })
  assert.match(html, /Buyer<\/span> · <a/)
  assert.doesNotMatch(html, /· <\/span> ·/)
})
