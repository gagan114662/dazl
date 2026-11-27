import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile)
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
const moduleCache = ts.createModuleResolutionCache(root, file => file, options)

function runtimeImports(source: ts.SourceFile): string[] {
  const imports: string[] = []
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause
      const named = clause?.namedBindings
      if (!clause?.name && named && ts.isNamedImports(named) && named.elements.length && named.elements.every(item => item.isTypeOnly)) return
      if (ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause
      if (named && ts.isNamedExports(named) && named.elements.length && named.elements.every(item => item.isTypeOnly)) return
      imports.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return imports
}

test('client components do not reach node: imports through application code', () => {
  const roots = ts.sys.readDirectory(root, ['.ts', '.tsx'], ['**/node_modules', '**/.next', '**/test'], ['**/*'])
    .filter(file => {
      const first = parse(file).statements[0]
      return first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use client'
    })
  assert.ok(roots.length, 'client entry points found')
  const queue = roots.map(file => ({ file, chain: [relative(root, file)] }))
  const visited = new Set<string>()
  const violations: string[] = []
  for (const { file, chain } of queue) {
    if (visited.has(file)) continue
    visited.add(file)
    const source = parse(file)
    const first = source.statements[0]
    // Next replaces a server action with a client reference.
    if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use server') continue
    for (const specifier of runtimeImports(source)) {
      if (specifier.startsWith('node:')) violations.push([...chain, specifier].join(' → '))
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) continue
      const target = ts.resolveModuleName(specifier, file, options, ts.sys, moduleCache).resolvedModule
      if (target && !target.isExternalLibraryImport && !target.resolvedFileName.endsWith('.d.ts')) {
        queue.push({ file: target.resolvedFileName, chain: [...chain, relative(root, target.resolvedFileName)] })
      }
    }
  }
  assert.deepEqual(violations.sort(), [])
})

test('browser review decisions match server bindings for single and multiple addresses', async () => {
  const { domainReviewFor: browser } = await import('../lib/outreach/domain-review-view.ts')
  const { domainReviewFor: server, REVIEW_PREFIX } = await import('../lib/outreach/domain-review.ts')
  const lead = { id: 'test-lead', contact: null }
  const row = (kind: string, value: string, source_url: string | null) =>
    ({ connector: 'sitecrawl', kind, value, source_url, label: null, retrieved_at: 10 })
  const one = row('email', 'contact@buyer.example', 'https://buyer.example/équipe')
  const two = row('email', 'other@buyer.example', 'https://buyer.example/about')
  for (const rows of [[one], [one, two]]) {
    const review = server(lead, rows)
    assert.equal(review.state, 'required')
    assert.match(review.binding ?? '', /^[a-f0-9]{64}$/)
    assert.deepEqual(browser(lead, rows), review)
    const confirmed = [...rows, { ...one, connector: 'user', kind: 'domain_review', value: 'buyer.example', label: REVIEW_PREFIX + review.binding }]
    assert.equal(browser(lead, confirmed).state, 'confirmed')
    assert.deepEqual(browser(lead, confirmed), server(lead, confirmed))
  }
})
