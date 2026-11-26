import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { sourcePath } from './production-literals.mjs'

const ts = createRequire(new URL('../../web/package.json', import.meta.url))('typescript')
const normalized = value => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
const product = path => sourcePath(path) && /^web\/(app|lib)\//.test(path)
const test = path => /^web\/test\//.test(path) && /\.[cm]?[jt]sx?$/.test(path) &&
  !path.startsWith('web/test/fixtures/gate-check/')
const benchmarkFile = path => /^bench\/(results|fixtures)\/.+\.(?:json|jsonl|txt|md|csv)$/i.test(path)
const domainPattern = /(?<![\w-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}(?![\w-]|\.[a-z\d])/gi
const literal = node => node && (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) ||
  ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) ? node.text : undefined
const member = node => ts.isPropertyAccessExpression(node) ? node.name.text :
  ts.isElementAccessExpression(node) ? literal(node.argumentExpression) : undefined
const key = node => ts.isIdentifier(node) ? node.text : literal(node)
const envObject = node => node && member(node) === 'env' &&
  (node.expression.getText() === 'process' || node.expression.getText() === 'import.meta')
const testEnv = name => /^(?:CI|VITEST(?:_.*)?|NODE_TEST.*)$/.test(name ?? '')
const quote = value => value.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&')

function vocabulary(prompts, results) {
  const terms = new Set()
  const domains = new Set()
  function collect(value, field = '') {
    if (Array.isArray(value)) { for (const item of value) collect(item, field); return }
    if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) collect(item, name)
    } else if (typeof value === 'string') {
      const name = field.replace(/[_-]/g, '').toLowerCase()
      if (/^(?:company(?:names?)?|companies|query|queries)$/.test(name)) terms.add(normalized(value))
      if (/^(?:(?:company)?domains?|(?:company)?websites?)$/.test(name)) {
        for (const domain of value.match(domainPattern) ?? []) domains.add(normalized(domain))
      }
    }
  }
  collect(prompts)
  for (const result of results) for (const domain of result.match(domainPattern) ?? []) domains.add(normalized(domain))
  const words = [...terms].filter(Boolean).map(term => [term, new RegExp('(?:^|[^\\p{L}\\p{N}])' + quote(term) + '(?=$|[^\\p{L}\\p{N}])', 'u')])
  return { words, domains }
}

function inventory(path, source, vocab) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw new Error('Cannot parse ' + path)
  const findings = []
  const assertions = []
  const tests = new Set(['test', 'it', 'describe', 'suite', 'specify'])
  const asserts = new Set(['assert', 'expect'])
  const nodeEnvAliases = new Set()
  const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)) }
  const add = (list, node, rule, identity) => list.push({ path, rule, identity,
    line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
  const envKey = node => node.expression && envObject(node.expression) ? member(node) : undefined
  const print = ts.createPrinter({ removeComments: true })
  walk(ast, node => {
    if (ts.isImportDeclaration(node) && ['node:test', 'vitest', '@playwright/test', 'node:assert', 'node:assert/strict', 'assert', 'assert/strict'].includes(literal(node.moduleSpecifier))) {
      const bindings = node.importClause?.namedBindings
      const root = node.importClause?.name?.text
      if (root && literal(node.moduleSpecifier) === 'node:test') tests.add(root)
      if (root && /assert/.test(literal(node.moduleSpecifier))) asserts.add(root)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          const original = (item.propertyName ?? item.name).text
          if (tests.has(original)) tests.add(item.name.text)
          if (asserts.has(original) || /assert/.test(literal(node.moduleSpecifier))) asserts.add(item.name.text)
        }
      }
    }
    if (product(path) && ts.isVariableDeclaration(node) && node.initializer) {
      if (envKey(node.initializer) === 'NODE_ENV' && ts.isIdentifier(node.name)) nodeEnvAliases.add(node.name.text)
      if (envObject(node.initializer) && ts.isObjectBindingPattern(node.name)) {
        for (const part of node.name.elements) {
          const name = key(part.propertyName ?? part.name)
          if (testEnv(name)) add(findings, part, 'test-environment', name)
          if (name === 'NODE_ENV' && ts.isIdentifier(part.name)) nodeEnvAliases.add(part.name.text)
        }
      }
    }
  })
  const runner = expression => ts.isIdentifier(expression) ? tests.has(expression.text) :
    !!member(expression) && runner(expression.expression)
  const assertion = expression => ts.isIdentifier(expression) ? asserts.has(expression.text) :
    (ts.isCallExpression(expression) || !!member(expression)) && assertion(expression.expression)
  const nodeEnv = node => envKey(node) === 'NODE_ENV' || (ts.isIdentifier(node) && nodeEnvAliases.has(node.text))
  walk(ast, node => {
    if (product(path)) {
      const value = literal(node)
      if (value !== undefined && path !== 'web/lib/landing-examples.ts') {
        for (const [term, pattern] of vocab.words) if (pattern.test(normalized(value))) add(findings, node, 'bench-fixture', term)
        for (const host of new Set(value.match(domainPattern) ?? [])) {
          const labels = host.toLowerCase().split('.')
          const domain = labels.map((_, i) => labels.slice(i).join('.')).find(part => vocab.domains.has(part))
          if (domain) add(findings, node, 'bench-fixture', domain)
        }
      }
      if (testEnv(envKey(node))) add(findings, node, 'test-environment', envKey(node))
      if (ts.isBinaryExpression(node) &&
          ((nodeEnv(node.left) && literal(node.right) === 'test') || (nodeEnv(node.right) && literal(node.left) === 'test'))) {
        add(findings, node, 'test-environment', 'NODE_ENV=test')
      }
      if (ts.isSwitchStatement(node) && nodeEnv(node.expression) &&
          node.caseBlock.clauses.some(clause => ts.isCaseClause(clause) && literal(clause.expression) === 'test')) {
        add(findings, node, 'test-environment', 'NODE_ENV=test')
      }
    }
    if (!test(path)) return
    const method = member(node)
    if (['skip', 'only', 'todo'].includes(method) &&
        (runner(node.expression) || (ts.isCallExpression(node.parent) && node.parent.expression === node &&
          ['t', 'ctx', 'context'].includes(node.expression.getText(ast))))) {
      add(findings, node, 'test-modifier', method)
    }
    if (ts.isCallExpression(node)) {
      if (runner(node.expression)) for (const option of node.arguments.filter(ts.isObjectLiteralExpression)) {
        for (const property of option.properties) {
          if (ts.isPropertyAssignment(property) && ['skip', 'only', 'todo'].includes(key(property.name)) &&
              property.initializer.kind !== ts.SyntaxKind.FalseKeyword) add(findings, property, 'test-modifier', key(property.name))
        }
      }
      if (assertion(node.expression)) add(assertions, node, 'assertion-changed', print.printNode(ts.EmitHint.Unspecified, node, ast))
    }
  })
  return { findings, assertions }
}

function difference(rows, prior) {
  const counts = new Map()
  for (const row of prior) {
    const id = JSON.stringify([row.rule, row.identity])
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return rows.filter(row => {
    const id = JSON.stringify([row.rule, row.identity])
    if (!counts.get(id)) return true
    counts.set(id, counts.get(id) - 1)
    return false
  })
}

export function inspectChanges(changes, prompts, results, body = '', previousPrompts = prompts, previousResults = results) {
  const current = vocabulary(prompts, results)
  const previous = vocabulary(previousPrompts, previousResults)
  const documented = /^Superseded assertion:[ \t]*\S[^\r\n]*$/im.test(body) && /^Decision:[ \t]*\S[^\r\n]*$/im.test(body)
  const errors = [], warnings = []
  for (const { path, before = '', after = '' } of changes) {
    if (!product(path) && !test(path)) continue
    const old = inventory(path, before, previous), next = inventory(path, after, current)
    errors.push(...difference(next.findings, old.findings))
    if (!documented) warnings.push(...difference(old.assertions, next.assertions))
  }
  return { errors, warnings }
}

function fromGit(base, head, body) {
  if (![base, head].every(ref => /^[a-f\d]{40}$/.test(ref ?? ''))) throw new Error('Expected full Git SHAs')
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const paths = rev => git('ls-tree', '-rz', '--name-only', rev, '--', 'web/lib', 'web/app', 'web/test', 'bench').split('\0').filter(Boolean)
  const oldPaths = new Set(paths(base)), newPaths = new Set(paths(head))
  const changed = git('diff', '--name-only', '--no-renames', '-z', base, head).split('\0').filter(Boolean)
  const read = (rev, path) => git('show', rev + ':' + path)
  const prompts = rev => JSON.parse(read(rev, 'bench/prompts.json'))
  const results = (rev, files) => [...files].filter(benchmarkFile).map(path => read(rev, path))
  const compare = new Set(changed)
  if (changed.some(path => path === 'bench/prompts.json' || benchmarkFile(path))) {
    for (const path of newPaths) if (product(path)) compare.add(path)
  }
  const changes = [...compare].filter(path => product(path) || test(path)).map(path => ({
    path, before: oldPaths.has(path) ? read(base, path) : '', after: newPaths.has(path) ? read(head, path) : '',
  }))
  return inspectChanges(changes, prompts(head), results(head, newPaths), body, prompts(base), results(base, oldPaths))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const escape = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  const field = value => escape(value).replaceAll(',', '%2C').replaceAll(':', '%3A')
  try {
    const { errors, warnings } = fromGit(process.argv[2], process.argv[3], process.env.PR_BODY)
    for (const row of errors) console.log('::error file=' + field(row.path) + ',line=' + row.line + '::' + row.rule + ': ' + escape(row.identity))
    for (const row of warnings) console.log('::warning file=' + field(row.path) + '::Assertion removed or changed (base line ' + row.line + '). If intentional, name the superseded assertion and decision in the PR body.')
    console.log('no-hardcoded-fixtures: ' + errors.length + ' error(s), ' + warnings.length + ' warning(s)')
    if (errors.length) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
