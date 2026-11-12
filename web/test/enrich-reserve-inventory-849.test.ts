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
const PAID = new Set(['apolloOrgEnrich', 'apolloPersonMatch', 'pdlPeopleSearch', 'pdlPersonEnrich'])
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
function providerUses(rel: string, text: string): { name: string; node: ts.Identifier }[] {
  const sf = parse(rel, text)
  return (all(sf, n => ts.isIdentifier(n) && (PAID.has(n.text) || FREE.has(n.text)) && !ts.isImportSpecifier(n.parent) && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)) as ts.Identifier[])
    .filter(n => !(ts.isTypeQueryNode(n.parent)))
    .map(node => ({ name: node.text, node }))
}
function unexpectedCallers(srcs: { rel: string; text: string }[]): string[] {
  return srcs.filter(s => !s.rel.startsWith('lib/enrich/apollo') && !s.rel.startsWith('lib/enrich/pdl') && !CALLERS.includes(s.rel) && providerUses(s.rel, s.text).length > 0).map(s => s.rel)
}

// A paid call is reserved when, in its enclosing function, a reservation call comes before it; or the enclosing
// function takes a CreditHold parameter and every call of that function in the file is itself preceded by one.
function reservedBefore(fn: ts.FunctionLikeDeclaration, pos: number): boolean {
  return all(fn, n => ts.isCallExpression(n) && RESERVE.has(calleeName(n) ?? '') && n.getStart() < pos).length > 0
}
function unreservedPaidCalls(rel: string, text: string): string[] {
  const sf = parse(rel, text)
  const out: string[] = []
  for (const call of all(sf, n => ts.isCallExpression(n) && PAID.has(calleeName(n) ?? '')) as ts.CallExpression[]) {
    const fn = enclosingFn(call)
    const line = sf.getLineAndCharacterOfPosition(call.getStart()).line + 1
    if (!fn) { out.push(`${rel}:${line} ${calleeName(call)}`); continue }
    if (reservedBefore(fn, call.getStart())) continue
    const takesHold = fn.parameters.some(p => p.type && /\bCreditHold\b/.test(p.type.getText(sf)))
    const name = fnName(fn)
    const uses = name ? all(sf, n => ts.isCallExpression(n) && calleeName(n) === name) as ts.CallExpression[] : []
    const passedReserved = takesHold && uses.length > 0 && uses.every(u => { const f = enclosingFn(u); return !!f && reservedBefore(f, u.getStart()) })
    if (!passedReserved) out.push(`${rel}:${line} ${calleeName(call)}`)
  }
  return out
}

test('#849 inventory: only the known enrichment entry points call the Apollo / People Data Labs functions', () => {
  assert.deepEqual(unexpectedCallers(SOURCES), [], 'a new caller of a paid enrichment function must reserve workspace credits first and be listed here')
})

test('#849 inventory: a new caller is caught, however it reaches the function (the check is not vacuous)', () => {
  for (const text of ['await apolloOrgEnrich(k, { domain: d }, f)', 'const fn = pdlPeopleSearch\nawait fn(k, c, f, 5)', 'await run(apolloPersonMatch)']) {
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
  // the 0-credit people search needs no reservation
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', 'async function d() { await apolloPeopleSearch(k, o, f, 5) }'), [])
})
