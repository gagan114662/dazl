import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { discoverContact, discoverSources, isDiscoverLead, isPageProvenEmail, PAGE_PROVEN_EMAIL_LABEL } from '../lib/discover/card.ts'
import { displayedEmailSource, emailsInText, publishedEmail } from '../lib/outreach/published-email.ts'

const url = 'https://example.com/about'
const email = 'buyer@example.com'

test('a legacy published Discovery email remains visible with its source without qualifying as newly page-proven', () => {
  const row = { connector: 'discover', kind: 'email', value: email, source_url: url, label: 'published on a public page' }
  const lead = { source_kind: 'discover', name: 'Dana Buyer', enrichments: [row] }
  assert.equal(isPageProvenEmail(row), false)
  assert.deepEqual(discoverContact(lead)?.email, { address: email, source: url })
  assert.deepEqual(discoverSources(lead), [{ field: 'email', label: 'Email', url }])
  for (const source_url of [null, 'javascript:alert(1)', 'https://user:password@example.com/about']) {
    assert.equal(discoverContact({ ...lead, enrichments: [{ ...row, source_url }] })?.email, null)
  }
})

test('a proof-marked email supplies its own source and a raw guess stays hidden', () => {
  const row = { connector: 'discover', kind: 'email', value: email, source_url: url, label: PAGE_PROVEN_EMAIL_LABEL }
  const proven = { source_kind: 'discover', name: 'Dana Buyer', enrichments: [row] }
  assert.deepEqual(discoverContact(proven)?.email, { address: email, source: url })
  assert.deepEqual(discoverSources(proven), [{ field: 'email', label: 'Email', url }])

  for (const address of [email, 'buyer@other.example']) {
    const guessed = { ...proven, enrichments: [{ ...row, value: address, label: 'guessed' }] }
    assert.equal(discoverContact(guessed)?.email, null)
    assert.deepEqual(discoverSources(guessed), [])
  }
})

test('legacy contact citations use the crawl page or the evidence that contains the address', () => {
  const lead = { contact: email, source_url: url, evidence_excerpt: 'Media contact: press@example.com.' }
  assert.equal(displayedEmailSource(lead, email), null)
  assert.equal(displayedEmailSource({ ...lead, evidence_excerpt: 'Contact: Buyer@example.com.' }, email), url)
  const crawl = { connector: 'sitecrawl', kind: 'email', value: email, source_url: 'https://example.com/team' }
  assert.equal(displayedEmailSource({ ...lead, enrichments: [crawl] }, email), crawl.source_url)
  assert.equal(displayedEmailSource({ ...lead, enrichments: [{ ...crawl, source_url: 'javascript:alert(1)' }] }, email), null)
})

test('the lead card disables Approve when the recipient source is hidden', () => {
  const filename = new URL('../app/app/leads/leads-client.tsx', import.meta.url)
  const source = ts.createSourceFile('leads-client.tsx', readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function find(node: ts.Node): ts.JsxElement | undefined {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'button' &&
        node.children.some(child => ts.isJsxText(child) && child.getText(source).trim() === 'Approve')) return node
    return node.forEachChild(find)
  }
  const button = find(source)
  assert.ok(button)
  let parent: ts.Node = button
  while (!ts.isBlock(parent) || !parent.statements.some(statement => statement.getText(source).startsWith('const lp ='))) parent = parent.parent
  const contactPersonIndex = parent.statements.findIndex(statement => statement.getText(source).startsWith('const lp ='))
  const declarations = parent.statements.slice(contactPersonIndex + 1)
    .filter(ts.isVariableStatement).map(statement => statement.getText(source))
  const compiled = ts.transpileModule(`${declarations.join('\n')}
exports.button = (${button.getText(source)})`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const render = (evidence_excerpt: string) => {
    const exports = { button: null }
    vm.runInNewContext(compiled, { exports, require: createRequire(import.meta.url),
      l: { id: 'proof', contact: email, source_url: url, evidence_excerpt }, lp: null,
      c: { contact: email, contactNoPerson: email, approve: { ok: true } },
      approving: {}, approved: {}, Icon: () => null, displayedEmailSource, discoverContact, emailsInText, isDiscoverLead, publishedEmail,
    })
    return renderToStaticMarkup(exports.button)
  }
  assert.match(render('The page lists press@example.com.'), /disabled=""/)
  assert.doesNotMatch(render(`Contact Dana at ${email}.`), /disabled=""/)
})
