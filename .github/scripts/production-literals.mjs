import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { posix } from 'node:path'

const ts = createRequire(new URL('../../web/package.json', import.meta.url))('typescript')
const normal = value => value.trim().normalize('NFC').toLowerCase()
const fields = {
  location: new Set(['location', 'locations', 'where', 'targetLocation', 'targetLocations']),
  region: new Set(['region', 'regions', 'targetRegion', 'defaultRegion', 'fallbackRegion', 'targetRegions']),
  country: new Set(['country', 'countries', 'countryCode', 'countryCodes', 'targetCountry', 'targetCountries', 'defaultCountry', 'fallbackCountry']),
  company: new Set(['company', 'companies', 'companyName', 'companyNames', 'targetCompany', 'targetCompanies', 'defaultCompany', 'fallbackCompany', 'employer', 'employers', 'employerName', 'organization', 'organizationName', 'businessName']),
  case_tuning: new Set(['caseId', 'evalCase', 'evalCaseId', 'benchmarkCase', 'benchmarkCaseId', 'scorecardCase', 'scorecardCaseId', 'evalCaseIndex', 'evalCaseOrdinal', 'scorecardCaseIndex', 'scorecardCaseOrdinal', 'benchmarkCaseIndex', 'benchmarkCaseOrdinal', 'perCase', 'perCaseTuning', 'caseTuning', 'caseOverrides', 'benchmarkOverrides', 'evalOverrides']),
  city: new Set(['city', 'cities', 'targetCity', 'defaultCity', 'fallbackCity', 'targetCities']),
  industry: new Set(['industry', 'industries', 'targetIndustry', 'defaultIndustry', 'fallbackIndustry', 'targetIndustries', 'sector', 'sectors', 'targetSector', 'defaultSector', 'fallbackSector', 'category', 'categories', 'targetCategory', 'targetCategories']),
}
const tuningContainers = new Set(['perCase', 'perCaseTuning', 'caseTuning', 'caseOverrides', 'benchmarkOverrides', 'evalOverrides'])
const MAX_FILES = 4096, MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024
const reviewedPolicyPath = '.github/policy/production-literals.json'

export const sourcePath = path =>
  /^web\/(?:lib|app|components)\//.test(path) &&
  /\.[cm]?[jt]sx?$/.test(path) &&
  !/(?:^|\/)(?:__tests__|__fixtures__|tests?|fixtures?|docs|generated)(?:\/|\.)|\.(?:test|spec|fixture|stories|d)\.[cm]?[jt]sx?$/.test(path)

const transparentValue = n => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) ||
  ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)
function unwrapParens(n) {
  while (n && transparentValue(n)) n = n.expression
  return n
}
function outerValue(n) {
  while (n.parent && transparentValue(n.parent) && n.parent.expression === n) n = n.parent
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
function accessField(n, checker, depth = 0) {
  n = unwrapParens(n)
  if (ts.isPropertyAccessExpression(n)) return fieldName(n.name)
  if (ts.isElementAccessExpression(n)) return literalKey(n.argumentExpression)
  if (!ts.isIdentifier(n)) return null
  if (kindOf(n.text) || !checker || depth >= 3) return n.text
  const d = checker.getSymbolAtLocation(n)?.valueDeclaration
  if (d && ts.isVariableDeclaration(d) && (d.parent.flags & ts.NodeFlags.Const) && d.initializer)
    return accessField(d.initializer, checker, depth + 1)
  if (d && ts.isBindingElement(d) && ts.isObjectBindingPattern(d.parent) &&
      ts.isVariableDeclaration(d.parent.parent) && (d.parent.parent.parent.flags & ts.NodeFlags.Const))
    return fieldName(d.propertyName ?? d.name)
  return n.text
}
const kindOf = field => Object.keys(fields).find(k => fields[k].has(field))
const ordinalFields = new Set(['evalCase', 'benchmarkCase', 'scorecardCase', 'evalCaseIndex', 'evalCaseOrdinal', 'scorecardCaseIndex', 'scorecardCaseOrdinal', 'benchmarkCaseIndex', 'benchmarkCaseOrdinal'])
const rangeComparisons = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
])
const stringHelpers = new Set(['includes', 'startsWith', 'endsWith'])
function intentField(node, checker, depth = 0) {
  const n = unwrapParens(node)
  if (n && ts.isCallExpression(n) && depth < 4 && ts.isPropertyAccessExpression(n.expression) && n.arguments.length === 0 &&
      ['trim', 'toLowerCase', 'toUpperCase', 'normalize'].includes(n.expression.name.text))
    return intentField(n.expression.expression, checker, depth + 1)
  return accessField(n, checker)
}
function matchSlot(node, checker) {
  node = outerValue(node)
  const p = node.parent
  if (!p) return null
  if (ts.isPropertyAccessExpression(p) && p.expression === node && fieldName(p.name) === 'test') {
    const member = outerValue(p), call = member.parent
    if (call && ts.isCallExpression(call) && call.expression === member && call.arguments.length === 1) {
      const field = intentField(call.arguments[0], checker)
      if (kindOf(field) && kindOf(field) !== 'case_tuning') return { field, role: 'regex_test' }
    }
  }
  if (ts.isCallExpression(p) && p.arguments[0] === node) {
    const member = unwrapParens(p.expression)
    if (ts.isPropertyAccessExpression(member) && stringHelpers.has(member.name.text)) {
      const field = intentField(member.expression, checker)
      if (kindOf(field) && kindOf(field) !== 'case_tuning') return { field, role: 'string_' + member.name.text }
    }
  }
  if (ts.isArrayLiteralExpression(p)) {
    const array = outerValue(p), member = array.parent
    if (member && ts.isPropertyAccessExpression(member) && member.expression === array && member.name.text === 'includes') {
      const method = outerValue(member), call = method.parent
      if (call && ts.isCallExpression(call) && call.expression === method) {
        const field = intentField(call.arguments[0], checker)
        if (kindOf(field) && kindOf(field) !== 'case_tuning') return { field, role: 'literal_membership' }
      }
    }
  }
  return null
}
const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
])
const staticAssignments = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
])
function typedSlot(node, checker) {
  let cur = node
  for (let i = 0; cur.parent && i < 7; i++) {
    const p = cur.parent
    if (ts.isCaseClause(p) && p.expression === cur && ts.isSwitchStatement(p.parent.parent)) {
      const field = intentField(p.parent.parent.expression, checker)
      return field ? { field, role: 'switch_case' } : null
    }
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
      if (staticAssignments.has(op) && p.right === cur) {
        const field = accessField(p.left, checker)
        return field ? { field, role: 'assignment' } : null
      }
      if (comparisons.has(op) || rangeComparisons.has(op)) {
        const field = intentField(p.right === cur ? p.left : p.right, checker)
        return field && (comparisons.has(op) || ordinalFields.has(field)) ? { field, role: 'comparison' } : null
      }
      if (![ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return null
    } else if (!(ts.isArrayLiteralExpression(p) || (transparentValue(p) && p.expression === cur) || ts.isJsxExpression(p)
      || (ts.isConditionalExpression(p) && p.condition !== cur))) return null
    cur = p
  }
  return null
}

function reviewed(policy) {
  if (!policy || policy.version !== 2 || Object.keys(policy).sort().join(',') !== 'grandfathering,version' ||
      policy.grandfathering !== 'trusted_same_path_slot_counts') throw Error('invalid reviewed production-literal policy')
}
function sourceOnlyChecker(path, ast) {
  const host = {
    getSourceFile: name => name === path ? ast : undefined,
    getDefaultLibFileName: () => '/unavailable.d.ts',
    writeFile: () => { throw Error('unexpected compiler output') },
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: name => name === path,
    readFile: () => undefined,
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  // Only bind the one blob in memory. No imports, configs, plugins, resolution,
  // candidate checkout, execution, or candidate-selected compiler options.
  return ts.createProgram([path], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker()
}
function tuningAccess(node, checker) {
  for (let n = unwrapParens(node), i = 0; n && i < 6; i++, n = unwrapParens(n.expression)) {
    const field = accessField(n, checker)
    if (tuningContainers.has(field)) return field
    if (!ts.isPropertyAccessExpression(n) && !ts.isElementAccessExpression(n)) return null
  }
  return null
}
function objectAssignTuning(call, source, checker) {
  // Static writes via the native builtin, not a locally shadowed Object method
  // or the target argument (a read). No evaluating/merging candidate objects.
  if (!ts.isCallExpression(call) || call.arguments.length < 2 || call.arguments.indexOf(source) < 1) return null
  const method = unwrapParens(call.expression)
  if (!(ts.isPropertyAccessExpression(method) || ts.isElementAccessExpression(method)) || accessField(method) !== 'assign') return null
  const receiver = unwrapParens(method.expression)
  if (!ts.isIdentifier(receiver) || receiver.text !== 'Object' || checker.getSymbolAtLocation(receiver)) return null
  return tuningAccess(call.arguments[0], checker)
}
function tuningSlot(node, checker) {
  for (let cur = node, depth = 0; cur.parent && depth < 10; cur = cur.parent, depth++) {
    const p = cur.parent
    if (ts.isPropertyAssignment(p) || ts.isVariableDeclaration(p) || ts.isParameter(p)) {
      const field = fieldName(p.name)
      if (tuningContainers.has(field)) return { field, role: 'per_case_literal' }
    }
    if (ts.isElementAccessExpression(p) && p.argumentExpression === cur) {
      const field = tuningAccess(p.expression, checker)
      if (field) return { field, role: 'per_case_index' }
    }
    if (ts.isBinaryExpression(p) && p.right === cur && staticAssignments.has(p.operatorToken.kind)) {
      const field = tuningAccess(p.left, checker)
      if (field) return { field, role: 'per_case_literal' }
    }
    const assigned = objectAssignTuning(p, cur, checker)
    if (assigned) return { field: assigned, role: 'per_case_literal' }
    if (ts.isFunctionLike(p) || ts.isStatement(p)) break
  }
  return null
}
function context(n) {
  const keys = []
  for (let p = n.parent, depth = 0; p && depth < 16; p = p.parent, depth++) {
    if (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)) {
      const key = fieldName(p.name)
      if (key) keys.push(key)
      if (keys.length === 4) break
    }
  }
  return keys
}
function diagnosticWhere(n, slot, checker, path) {
  if (slot?.field !== 'where' || slot.role !== 'property') return false
  // Dazl's imported captureError(where) is a logging tag, not targeting.
  // Limit the exemption to its exact inline context argument and import binding.
  const prop = n.parent, object = prop?.parent, call = object?.parent
  if (!prop || !ts.isPropertyAssignment(prop) || !object || !ts.isObjectLiteralExpression(object) ||
      !call || !ts.isCallExpression(call) || call.arguments[1] !== object || !ts.isIdentifier(call.expression)) return false
  const declaration = checker?.getSymbolAtLocation(call.expression)?.declarations?.[0]
  if (!declaration || !ts.isImportSpecifier(declaration) || (declaration.propertyName ?? declaration.name).text !== 'captureError') return false
  const imported = declaration.parent.parent.parent
  if (!ts.isImportDeclaration(imported) || !ts.isStringLiteral(imported.moduleSpecifier)) return false
  const name = imported.moduleSpecifier.text
  const normalized = name.startsWith('@/') ? 'web/' + name.slice(2) :
    name.startsWith('.') ? posix.normalize(posix.join(posix.dirname(path), name)) : ''
  return normalized === 'web/lib/ops/errors' || normalized === 'web/lib/ops/errors.ts'
}
// A pattern consisting solely of generic work modes is a proof-quality control,
// not a city, region, country or scorecard identity. Mixed patterns still fail.
const genericWorkModes = new Set(['remote', 'hybrid', 'multiple locations', 'onsite', 'on-site', 'on site'])
function workModeOnlyPattern(literal) {
  const match = /^\/\\b\((?:\?:)?([a-z |\-]+)\)\\b\/[iu]*$/i.exec(literal)
  return !!match && match[1].toLowerCase().split('|').every(term => genericWorkModes.has(term.trim()))
}
function inventory(path, source) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw Error(`cannot parse ${path}`)
  let checker
  const out = new Map()
  function remember(n, slot, payload) {
    const kind = kindOf(slot?.field)
    if (!kind || !normal(payload) || diagnosticWhere(n, slot, checker, path)) return
    if (kind === 'location' && slot.role === 'regex_test' && workModeOnlyPattern(payload)) return
    const key = JSON.stringify([kind, payload, slot.field, slot.role, context(n)])
    const value = out.get(key) ?? { kind, literal: payload, field: slot.field, role: slot.role, lines: [] }
    value.lines.push(ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1); out.set(key, value)
  }
  function walk(n) {
    const direct = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
    const regex = ts.isRegularExpressionLiteral(n)
    const numeric = ts.isNumericLiteral(n)
    const other = numeric || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(n.kind)
    const propKey = n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n && ts.isIdentifier(n)
    if (direct || regex || other || propKey) {
      checker ??= sourceOnlyChecker(path, ast)
      const tuning = tuningSlot(n, checker)
      if (tuning) remember(n, tuning, n.text ?? n.getText(ast))
      else if (direct || regex || numeric) {
        const operand = numeric && ts.isPrefixUnaryExpression(n.parent) ? n.parent : n
        const matcher = matchSlot(n, checker)
        const slot = regex ? (matcher?.role === 'regex_test' ? matcher : null) :
          numeric ? typedSlot(operand, checker) : (matcher?.role === 'regex_test' ? null : (matcher ?? typedSlot(n, checker)))
        if (!numeric || ordinalFields.has(slot?.field)) remember(n, slot, operand === n ? n.text : operand.getText(ast))
      }
    }
    // A local const value (not an import/parameter or mutable/reassigned
    // variable) flowing directly into an explicit operational slot.
    if (ts.isIdentifier(n) && n.parent && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n)) {
      checker ??= sourceOnlyChecker(path, ast)
      const slot = matchSlot(n, checker) ?? typedSlot(n, checker)
      if (kindOf(slot?.field)) {
        const d = checker.getSymbolAtLocation(n)?.valueDeclaration
        if (d && ts.isVariableDeclaration(d) && (d.parent.flags & ts.NodeFlags.Const)) {
          const ini = unwrapParens(d.initializer)
          const payload = slot.role === 'regex_test' ? (ini && ts.isRegularExpressionLiteral(ini) ? ini.text : null) :
            ordinalFields.has(slot.field) && ini && ts.isNumericLiteral(ini) ? ini.text : literalKey(ini)
          if (payload !== null) remember(n, { ...slot, role: 'const_alias_' + slot.role }, payload)
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(ast)
  return out
}
export function checkChanges(changes, policy) {
  reviewed(policy)
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
    // Only the exact existing production path can grandfather a slot. Moves
    // or copies may change behavior and do not import another path's inventory.
    const old = inventory(beforePath, beforePath === path ? before : '')
    // Compare stable AST slot/role, not line number. Distinct new slots cannot
    // use a removed slot's count or carry the catalog exception into a runtime neighbor.
    const additions = new Map()
    for (const [key, row] of inventory(path, after)) {
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
      path, ...row, receipt: null,
    }))
  })
}

// Explicit SHA-only entrypoint; not wired to a workflow. Read policy from reviewed base,
// not HEAD. For eventual CI run the reviewed checker too, never execute PR-modified gate code.
export function fromGit(base, head, git = (...args) => execFileSync('git', args, {encoding:'utf8',maxBuffer:32*1024*1024,timeout:12000}), policySha = base) {
  if (![base, head, policySha].every(x => /^[a-f0-9]{40}$/.test(x ?? '')) || (policySha !== base && policySha !== head))
    throw Error('expected full reviewed base and head SHAs')
  const policy = JSON.parse(git('show', `${policySha}:${reviewedPolicyPath}`))
  const names = git('diff', '--name-status', '-z', '--find-renames=100%', base, head, '--').split('\0')
  const changes = []
  let bytes = 0
  const blob = (commit, path) => {
    const mode = git('ls-tree', '--format=%(objectmode)', commit, '--', path).trim()
    if (mode !== '100644' && mode !== '100755') throw Error('unexpected production source mode')
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
    const before = status === 'M' && sourcePath(oldPath) ? blob(base, oldPath) : ''
    changes.push({path, beforePath: oldPath, before, after: blob(head, path)})
  }
  return checkChanges(changes, policy)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = fromGit(process.argv[2], process.argv[3], undefined, process.argv[4])
    console.log(JSON.stringify(report.map(({ kind, added, receipt }) => ({ kind, added, receipt }))))
    if (report.some(row => !row.receipt)) process.exitCode = 1
  } catch { console.error('Production-literal scan unavailable. No pass recorded.'); process.exitCode = 2 }
}
