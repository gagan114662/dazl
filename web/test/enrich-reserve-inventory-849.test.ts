// Inventory of paid enrichment calls (#849, sibling of #848's scan inventory and #850's model inventory). Outside a scan
// the scan cap is a no-op (lib/scan/spend-cap.ts), so the workspace credit pool (lib/enrich/credit-pool.ts) is the only
// limit: every credit-charging Apollo / People Data Labs call must reserve credits first, in the same flow, before the
// request. Checked on the TypeScript syntax tree: which modules call the provider functions, and, per paid call, that
// a reservation comes before it. Behavioral refusals per entry point already exist (enrich-credit-pool: scan waterfall
// and commenter import; work-email-1036: the work-email lookup).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'

const ROOT = join(import.meta.dirname, '..')

// Credit-charging calls (lib/enrich/apollo.ts, lib/enrich/pdl.ts).
const VENDOR: Record<string, 'apollo' | 'pdl'> = { apolloOrgEnrich: 'apollo', apolloPersonMatch: 'apollo', pdlPeopleSearch: 'pdl', pdlPersonEnrich: 'pdl' }
const PAID = new Set(Object.keys(VENDOR))
// 0-credit by contract (lib/enrich/index.ts STEP 2, lib/scan/commenter-import.ts): no reservation needed.
const FREE = new Set(['apolloPeopleSearch'])
// The only modules allowed to call them.
const CALLERS = ['lib/enrich/index.ts', 'lib/people/work-email.ts', 'lib/scan/commenter-import.ts']
// Calls that reserve workspace credits (commenter-import's holdCredits wraps reserveCredits).
const RESERVE = new Set(['reserveCredits', 'holdCredits'])

function sources(dir: string): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...sources(p)); continue }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') })
  }
  return out
}
const SOURCES = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app'))]

const parse = (rel: string, text: string) => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
function all(root: ts.Node, pick: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = []
  const walk = (n: ts.Node): void => { if (pick(n)) out.push(n); ts.forEachChild(n, walk) }
  walk(root)
  return out
}
const calleeName = (c: ts.CallExpression): string | null => { const e = c.expression; return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null }
const enclosingFn = (n: ts.Node): ts.FunctionLikeDeclaration | null => { let p = n.parent; while (p && !ts.isFunctionLike(p)) p = p.parent; return (p as ts.FunctionLikeDeclaration) ?? null }
const fnName = (f: ts.FunctionLikeDeclaration): string | null => f.name && ts.isIdentifier(f.name) ? f.name.text : null

// Any use of a provider function counts (a call, or a reference handed elsewhere), so an alias cannot hide a caller.
// Local names bound to a provider function by an import, renamed or not (`import { apolloOrgEnrich as org }`).
function importAliases(sf: ts.SourceFile): Map<string, string> {
  const m = new Map<string, string>()
  for (const s of all(sf, n => ts.isImportSpecifier(n)) as ts.ImportSpecifier[]) {
    const orig = (s.propertyName ?? s.name).text
    if (PAID.has(orig) || FREE.has(orig)) m.set(s.name.text, orig)
  }
  return m
}
function providerUses(rel: string, text: string): { name: string; node: ts.Identifier }[] {
  const sf = parse(rel, text)
  const alias = importAliases(sf)
  const known = (t: string) => PAID.has(t) || FREE.has(t) || alias.has(t)
  return (all(sf, n => ts.isIdentifier(n) && known(n.text) && !ts.isImportSpecifier(n.parent) && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)) as ts.Identifier[])
    .filter(n => !(ts.isTypeQueryNode(n.parent)))
    .map(node => ({ name: alias.get(node.text) ?? node.text, node }))
}
function unexpectedCallers(srcs: { rel: string; text: string }[]): string[] {
  return srcs.filter(s => !s.rel.startsWith('lib/enrich/apollo') && !s.rel.startsWith('lib/enrich/pdl') && !CALLERS.includes(s.rel) && providerUses(s.rel, s.text).length > 0).map(s => s.rel)
}

// A reservation guards a later call only when ALL hold:
//  - it is a reserveCredits/holdCredits call in the SAME function (not a nested, possibly-uncalled one), and AWAITED;
//  - its provider argument (3rd), when a literal ('apollo' / 'pdl'), names the paid call's vendor (work-email passes a
//    variable from its provider loop, which is accepted);
//  - its statement dominates the call: the block that holds the statement also holds the call, after it. A reservation
//    inside try { } counts as its whole try statement, and only when the catch exits (return / continue / break /
//    throw), so a refused reservation cannot fall through to the call.
// Not checked (stated in the PR): a nullable result (commenter-import's holdCredits returns null on refusal) being
// tested before the call; the behavioral tests prove that stop per entry point.
const EXITS = (s: ts.Statement | undefined) => !!s && (ts.isReturnStatement(s) || ts.isContinueStatement(s) || ts.isBreakStatement(s) || ts.isThrowStatement(s))
function guards(fn: ts.FunctionLikeDeclaration, target: ts.Node, vendor: 'apollo' | 'pdl'): ts.CallExpression[] {
  return (all(fn, n => ts.isCallExpression(n) && RESERVE.has(calleeName(n) ?? '')) as ts.CallExpression[]).filter(r => {
    if (enclosingFn(r) !== fn || r.getStart() >= target.getStart()) return false
    let up: ts.Node = r.parent
    while (ts.isParenthesizedExpression(up)) up = up.parent
    if (!ts.isAwaitExpression(up)) return false
    const lit = r.arguments[2]
    if (lit && ts.isStringLiteralLike(lit) && lit.text !== vendor) return false
    let stmt: ts.Node = r
    while (stmt.parent && !(ts.isBlock(stmt.parent) || ts.isSourceFile(stmt.parent))) stmt = stmt.parent
    if (ts.isBlock(stmt.parent) && ts.isTryStatement(stmt.parent.parent) && stmt.parent.parent.tryBlock === stmt.parent) {
      const t = stmt.parent.parent
      const c = t.catchClause?.block.statements
      if (c && !EXITS(c[c.length - 1])) return false
      stmt = t
      while (stmt.parent && !(ts.isBlock(stmt.parent) || ts.isSourceFile(stmt.parent))) stmt = stmt.parent
    }
    const block = stmt.parent
    return !!block && target.getStart() >= stmt.getEnd() && target.getEnd() <= block.getEnd()
  })
}
// The variable an awaited reservation is stored in (`const hold = await reserveCredits(...)`, `hold = await ...`,
// `const hold = refused ? null : await holdCredits(...)`).
function boundName(r: ts.CallExpression): string | null {
  let up: ts.Node = r.parent
  while (ts.isParenthesizedExpression(up) || ts.isAwaitExpression(up) || ts.isConditionalExpression(up)) up = up.parent
  if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) return up.name.text
  if (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(up.left)) return up.left.text
  return null
}
function unreservedPaidCalls(rel: string, text: string): string[] {
  const sf = parse(rel, text)
  const alias = importAliases(sf)
  const paidName = (c: ts.CallExpression): string | null => { const n = calleeName(c); const o = n ? alias.get(n) ?? n : null; return o && PAID.has(o) ? o : null }
  const out: string[] = []
  for (const call of all(sf, n => ts.isCallExpression(n) && paidName(n) !== null) as ts.CallExpression[]) {
    const name0 = paidName(call)!
    const vendor = VENDOR[name0]
    const fn = enclosingFn(call)
    const line = sf.getLineAndCharacterOfPosition(call.getStart()).line + 1
    if (!fn) { out.push(`${rel}:${line} ${name0}`); continue }
    if (guards(fn, call, vendor).length > 0) continue
    // The CreditHold-parameter shape (index.ts runPdl): every call of this function must pass, at the CreditHold
    // position, exactly the variable a guarding reservation was stored in.
    const idx = fn.parameters.findIndex(p => p.type && /\bCreditHold\b/.test(p.type.getText(sf)))
    const name = fnName(fn)
    const uses = idx >= 0 && name ? all(sf, n => ts.isCallExpression(n) && calleeName(n) === name) as ts.CallExpression[] : []
    const passedReserved = uses.length > 0 && uses.every(u => {
      const f = enclosingFn(u); const arg = u.arguments[idx]
      return !!f && !!arg && ts.isIdentifier(arg) && guards(f, u, vendor).some(r => boundName(r) === arg.text)
    })
    if (!passedReserved) out.push(`${rel}:${line} ${name0}`)
  }
  return out
}

test('#849 inventory: only the known enrichment entry points call the Apollo / People Data Labs functions', () => {
  assert.deepEqual(unexpectedCallers(SOURCES), [], 'a new caller of a paid enrichment function must reserve workspace credits first and be listed here')
})

test('#849 inventory: a new caller is caught, however it reaches the function (the check is not vacuous)', () => {
  for (const text of ['await apolloOrgEnrich(k, { domain: d }, f)', 'const fn = pdlPeopleSearch\nawait fn(k, c, f, 5)', 'await run(apolloPersonMatch)',
    "import { apolloOrgEnrich as org } from '@/lib/enrich/apollo'\nawait org(k, o, f)"]) {
    assert.deepEqual(unexpectedCallers([{ rel: 'app/api/leads/x/route.ts', text }]), ['app/api/leads/x/route.ts'], text)
  }
})

test('#849 inventory: every credit-charging enrichment call reserves workspace credits before its request', () => {
  for (const rel of CALLERS) {
    const src = SOURCES.find(s => s.rel === rel)?.text
    assert.ok(src, `${rel} exists`)
    assert.ok(providerUses(rel, src!).length > 0, `${rel} still calls a provider (else drop it from CALLERS)`)
    assert.deepEqual(unreservedPaidCalls(rel, src!), [], `${rel}: reserve credits (reserveCredits) before each paid Apollo/PDL call`)
  }
})

test('#849 inventory: a paid call with no reservation before it is caught, also after one that has one', () => {
  const reserved = 'async function a() { const hold = await reserveCredits(db, t, "apollo", 1); await apolloOrgEnrich(k, o, f) }\n'
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', reserved), [])
  assert.equal(unreservedPaidCalls('lib/x.ts', 'async function b() { await apolloOrgEnrich(k, o, f); await reserveCredits(db, t, "apollo", 1) }').length, 1, 'reserving AFTER the call does not count')
  assert.equal(unreservedPaidCalls('lib/x.ts', reserved + 'async function c() { await pdlPersonEnrich(k, q, f) }').length, 1, 'a second, unreserved function in the same file')
  // the CreditHold-parameter shape (index.ts runPdl): fine only when every caller reserved first
  const viaParam = 'async function run(k: string, hold: CreditHold) { return pdlPeopleSearch(k, c, f, 5) }\n'
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', viaParam + 'async function go() { const hold = await reserveCredits(db, t, "pdl", 5); await run(k, hold) }'), [])
  assert.equal(unreservedPaidCalls('lib/x.ts', viaParam + 'async function go() { await run(k, fakeHold) }').length, 1, 'a caller that never reserved')
  // a renamed import is still a paid call; a reservation for the other vendor does not cover it
  assert.equal(unreservedPaidCalls('lib/x.ts', "import { apolloOrgEnrich as org } from './apollo.ts'\nasync function e() { await org(k, o, f) }").length, 1, 'renamed import, unreserved')
  assert.equal(unreservedPaidCalls('lib/x.ts', 'async function g() { const h = await reserveCredits(db, t, "pdl", 5); await apolloOrgEnrich(k, o, f) }').length, 1, 'PDL credits do not cover an Apollo call')
  // xhawk round 1: an un-awaited reservation, one in a nested function, one in a branch not taken, a try whose catch
  // falls through, and a CreditHold caller passing a hold other than the one it reserved
  assert.equal(unreservedPaidCalls('lib/x.ts', 'async function h() { const p = reserveCredits(db, t, "apollo", 1); await apolloOrgEnrich(k, o, f) }').length, 1, 'not awaited')
  assert.equal(unreservedPaidCalls('lib/x.ts', 'async function i() { const later = async () => { await reserveCredits(db, t, "apollo", 1) }; await apolloOrgEnrich(k, o, f) }').length, 1, 'nested function')
  assert.equal(unreservedPaidCalls('lib/x.ts', 'async function j(x: boolean) { if (x) { const h = await reserveCredits(db, t, "apollo", 1) } await apolloOrgEnrich(k, o, f) }').length, 1, 'branch not taken')
  assert.equal(unreservedPaidCalls('lib/x.ts', 'async function m() { let h; try { h = await reserveCredits(db, t, "apollo", 1) } catch { log() } await apolloOrgEnrich(k, o, f) }').length, 1, 'catch falls through')
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', 'async function n() { let h; try { h = await reserveCredits(db, t, "apollo", 1) } catch { return null } await apolloOrgEnrich(k, o, f) }'), [], 'catch exits: guarded')
  assert.equal(unreservedPaidCalls('lib/x.ts', viaParam + 'async function go2() { const unrelated = await reserveCredits(db, t, "pdl", 5); await run(k, fakeHold) }').length, 1, 'passes a hold it did not reserve')
  // the 0-credit people search needs no reservation
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', 'async function d() { await apolloPeopleSearch(k, o, f, 5) }'), [])
})
