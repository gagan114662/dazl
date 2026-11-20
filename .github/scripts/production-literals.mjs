import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ts = createRequire(new URL('../../web/package.json', import.meta.url))('typescript')
const normal = value => value.trim().normalize('NFC').toLowerCase()
const fields = {
  city: new Set(['city', 'cities', 'targetCity', 'defaultCity', 'fallbackCity', 'targetCities']),
  industry: new Set(['industry', 'industries', 'targetIndustry', 'defaultIndustry', 'fallbackIndustry', 'targetIndustries', 'sector', 'sectors', 'targetSector', 'defaultSector', 'fallbackSector']),
}
// Only specifically named direct city/industry identities default-deny unlisted literals.
// Generic sector slots retain the narrower reviewed-label coverage they had before.
const strongIdentity = new Set([...fields.city, ...[...fields.industry].filter(field => /industr/i.test(field))])
const MAX_FILES = 4096, MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const DESIGNATED_CATALOG = 'web/lib/sources/registry-source-catalog.ts'
const reviewedPolicyPath = '.github/policy/production-literals.json'

const legacyTermPath = /^web\/lib\/(?:scan|research|sources|search|discovery|connectors)\//
export const sourcePath = path =>
  /^web\/(?:lib|app|components)\//.test(path) &&
  /\.[cm]?[jt]sx?$/.test(path) &&
  !/(?:^|\/)(?:__tests__|__fixtures__|tests?|fixtures?|docs|generated)(?:\/|\.)|\.(?:test|spec|fixture|stories|d)\.[cm]?[jt]sx?$/.test(path)

function unwrapParens(n) {
  for (let i = 0; n && ts.isParenthesizedExpression(n) && i < 7; i++) n = n.expression
  return n
}
function literalKey(n) {
  n = unwrapParens(n)
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null
}
function fieldName(n) {
  if (!n) return null
  if (ts.isComputedPropertyName(n)) return literalKey(n.expression)
  return ts.isIdentifier(n) ? n.text : literalKey(n)
}
function accessField(n) {
  n = unwrapParens(n)
  if (ts.isPropertyAccessExpression(n)) return fieldName(n.name)
  if (ts.isElementAccessExpression(n)) return literalKey(n.argumentExpression)
  return ts.isIdentifier(n) ? n.text : null
}
const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
])
function typedSlot(node) {
  let cur = node
  for (let i = 0; cur.parent && i < 7; i++) {
    const p = cur.parent
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isParameter(p) || ts.isJsxAttribute(p)) && p.initializer === cur) {
      const field = fieldName(p.name)
      return field ? { field, role: ts.isVariableDeclaration(p) ? 'variable' : ts.isPropertyAssignment(p) ? 'property' : ts.isParameter(p) ? 'parameter' : 'jsx' } : null
    }
    if (ts.isBindingElement(p) && ts.isObjectBindingPattern(p.parent) && p.initializer === cur) {
      // Govern the object key, not a local alias. A computed key must be statically literal.
      const field = fieldName(p.propertyName ?? p.name)
      return field ? { field, role: 'binding_default' } : null
    }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind
      if (op === ts.SyntaxKind.EqualsToken && p.right === cur) {
        const field = accessField(p.left)
        return field ? { field, role: 'assignment' } : null
      }
      if (comparisons.has(op)) {
        const field = accessField(p.right === cur ? p.left : p.right)
        return field ? { field, role: 'comparison' } : null
      }
      if (![ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return null
    } else if (!(ts.isArrayLiteralExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isJsxExpression(p)
      || (ts.isConditionalExpression(p) && p.condition !== cur))) return null
    cur = p
  }
  return null
}

/** @typedef {{kind:'city'|'industry', label:string, source:string}} Term
 *  @typedef {{version:1, terms:Term[], registryPaths:string[], receipts:never[]}} Policy
 */
function reviewed(policy) {
  if (policy.version !== 1 || !Array.isArray(policy.terms) ||
      !Array.isArray(policy.registryPaths) || policy.registryPaths.length !== 1 || policy.registryPaths[0] !== DESIGNATED_CATALOG ||
      !Array.isArray(policy.receipts) || policy.receipts.length !== 0) throw Error('invalid reviewed production-literal policy')
  const terms = new Map()
  for (const t of policy.terms) {
    if (!Object.hasOwn(fields, t.kind) || typeof t.label !== 'string' || t.label.trim().length < 3 ||
        typeof t.source !== 'string' || !/^(?:https:\/\/|docs\/)/.test(t.source)) throw Error('invalid term source')
    const key = t.kind + '\0' + normal(t.label)
    if (terms.has(key)) throw Error('duplicate reviewed term')
    terms.set(key, t)
  }
  return terms
}
function inventory(path, source, terms) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw Error(`cannot parse ${path}`)
  const out = new Map()
  function walk(n) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const slot = typedSlot(n)
      const kind = Object.keys(fields).find(k => fields[k].has(slot?.field))
      if (kind && normal(n.text) && (strongIdentity.has(slot.field) || (legacyTermPath.test(path) && terms.has(kind + '\0' + normal(n.text))))) {
        const key = JSON.stringify([kind, n.text, slot.field, slot.role])
        const value = out.get(key) ?? { kind, literal: n.text, field: slot.field, role: slot.role, lines: [] }
        value.lines.push(ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1); out.set(key, value)
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(ast)
  return out
}
export function checkChanges(changes, policy) {
  const terms = reviewed(policy)
  if (!Array.isArray(changes) || changes.length > MAX_FILES) throw Error('oversize production literal comparison')
  let total = 0
  return changes.flatMap(({path, beforePath = path, before = '', after = ''}) => {
    if (!sourcePath(path)) return []
    for (const body of [before, after]) {
      if (typeof body !== 'string') throw Error('invalid production source blob')
      const size = Buffer.byteLength(body)
      total += size
      if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw Error('oversize production source blobs')
    }
    // A literal allowed as configuration did not previously exist as operational hardcoding.
    // Moving/copying the catalog to a sibling file must not inherit its grandfathered counts.
    const old = inventory(beforePath, beforePath === DESIGNATED_CATALOG && path !== DESIGNATED_CATALOG ? '' : before, terms)
    // Compare stable AST slot/role, not line number. Distinct new slots cannot
    // use a removed slot's count or carry the catalog exception into a runtime neighbor.
    const additions = new Map()
    for (const [key, row] of inventory(path, after, terms)) {
      const added = row.lines.length - (old.get(key)?.lines.length ?? 0)
      if (added <= 0) continue
      const literalKey = JSON.stringify([row.kind, row.literal])
      const result = additions.get(literalKey) ?? { kind: row.kind, literal: row.literal, added: 0, lines: [], slots: [] }
      result.added += added
      result.lines.push(...row.lines)
      result.slots.push({ field: row.field, role: row.role, added })
      additions.set(literalKey, result)
    }
    return [...additions.values()].map(row => ({
      path, ...row, receipt: path === DESIGNATED_CATALOG ? { authority: 'designated_catalog' } : null,
    }))
  })
}

// Explicit SHA-only entrypoint; not wired to a workflow. Read policy from reviewed base,
// not HEAD. For eventual CI run the reviewed checker too, never execute PR-modified gate code.
export function fromGit(base, head, git = (...args) => execFileSync('git', args, {encoding:'utf8',maxBuffer:32*1024*1024})) {
  if (![base, head].every(x => /^[a-f0-9]{40}$/.test(x ?? ''))) throw Error('expected full reviewed base and head SHAs')
  const policy = JSON.parse(git('show', `${base}:${reviewedPolicyPath}`))
  const names = git('diff', '--name-status', '-z', '--find-renames=100%', base, head, '--').split('\0')
  const changes = []
  let bytes = 0
  const blob = (commit, path) => {
    const body = git('show', `${commit}:${path}`)
    const size = Buffer.byteLength(body)
    bytes += size
    if (size > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) throw Error('oversize production source blobs')
    return body
  }
  for (let i = 0; i < names.length && names[i];) {
    const status = names[i++]; const oldPath = names[i++]
    const path = status.startsWith('R') ? names[i++] : oldPath
    if (!sourcePath(path) || status === 'D') continue
    if (!['R100','A','M'].includes(status)) throw Error(`unsupported status for production source: ${status} ${path}`)
    // Existing fixture moving into production is new production code, not grandfathered.
    if (changes.length >= MAX_FILES) throw Error('oversize production literal comparison')
    const before = status !== 'A' && sourcePath(oldPath) ? blob(base, oldPath) : ''
    changes.push({path, beforePath: oldPath, before, after: blob(head, path)})
  }
  return checkChanges(changes, policy)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = fromGit(process.argv[2], process.argv[3])
    console.log(JSON.stringify(report, null, 2))
    if (report.some(row => !row.receipt)) process.exitCode = 1
  } catch (e) { console.error(String(e)); process.exitCode = 2 }
}
