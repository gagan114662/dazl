import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { reviewListSplit } from '../lib/scan/leads-view.ts'

const source = ts.createSourceFile('leads-client.tsx',
  readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function renderResearchIntro() {
  function find(node: ts.Node): ts.JsxElement | undefined {
    if (ts.isJsxElement(node) && node.openingElement.attributes.getText(source).includes('data-testid="research-intro"')) return node
    return node.forEachChild(find)
  }
  const intro = find(source)
  assert.ok(intro)
  const compiled = ts.transpileModule(`exports.intro = (${intro.getText(source)})`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = { intro: null }
  vm.runInNewContext(compiled, { exports, require: createRequire(import.meta.url) })
  return renderToStaticMarkup(exports.intro)
}

test('a dated lead with no named buyer stays visible in Research with truthful copy', () => {
  const lead = { id: 'saved', source_kind: 'discover', review_reason: 'no_buyer_named',
    event_date: new Date().toISOString().slice(0, 10), human_confirmed_at: 30 }
  assert.deepEqual(reviewListSplit([lead]), { review: [], research: [lead] })
  assert.match(source.getText(), /no_buyer_named: 'No buyer named yet'/)
  assert.match(renderResearchIntro(), /no buyer was named/)
  assert.doesNotMatch(renderResearchIntro(), /could not verify a current, dated event.*for these leads/)
})
