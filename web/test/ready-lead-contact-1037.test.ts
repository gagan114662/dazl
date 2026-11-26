import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { NO_BUYER, personBasis, type LeadPerson } from '../lib/people/lead-person.ts'

const source = ts.createSourceFile('leads-client.tsx',
  readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'PersonLine')
assert.ok(component)
const compiled = ts.transpileModule(`${component.getText(source)}\nexports.render = PersonLine`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const exports = {} as { render(props: { p: LeadPerson | null }): ReturnType<typeof import('react').createElement> }
vm.runInNewContext(compiled, { exports, require: createRequire(import.meta.url), NO_BUYER, personBasis })
const markup = (p: LeadPerson | null) => renderToStaticMarkup(exports.render({ p }))

const buyer: LeadPerson = {
  name: 'Riley Example', title: 'Head of Sales', linkedin: 'https://www.linkedin.com/in/riley-example',
  source: 'https://example.test/team', via: 'named on a public page', current: false,
}

test('a contact with a title and profile exposes both on the lead row', () => {
  const html = markup(buyer)
  assert.match(html, /Riley Example/)
  assert.match(html, /Head of Sales/)
  assert.match(html, /href="https:\/\/www\.linkedin\.com\/in\/riley-example"/)
  assert.doesNotMatch(html, /not found/)
})

test('a name without a title or profile keeps its source and calls out both gaps', () => {
  const html = markup({ ...buyer, title: '', linkedin: null })
  assert.match(html, /Riley Example/)
  assert.match(html, /No job title or LinkedIn profile found/)
  assert.match(html, /href="https:\/\/example\.test\/team"/)
  assert.doesNotMatch(html, /data-testid="lead-person-linkedin"/)
})

test('a contact with only one missing field names that gap', () => {
  assert.match(markup({ ...buyer, linkedin: null }), /No LinkedIn profile found/)
  assert.match(markup({ ...buyer, title: ' ' }), /No job title found/)
})

test('an unnamed lead plainly says no buyer was named', () => {
  assert.match(markup(null), /No buyer named yet/)
})
