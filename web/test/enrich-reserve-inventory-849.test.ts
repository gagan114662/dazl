// Inventory of paid enrichment calls (#849, sibling of #848's scan inventory and #850's model inventory). Outside a scan
// the scan cap is a no-op (lib/scan/spend-cap.ts), so the workspace credit pool (lib/enrich/credit-pool.ts) is the only
// limit: every credit-charging Apollo / People Data Labs call must reserve credits first, in the same flow, before the
// request. Checked on the TypeScript syntax tree: which modules call the provider functions, and, per paid call, that
// a reservation comes before it. Each reservation (of at least 1 unit, when the units are a literal) pays for exactly ONE
// paid call: a second call that can run under the same hold, or a call in a loop that does not also hold the
// reservation, needs its own; the same holds for a CreditHold handed to a helper (one paid call per hold received).
// Not checked: whether a non-literal unit count covers what the call charges, and the tenant.
// Behavioral refusals per entry point already exist (enrich-credit-pool: scan waterfall
// and commenter import; work-email-1036: the work-email lookup).
// Not caught: `Reflect.get(A, name)` and computed or concatenated keys (`A['apollo' + 'OrgEnrich']`, `A[key]`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import * as ts from 'typescript'

const ROOT = join(import.meta.dirname, '..')

// Credit-charging calls (lib/enrich/apollo.ts, lib/enrich/pdl.ts).
const VENDOR: Record<string, 'apollo' | 'pdl'> = { apolloOrgEnrich: 'apollo', apolloPersonMatch: 'apollo', pdlPeopleSearch: 'pdl', pdlPersonEnrich: 'pdl' }
const PAID = new Set(Object.keys(VENDOR))
// 0-credit by the credit pool's contract (lib/enrich/credit-pool.ts; lib/enrich/index.ts STEP 2,
// lib/scan/commenter-import.ts): no reservation needed.
const FREE = new Set(['apolloPeopleSearch'])
// The only modules allowed to call them.
const CALLERS = ['lib/enrich/index.ts', 'lib/people/work-email.ts', 'lib/scan/commenter-import.ts']
// The only modules allowed to hold a paid vendor's API origin.
// lib/people/zerobounce.ts (#899): the free-tier mailbox verifier's adapter, wired through verifierFromEnv and reserved by
// reserveVerifySlot (below) before every .verify call.
const VENDOR_MODULES = ['lib/enrich/apollo.ts', 'lib/enrich/pdl.ts', 'lib/people/zerobounce.ts']
// Paid API hosts: the two enrichment vendors, and the mailbox-verification APIs a verifierFromEnv adapter would call
// (none is wired today: no verifier host appears anywhere in the source).
const VENDOR_HOSTS = ['api.apollo.io', 'api.peopledatalabs.com', 'api.zerobounce.net', 'api.zerobounce.in', 'api.neverbounce.com', 'api.hunter.io',
  'api.kickbox.com', 'api.debounce.io', 'api.emailable.com', 'api.millionverifier.com', 'api.usebouncer.com', 'api.clearout.io', 'apps.emaillistverify.com',
  'api.bouncify.io', 'api.verifalia.com', 'api.mailboxvalidator.com', 'emailvalidation.abstractapi.com', 'apilayer.net']
// Modules that may NAME a vendor host, never as an origin (no scheme / `//`): the legal domain registry and the
// Settings hint text.
const HOST_NAMED = ['lib/legal/policy.ts', 'app/app/settings/enrichment-panel.tsx']

// Production code: lib/, app/, scripts/ (the worker process and operator scripts) and the root modules
// (instrumentation.ts, proxy.ts, configs). Test files are not production code.
const CODE = /\.((m|c)?ts|tsx|m?js)$/
type Src = { rel: string; text: string }
const relOf = (p: string) => relative(ROOT, p).split(sep).join('/')
function sources(dir: string, deep = true): Src[] {
  const out: Src[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (deep && name !== 'node_modules') out.push(...sources(p)); continue }
    if (CODE.test(name) && !/\.test\./.test(name)) out.push({ rel: relOf(p), text: readFileSync(p, 'utf8') })
  }
  return out
}
const SOURCES = [...['lib', 'app', 'scripts'].flatMap(d => sources(join(ROOT, d))), ...sources(ROOT, false)]

const parse = (rel: string, text: string) => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true,
  rel.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.m?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
function all(root: ts.Node, pick: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = []
  const walk = (n: ts.Node): void => { if (pick(n)) out.push(n); ts.forEachChild(n, walk) }
  walk(root)
  return out
}
const calleeName = (c: ts.CallExpression): string | null => {
  const e = bare(c.expression)
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : null
}
const enclosingFn = (n: ts.Node): ts.FunctionLikeDeclaration | null => { let p = n.parent; while (p && !ts.isFunctionLike(p)) p = p.parent; return (p as ts.FunctionLikeDeclaration) ?? null }
const fnName = (f: ts.FunctionLikeDeclaration): string | null => f.name && ts.isIdentifier(f.name) ? f.name.text : null
const bare = (e: ts.Expression): ts.Expression => { while (ts.isParenthesizedExpression(e)) e = e.expression; return e }
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1

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
function providerUses(rel: string, text: string): { name: string; node: ts.Node }[] {
  const sf = parse(rel, text)
  const alias = importAliases(sf)
  const known = (t: string) => PAID.has(t) || FREE.has(t) || alias.has(t)
  const ids = (all(sf, n => ts.isIdentifier(n) && known(n.text) && !ts.isImportSpecifier(n.parent) && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)) as ts.Identifier[])
    .filter(n => !(ts.isTypeQueryNode(n.parent)))
    .map(node => ({ name: alias.get(node.text) ?? node.text, node: node as ts.Node }))
  // The provider's name as any string literal is a use too: a bracket access (`A['apolloOrgEnrich']`), a computed
  // destructuring key (`const { ['apolloOrgEnrich']: f } = A`).
  const strings = (all(sf, n => ts.isStringLiteralLike(n) && (PAID.has(n.text) || FREE.has(n.text))) as ts.StringLiteralLike[])
    .map(n => ({ name: n.text, node: n as ts.Node }))
  return [...ids, ...strings]
}
function unexpectedCallers(srcs: Src[]): string[] {
  return srcs.filter(s => !VENDOR_MODULES.includes(s.rel) && !CALLERS.includes(s.rel) && providerUses(s.rel, s.text).length > 0).map(s => s.rel)
}

// A hard-coded paid-vendor origin (`https://api.apollo.io`, `//api.zerobounce.net`, a subdomain of one) outside the
// vendor modules is a new paid caller that bypasses the provider functions; a bare vendor host name only in HOST_NAMED.
// Not caught: a host assembled from pieces at runtime (`'api.' + 'apollo.io'`) or read from config.
function hardCodedOrigins(srcs: Src[]): string[] {
  const out: string[] = []
  for (const s of srcs) {
    if (VENDOR_MODULES.includes(s.rel)) continue
    for (const host of VENDOR_HOSTS) {
      const h = `(?:[\\w-]+\\.)*${host.replace(/\./g, '\\.')}(?![\\w-])`
      if (new RegExp(`//${h}`, 'i').test(s.text) || (!HOST_NAMED.includes(s.rel) && new RegExp(`(?<![\\w.-])${h}`, 'i').test(s.text))) out.push(`${s.rel}: ${host}`)
    }
  }
  return out
}

// Which local names reserve workspace credits: `reserveCredits` imported (renamed or not) from
// lib/enrich/credit-pool.ts, and, in lib/scan/commenter-import.ts only, its own `holdCredits` wrapper (which calls
// that import and returns null on refusal). A same-named local function or an import from elsewhere is not one.
type Reservers = { reserve: Set<string>; hold: Set<string> }
function resolveSpec(rel: string, spec: string): string | null {
  const p = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? posix.join(posix.dirname(rel), spec) : null
  return p ? p.replace(/\.ts$/, '') : null
}
function reservers(sf: ts.SourceFile, rel: string): Reservers {
  const reserve = new Set<string>(), hold = new Set<string>()
  for (const s of all(sf, n => ts.isImportSpecifier(n)) as ts.ImportSpecifier[]) {
    const decl = s.parent.parent.parent
    if (s.isTypeOnly || decl.importClause?.isTypeOnly || !ts.isStringLiteral(decl.moduleSpecifier)) continue
    if ((s.propertyName ?? s.name).text === 'reserveCredits' && resolveSpec(rel, decl.moduleSpecifier.text) === 'lib/enrich/credit-pool') reserve.add(s.name.text)
    // #1036: Find work email's mailbox check reserves through the verifier module's own reserveVerifySlot (checked below to be one)
    if ((s.propertyName ?? s.name).text === 'reserveVerifySlot' && resolveSpec(rel, decl.moduleSpecifier.text) === 'lib/people/email-pattern') reserve.add(s.name.text)
  }
  // #899: the mailbox verifier's reservation is the operator free-tier ledger, not the workspace credit pool (dazl's own free account,
  // no tenant credits). It counts as a reservation only as the module's own reserveVerifySlot, and only while that function still
  // writes the email_verify_usage ledger and throws on refusal (like reserveCredits).
  if (rel === VERIFIER_MODULE) for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === 'reserveVerifySlot' && st.body && /email_verify_usage/.test(st.body.getText(sf)) && /throw new VerifySlotRefused/.test(st.body.getText(sf))) reserve.add('reserveVerifySlot')
  }
  if (rel === 'lib/scan/commenter-import.ts') for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === 'holdCredits' && st.body && all(st.body, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && reserve.has(n.expression.text)).length > 0) hold.add('holdCredits')
  }
  return { reserve, hold }
}

// A reservation guards a later call only when ALL hold:
//  - it is a Reservers call in the SAME function (not a nested, possibly-uncalled one), and AWAITED;
//  - its provider argument (3rd), when a literal ('apollo' / 'pdl'), names the paid call's vendor (work-email passes a
//    variable from its provider loop, which is accepted);
//  - it runs unconditionally up to its statement: between the call and the statement there is only `await`, parens,
//    `const x =` / `x =`, and `cond ? null : ...` (which makes the result nullable). Any other ancestor (if/else with or
//    without braces, `?:`, `&&` / `||` / `??`, a loop, a switch case, a call argument) is rejected;
//  - that statement sits directly in a block that also holds the call, after it. A reservation inside try { } counts
//    as its whole try statement, only when the catch exits (return / continue / break / throw) and the try statement
//    itself sits directly in a block holding the call, so a refused reservation cannot fall through to the call;
//  - a nullable result (holdCredits, or the `cond ? null :` shape) is bound to a const that the call is dominated by a
//    truthiness check of: inside `if (hold ...) { }` (hold alone or in an && chain), or after `if (!hold) return /
//    continue / break / throw` in a block holding the call.
//  - its units argument (4th), when a numeric literal, is at least 1;
//  - every loop (for / for…of / for…in / while / do) whose repeated part holds the call also holds the reservation in
//    its repeated part, so one reservation is never spent on each iteration.
// Returns each guarding reservation and the variable it is bound to (null: not bound).
const EXITS = (s: ts.Statement | undefined) => !!s && (ts.isReturnStatement(s) || ts.isContinueStatement(s) || ts.isBreakStatement(s) || ts.isThrowStatement(s))
const exitsAlways = (s: ts.Statement) => EXITS(s) || (ts.isBlock(s) && EXITS(s.statements[s.statements.length - 1]))
const within = (n: ts.Node, outer: ts.Node) => n.getStart() >= outer.getStart() && n.getEnd() <= outer.getEnd()
// The loops, up to `stop`, whose repeated part holds n (a for…of / for…in iterable or a for initializer runs once).
function loopsAround(n: ts.Node, stop: ts.Node): ts.Node[] {
  const out: ts.Node[] = []
  for (let child = n, p = n.parent; p && p !== stop; child = p, p = p.parent) {
    if (ts.isForOfStatement(p) || ts.isForInStatement(p) ? child !== p.expression && child !== p.initializer : ts.isForStatement(p) ? child !== p.initializer : ts.isWhileStatement(p) || ts.isDoStatement(p)) out.push(p)
  }
  return out
}
// a and b are in opposite arms of one if/else or ?: (at most one of them runs).
function exclusive(a: ts.Node, b: ts.Node): boolean {
  for (let child = a, p = a.parent; p && !ts.isFunctionLike(child); child = p, p = p.parent) {
    const other = ts.isIfStatement(p) ? (child === p.thenStatement ? p.elseStatement : child === p.elseStatement ? p.thenStatement : undefined)
      : ts.isConditionalExpression(p) ? (child === p.whenTrue ? p.whenFalse : child === p.whenFalse ? p.whenTrue : undefined) : undefined
    if (other && within(b, other)) return true
  }
  return false
}
const lessThanOne = (e: ts.Expression | undefined): boolean => {
  if (!e) return false
  e = bare(e)
  if (ts.isNumericLiteral(e)) return Number(e.text) < 1
  return ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(bare(e.operand))
}
type Guard = { bound: string | null; node: ts.CallExpression }
function requiresTruthy(e: ts.Expression, v: string): boolean {
  e = bare(e)
  if (ts.isIdentifier(e)) return e.text === v
  return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && (requiresTruthy(e.left, v) || requiresTruthy(e.right, v))
}
function refusesFalsy(e: ts.Expression, v: string): boolean {
  e = bare(e)
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) { const o = bare(e.operand); return ts.isIdentifier(o) && o.text === v }
  return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken && (refusesFalsy(e.left, v) || refusesFalsy(e.right, v))
}
function checkedTruthy(v: string, target: ts.Node, top: ts.Block, after: number): boolean {
  for (let child: ts.Node = target, a: ts.Node = target.parent; ; child = a, a = a.parent) {
    if (ts.isIfStatement(a) && a.thenStatement === child && requiresTruthy(a.expression, v)) return true
    if (ts.isBlock(a) && a.statements.some(s => s.getStart() >= after && s.getEnd() <= child.getStart() && ts.isIfStatement(s) && !s.elseStatement && refusesFalsy(s.expression, v) && exitsAlways(s.thenStatement))) return true
    if (a === top || ts.isFunctionLike(a)) return false
  }
}
function guards(fn: ts.FunctionLikeDeclaration, target: ts.Node, vendor: 'apollo' | 'pdl' | null, rs: Reservers): Guard[] {
  const isReserve = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (rs.reserve.has(n.expression.text) || rs.hold.has(n.expression.text))
  const out: Guard[] = []
  const targetLoops = loopsAround(target, fn)
  for (const r of all(fn, isReserve) as ts.CallExpression[]) {
    if (enclosingFn(r) !== fn || r.getStart() >= target.getStart()) continue
    const lit = r.arguments[2]
    if (vendor && lit && ts.isStringLiteralLike(lit) && lit.text !== vendor) continue
    if (lessThanOne(r.arguments[3])) continue
    const rLoops = loopsAround(r, fn)
    if (!targetLoops.every(l => rLoops.includes(l))) continue
    let nullable = rs.hold.has((r.expression as ts.Identifier).text)
    let n: ts.Node = r, awaited = false, bound: string | null = null, isConst = false, ok = true
    for (;;) {
      const p = n.parent
      if (ts.isParenthesizedExpression(p)) { n = p; continue }
      if (ts.isAwaitExpression(p) && !awaited) { awaited = true; n = p; continue }
      if (ts.isConditionalExpression(p) && p.condition !== n && bare(p.whenTrue === n ? p.whenFalse : p.whenTrue).kind === ts.SyntaxKind.NullKeyword) { nullable = true; n = p; continue }
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n && ts.isIdentifier(p.left)) { bound = p.left.text; n = p; continue }
      if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name) && ts.isVariableStatement(p.parent.parent)) {
        bound = p.name.text; isConst = (p.parent.flags & ts.NodeFlags.Const) !== 0; n = p.parent.parent; break
      }
      if (ts.isExpressionStatement(p)) { n = p; break }
      ok = false; break
    }
    if (!ok || !awaited) continue
    const after = (s: ts.Node, b: ts.Node) => target.getStart() >= s.getEnd() && target.getEnd() <= b.getEnd()
    let stmt: ts.Node = n, block: ts.Node = n.parent
    if (!ts.isBlock(block)) continue
    if (!after(stmt, block)) {
      const t = block.parent
      if (!ts.isTryStatement(t) || t.tryBlock !== block) continue
      const c = t.catchClause?.block.statements
      if (c && !EXITS(c[c.length - 1])) continue
      stmt = t; block = t.parent
      if (!ts.isBlock(block) || !after(stmt, block)) continue
    }
    if (nullable && !(bound && isConst && checkedTruthy(bound, target, block as ts.Block, stmt.getEnd()))) continue
    out.push({ bound, node: r })
  }
  return out
}
const nearest = (gs: Guard[]) => gs.reduce((a, b) => b.node.getStart() > a.node.getStart() ? b : a).node
function unreservedPaidCalls(rel: string, text: string): string[] {
  const sf = parse(rel, text)
  const alias = importAliases(sf)
  const rs = reservers(sf, rel)
  const paidName = (c: ts.CallExpression): string | null => { const n = calleeName(c); const o = n ? alias.get(n) ?? n : null; return o && PAID.has(o) ? o : null }
  const out: string[] = []
  // What each reservation (or each CreditHold parameter) is spent on: one paid call, or one call that hands the hold on.
  const spentOn = new Map<ts.Node, Set<ts.CallExpression>>()
  const spend = (hold: ts.Node, site: ts.CallExpression) => { if (!spentOn.has(hold)) spentOn.set(hold, new Set()); spentOn.get(hold)!.add(site) }
  for (const call of all(sf, n => ts.isCallExpression(n) && paidName(n) !== null) as ts.CallExpression[]) {
    const name0 = paidName(call)!
    const vendor = VENDOR[name0]
    const fn = enclosingFn(call)
    if (!fn) { out.push(`${rel}:${lineOf(sf, call)} ${name0}`); continue }
    const own = guards(fn, call, vendor, rs)
    if (own.length > 0) { spend(nearest(own), call); continue }
    // The CreditHold-parameter shape (index.ts runPdl): every call of this function must pass, at the CreditHold
    // position, exactly the variable a guarding reservation was stored in; the paid call is in no loop of its own
    // function, and the hold received pays for one paid call only.
    const idx = fn.parameters.findIndex(p => p.type && /\bCreditHold\b/.test(p.type.getText(sf)))
    const name = fnName(fn)
    const uses = idx >= 0 && name ? all(sf, n => ts.isCallExpression(n) && calleeName(n) === name) as ts.CallExpression[] : []
    const holds = uses.map(u => {
      const f = enclosingFn(u); const arg = u.arguments[idx]
      const gs = f && arg && ts.isIdentifier(arg) ? guards(f, u, vendor, rs).filter(g => g.bound === arg.text) : []
      return gs.length > 0 ? nearest(gs) : null
    })
    if (uses.length === 0 || holds.includes(null) || loopsAround(call, fn).length > 0) { out.push(`${rel}:${lineOf(sf, call)} ${name0}`); continue }
    spend(fn, call)
    uses.forEach((u, i) => spend(holds[i]!, u))
  }
  // A reservation spent on two paid calls that can both run (not opposite arms of one if/else or ?:) under-reserves:
  // the later one needs its own reservation.
  for (const sites of spentOn.values()) {
    const ordered = [...sites].sort((a, b) => a.getStart() - b.getStart())
    for (const [j, b] of ordered.entries()) {
      if (ordered.slice(0, j).some(a => !exclusive(a, b))) out.push(`${rel}:${lineOf(sf, b)} ${paidName(b) ?? calleeName(b)} (a second paid call under one reservation)`)
    }
  }
  // Any other reference to a paid function (an alias, `.call`/`.apply`, a callback argument, a destructured dynamic
  // import, a bracket access that is not called) hands it somewhere the check above cannot follow: rejected. Allowed:
  // the direct callee of a call (checked above), an import specifier, and type positions (`typeof x`, type references).
  const isDirectCallee = (n: ts.Node): boolean => {
    let e = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : ts.isElementAccessExpression(n.parent) && n.parent.argumentExpression === n ? n.parent : n
    while (ts.isParenthesizedExpression(e.parent)) e = e.parent
    return ts.isCallExpression(e.parent) && e.parent.expression === e
  }
  const inType = (n: ts.Node): boolean => {
    let p = n.parent
    while (ts.isQualifiedName(p)) p = p.parent
    return ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p)
  }
  const refs = all(sf, n => (ts.isIdentifier(n) && PAID.has(alias.get(n.text) ?? n.text)) ||
    (ts.isStringLiteralLike(n) && PAID.has(n.text)))
  for (const n of refs) {
    if (ts.isImportSpecifier(n.parent) || inType(n) || isDirectCallee(n)) continue
    out.push(`${rel}:${lineOf(sf, n)} ${alias.get((n as ts.Identifier | ts.StringLiteralLike).text) ?? (n as ts.Identifier | ts.StringLiteralLike).text} (not a direct call)`)
  }
  return out
}

// Mailbox verification (lib/people/email-pattern.ts, #849's "verify" half). Wired = verifierFromEnv can return
// something other than null. While it only returns null no provider call can happen; once wired, every `.verify(...)`
// call in that module must be guarded by a credit reservation (same rules as above, any provider), and no other module
// may take or build a verifier (they are the module's own exports).
const VERIFIER_MODULE = 'lib/people/email-pattern.ts'
function unreservedVerifier(rel: string, text: string): string[] {
  const sf = parse(rel, text)
  const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'verifierFromEnv')
  if (!fn?.body) return [`${rel}: verifierFromEnv not found (a moved or reshaped verifier must be inventoried again)`]
  const returns = all(fn.body, n => ts.isReturnStatement(n) && enclosingFn(n) === fn) as ts.ReturnStatement[]
  if (returns.length > 0 && returns.every(r => r.expression && bare(r.expression).kind === ts.SyntaxKind.NullKeyword)) return []
  const rs = reservers(sf, rel)
  const calls = all(sf, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'verify') as ts.CallExpression[]
  if (calls.length === 0) return [`${rel}: verifierFromEnv returns a verifier but no .verify call was found to check`]
  return calls.filter(c => { const f = enclosingFn(c); return !f || guards(f, c, null, rs).length === 0 }).map(c => `${rel}:${lineOf(sf, c)} verify`)
}
const VERIFIER_NAMES = /\b(MailboxVerifier|verifierFromEnv|verifyCandidates)\b/
// Inventoried users (#899): the adapter (implements MailboxVerifier, makes no reservation-free call of its own: verifierFromEnv
// is the only constructor), and the scan runner (calls verifyJobCandidates, which reserves inside the verifier module).
// lib/people/smtp-verify.ts (#1036): dazl's own mailbox check, another MailboxVerifier adapter; its callers are the same two (verifyCandidates and
// Find work email's checkMailbox), both of which reserve a slot (reserveVerifySlot) before calling .verify.
const VERIFIER_USERS = ['lib/people/zerobounce.ts', 'lib/people/smtp-verify.ts', 'lib/people/smtp-staging-fake.ts', 'lib/scan/runner.ts', 'lib/people/work-email.ts']
// Modules besides the verifier module that call .verify themselves: every such call must be reserved (the same guard rules).
const VERIFY_CALLERS = ['lib/people/work-email.ts']
function unreservedVerifyCalls(rel: string, text: string): string[] {
  const sf = parse(rel, text), rs = reservers(sf, rel)
  const calls = all(sf, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'verify') as ts.CallExpression[]
  return calls.filter(c => { const f = enclosingFn(c); return !f || guards(f, c, null, rs).length === 0 }).map(c => `${rel}:${lineOf(sf, c)} verify`)
}
const verifierUsers = (srcs: Src[]) => srcs.filter(s => s.rel !== VERIFIER_MODULE && !VERIFIER_USERS.includes(s.rel) && VERIFIER_NAMES.test(s.text)).map(s => s.rel)

test('#849 inventory: only the known enrichment entry points call the Apollo / People Data Labs functions', () => {
  assert.deepEqual(unexpectedCallers(SOURCES), [], 'a new caller of a paid enrichment function must reserve workspace credits first and be listed here')
})

test('#849 inventory: the scan covers lib/, app/, scripts/ and the root modules, in every source extension', () => {
  const rels = new Set(SOURCES.map(s => s.rel))
  for (const rel of [...CALLERS, 'scripts/workers.mts', 'scripts/gate-check.mjs', 'instrumentation.ts', 'proxy.ts']) assert.ok(rels.has(rel), `${rel} is scanned`)
  assert.deepEqual(SOURCES.filter(s => s.rel.includes('\\') || /\.test\./.test(s.rel)).map(s => s.rel), [], 'posix paths, no test files')
  for (const name of ['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.js', 'a.mjs']) assert.ok(CODE.test(name), name)
})

test('#849 inventory: a new caller is caught, however it reaches the function (the check is not vacuous)', () => {
  for (const text of ['await apolloOrgEnrich(k, { domain: d }, f)', 'const fn = pdlPeopleSearch\nawait fn(k, c, f, 5)', 'await run(apolloPersonMatch)',
    "import { apolloOrgEnrich as org } from '@/lib/enrich/apollo'\nawait org(k, o, f)"]) {
    for (const rel of ['app/api/leads/x/route.ts', 'scripts/workers.mts', 'scripts/x.mjs', 'proxy.ts']) assert.deepEqual(unexpectedCallers([{ rel, text }]), [rel], `${rel}: ${text}`)
  }
})

test('#849 inventory: no paid vendor API origin is hard-coded outside the Apollo / PDL modules', () => {
  assert.deepEqual(hardCodedOrigins(SOURCES), [], 'a paid vendor API called outside lib/enrich/apollo.ts / pdl.ts must go through a reserved provider function')
  assert.ok(VENDOR_MODULES.every(rel => SOURCES.some(s => s.rel === rel && /\/\/api\.(apollo\.io|peopledatalabs\.com|zerobounce\.net)/.test(s.text))), 'the vendor modules still hold their origins (else the list is stale)')
})

test('#849 inventory: a hard-coded vendor or mailbox-verifier origin is caught (the check is not vacuous)', () => {
  const caught = (rel: string, text: string) => hardCodedOrigins([{ rel, text }]).length > 0
  for (const [rel, text] of [['lib/people/verify.ts', "await fetch('https://api.zerobounce.net/v2/validate?email=' + a)"], ['scripts/workers.mts', "const B = 'https://api.apollo.io'"],
    ['lib/x.ts', 'fetch(`https://eu.api.peopledatalabs.com/v5/person/enrich`)'], ['lib/legal/policy.ts', "fetch('https://api.apollo.io/v1')"], ['lib/x.ts', "const host = 'api.hunter.io'"],
    ['app/x.tsx', "new URL('/v4/single/check', '//api.neverbounce.com')"]]) assert.ok(caught(rel, text), `${rel}: ${text}`)
  for (const [rel, text] of [['lib/enrich/apollo.ts', "const BASE = 'https://api.apollo.io'"], ['lib/legal/policy.ts', "'api.apollo.io': { name: 'Apollo' }"], ['lib/x.ts', "'https://docs.apollo.io/x'"]]) assert.ok(!caught(rel, text), `${rel}: ${text}`)
})

test('#849 inventory: mailbox verification cannot run a provider call without a credit reservation', () => {
  const src = SOURCES.find(s => s.rel === VERIFIER_MODULE)?.text
  assert.ok(src, `${VERIFIER_MODULE} exists`)
  assert.deepEqual(unreservedVerifier(VERIFIER_MODULE, src!), [], 'a wired verifierFromEnv needs a reserveCredits before each .verify call')
  assert.deepEqual(verifierUsers(SOURCES), [], 'a new verifier caller must be inventoried here')
})

test('#1036 inventory: Find work email\'s mailbox check is reserved before its .verify call', () => {
  for (const rel of VERIFY_CALLERS) {
    const src = SOURCES.find(s => s.rel === rel)?.text
    assert.ok(src && /\.verify\(/.test(src), `${rel} still calls .verify (else the list is stale)`)
    assert.deepEqual(unreservedVerifyCalls(rel, src!), [], `${rel}: a .verify call needs an awaited reserveVerifySlot before it`)
  }
  const imp = "import { reserveVerifySlot } from './email-pattern.ts'\n"
  const fn = (body: string) => `async function checkMailbox(db: D, v: V, a: string) { ${body} }`
  assert.equal(unreservedVerifyCalls('lib/people/work-email.ts', imp + fn('await v.verify(a)')).length, 1, 'unreserved is caught')
  assert.equal(unreservedVerifyCalls('lib/people/work-email.ts', fn('await reserveVerifySlot(db, s, m); await v.verify(a)')).length, 1, 'not the verifier module import')
  assert.deepEqual(unreservedVerifyCalls('lib/people/work-email.ts', imp + fn('try { await reserveVerifySlot(db, s, m) } catch (e) { return }\n  await v.verify(a)')), [], 'reserved (try / exiting catch)')
})

test('#849 inventory: a wired verifier with no reservation is caught (the check is not vacuous)', () => {
  const imp = "import { reserveCredits } from '../enrich/credit-pool.ts'\n"
  const wired = "export function verifierFromEnv(env: E): MailboxVerifier | null { return env.ZB_KEY ? zeroBounce(env.ZB_KEY) : null }\n"
  const run = (body: string) => `async function verifyCandidates(db: D, t: string, verifier: MailboxVerifier) { for (const a of rows) { ${body} } }`
  assert.deepEqual(unreservedVerifier(VERIFIER_MODULE, 'export function verifierFromEnv(env: E): MailboxVerifier | null { void env; return null }\n' + run('await verifier.verify(a)')), [], 'not wired: no call can happen')
  assert.equal(unreservedVerifier(VERIFIER_MODULE, imp + wired + run('await verifier.verify(a)')).length, 1, 'wired, unreserved')
  assert.equal(unreservedVerifier(VERIFIER_MODULE, imp + wired + run('if (x) await reserveCredits(db, t, "zb", 1); await verifier.verify(a)')).length, 1, 'wired, conditional reservation')
  assert.equal(unreservedVerifier(VERIFIER_MODULE, wired + run('await reserveCredits(db, t, "zb", 1); await verifier.verify(a)')).length, 1, 'wired, reserveCredits not the credit-pool import')
  assert.deepEqual(unreservedVerifier(VERIFIER_MODULE, imp + wired + run('const h = await reserveCredits(db, t, "zb", 1); await verifier.verify(a)')), [], 'wired, reserved')
  assert.equal(unreservedVerifier(VERIFIER_MODULE, imp + 'export const verifierFromEnv = () => null\n').length, 1, 'reshaped: inventory again')
  // #899: the free-tier ledger reservation counts only as the module's own reserveVerifySlot that writes the ledger and throws.
  const slot = "export async function reserveVerifySlot(db: D) { db.prepare('INSERT INTO email_verify_usage (v) VALUES (1)'); throw new VerifySlotRefused('cap') }\n"
  assert.deepEqual(unreservedVerifier(VERIFIER_MODULE, slot + wired + run('await reserveVerifySlot(db, s, m); await verifier.verify(a)')), [], 'wired, reserved by the ledger slot')
  assert.equal(unreservedVerifier(VERIFIER_MODULE, wired + run('await reserveVerifySlot(db, s, m); await verifier.verify(a)')).length, 1, 'a reserveVerifySlot not declared in the module is no reservation')
  assert.equal(unreservedVerifier(VERIFIER_MODULE, "export async function reserveVerifySlot(db: D) { return }\n" + wired + run('await reserveVerifySlot(db, s, m); await verifier.verify(a)')).length, 1, 'a reserveVerifySlot that writes no ledger is no reservation')
  assert.equal(unreservedVerifier(VERIFIER_MODULE, slot + wired + run('await verifier.verify(a)')).length, 1, 'declared but not called before the check')
  assert.deepEqual(verifierUsers([{ rel: 'app/api/leads/x/route.ts', text: "import { verifyCandidates } from '@/lib/people/email-pattern'" }]), ['app/api/leads/x/route.ts'])
})

test('#849 inventory: every credit-charging enrichment call reserves workspace credits before its request', () => {
  for (const rel of CALLERS) {
    const src = SOURCES.find(s => s.rel === rel)?.text
    assert.ok(src, `${rel} exists`)
    assert.ok(providerUses(rel, src!).length > 0, `${rel} still calls a provider (else drop it from CALLERS)`)
    assert.deepEqual(unreservedPaidCalls(rel, src!), [], `${rel}: reserve credits (reserveCredits) before each paid Apollo/PDL call`)
  }
})

// The snippets below import reserveCredits from the credit pool, as the real callers do.
const IMP = "import { reserveCredits } from '@/lib/enrich/credit-pool'\n"
const R = 'reserveCredits(db, t, "apollo", 1)', C = 'await apolloOrgEnrich(k, o, f)'
const caughtIn = (rel: string, text: string) => unreservedPaidCalls(rel, IMP + text).length

test('#849 inventory: a paid call with no reservation before it is caught, also after one that has one', () => {
  const reserved = `async function a() { const hold = await ${R}; ${C} }\n`
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', IMP + reserved), [])
  assert.equal(caughtIn('lib/x.ts', `async function b() { ${C}; await ${R} }`), 1, 'reserving AFTER the call does not count')
  assert.equal(caughtIn('lib/x.ts', reserved + 'async function c() { await pdlPersonEnrich(k, q, f) }'), 1, 'a second, unreserved function in the same file')
  // the CreditHold-parameter shape (index.ts runPdl): fine only when every caller reserved first
  const viaParam = 'async function run(k: string, hold: CreditHold) { return pdlPeopleSearch(k, c, f, 5) }\n'
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', IMP + viaParam + 'async function go() { const hold = await reserveCredits(db, t, "pdl", 5); await run(k, hold) }'), [])
  assert.equal(caughtIn('lib/x.ts', viaParam + 'async function go() { await run(k, fakeHold) }'), 1, 'a caller that never reserved')
  assert.equal(caughtIn('lib/x.ts', viaParam + 'async function go(x: boolean) { let hold; if (x) hold = await reserveCredits(db, t, "pdl", 5); await run(k, hold) }'), 1, 'a caller that reserved conditionally')
  // a renamed import is still a paid call; a reservation for the other vendor does not cover it
  assert.equal(caughtIn('lib/x.ts', "import { apolloOrgEnrich as org } from './apollo.ts'\nasync function e() { await org(k, o, f) }"), 1, 'renamed import, unreserved')
  assert.equal(caughtIn('lib/x.ts', `async function g() { const h = await reserveCredits(db, t, "pdl", 5); ${C} }`), 1, 'PDL credits do not cover an Apollo call')
  // xhawk round 1: an un-awaited reservation, one in a nested function, one in a branch not taken, a try whose catch
  // falls through, and a CreditHold caller passing a hold other than the one it reserved
  assert.equal(caughtIn('lib/x.ts', `async function h() { const p = ${R}; ${C} }`), 1, 'not awaited')
  assert.equal(caughtIn('lib/x.ts', `async function i() { const later = async () => { await ${R} }; ${C} }`), 1, 'nested function')
  assert.equal(caughtIn('lib/x.ts', `async function j(x: boolean) { if (x) { const h = await ${R} } ${C} }`), 1, 'branch not taken')
  assert.equal(caughtIn('lib/x.ts', `async function m() { let h; try { h = await ${R} } catch { log() } ${C} }`), 1, 'catch falls through')
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', IMP + `async function n() { let h; try { h = await ${R} } catch { return null } ${C} }`), [], 'catch exits: guarded')
  assert.equal(caughtIn('lib/x.ts', `async function n2(x: boolean) { let h; if (x) try { h = await ${R} } catch { return null } ${C} }`), 1, 'guarded try inside an unbraced branch')
  assert.equal(caughtIn('lib/x.ts', viaParam + 'async function go2() { const unrelated = await reserveCredits(db, t, "pdl", 5); await run(k, fakeHold) }'), 1, 'passes a hold it did not reserve')
  // council round 1: a paid function used other than as a direct callee cannot be followed, so it is reported
  const indirect: Record<string, string> = {
    alias: 'async function q() { const fn = pdlPeopleSearch; return fn(k, c, f, 5) }',
    dotCall: 'async function q() { await apolloOrgEnrich.call(null, k, o, f) }',
    callback: 'async function q() { await runWith(apolloPersonMatch, k) }',
    callbackSecond: 'async function q() { await retry(() => 0, apolloOrgEnrich) }',
    dynamicImport: "async function q() { const { apolloOrgEnrich: org } = await import('./apollo.ts'); await org(k, o, f) }",
    bracket: "async function q() { await A['apolloOrgEnrich'](k, o, f) }",
  }
  assert.deepEqual(Object.entries(indirect).filter(([, text]) => caughtIn('lib/enrich/index.ts', text) === 0).map(([k]) => k), [], 'indirect uses in a CALLERS file')
  assert.deepEqual(unexpectedCallers([{ rel: 'lib/x.ts', text: "await A['apolloOrgEnrich'](k, o, f)" }]), ['lib/x.ts'], 'bracket access outside CALLERS')
  assert.deepEqual(unexpectedCallers([{ rel: 'lib/x.ts', text: "await A['apolloPeopleSearch'](k, o, f, 5)" }]), ['lib/x.ts'], 'bracket access to the free function outside CALLERS')
  // council round 2: a provider name as any string literal (a computed destructuring key) is a use; a parenthesized
  // callee is still a direct call, checked like any other
  const computedKey = "async function q() { const { ['apolloOrgEnrich']: f } = A; await f(k, o, f) }"
  assert.equal(caughtIn('lib/enrich/index.ts', computedKey), 1, 'computed destructuring key in a CALLERS file')
  assert.deepEqual(unexpectedCallers([{ rel: 'lib/x.ts', text: computedKey }]), ['lib/x.ts'], 'computed destructuring key outside CALLERS')
  assert.deepEqual(unexpectedCallers([{ rel: 'lib/x.ts', text: "const { ['apolloPeopleSearch']: s } = A" }]), ['lib/x.ts'], 'computed key for the free function outside CALLERS')
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', IMP + `async function q() { const h = await ${R}; await (apolloOrgEnrich)(k, o, f) }`), [], 'parenthesized callee after a reservation')
  assert.equal(caughtIn('lib/x.ts', 'async function q() { await (apolloOrgEnrich)(k, o, f) }'), 1, 'parenthesized callee without a reservation')
  // type positions and a reserved direct call are not indirect uses
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', IMP + `let o: Awaited<ReturnType<typeof apolloOrgEnrich>> = null\nasync function q() { const h = await ${R}; ${C} }`), [], 'typeof in a type')
  // the 0-credit people search needs no reservation
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', 'async function d() { await apolloPeopleSearch(k, o, f, 5) }'), [])
})

// Hermes review of #1079: every one of these was accepted by the earlier, block-only dominance check.
test('#849 inventory: a reservation that may not run (unbraced if, ?:, &&, loop, switch case) or is not the credit pool does not guard', () => {
  const probes: Record<string, [string, string]> = {
    unbracedIf: ['lib/x.ts', `async function p(x: boolean) { if (x) await ${R}; ${C} }`],
    unbracedIfAssign: ['lib/x.ts', `async function p(x: boolean) { let h; if (x) h = await ${R}; ${C} }`],
    unbracedElse: ['lib/x.ts', `async function p(x: boolean) { let h; if (x) log(); else h = await ${R}; ${C} }`],
    ternary: ['lib/x.ts', `async function p(x: boolean) { const h = x ? await ${R} : null; ${C} }`],
    andAnd: ['lib/x.ts', `async function p(x: boolean) { x && await ${R}; ${C} }`],
    orOr: ['lib/x.ts', `async function p(x: boolean) { x || await ${R}; ${C} }`],
    nullish: ['lib/x.ts', `async function p(x?: number) { const h = x ?? await ${R}; ${C} }`],
    forZero: ['lib/x.ts', `async function p(xs: number[]) { for (const _ of xs) await ${R}; ${C} }`],
    whileZero: ['lib/x.ts', `async function p(x: boolean) { while (x) { await ${R}; break } ${C} }`],
    switchCase: ['lib/x.ts', `async function p(x: number) { switch (x) { case 1: await ${R} } ${C} }`],
    nullHoldIgnored: ['lib/scan/commenter-import.ts', `async function holdCredits(db: D, t: string, p: 'apollo' | 'pdl', u: number, j: string) { try { return await reserveCredits(db, t, p, u) } catch { return null } }
async function p() { const h = await holdCredits(db, t, "apollo", 1, j); ${C} }`],
    fakeLocalReserve: ['lib/x.ts', `async function p() { const h = await ${R}; ${C} }\nasync function reserveCredits(...a: unknown[]) { return a }`],
  }
  // fakeLocalReserve gets no credit-pool import: a same-named local function is not the pool.
  const missed = Object.entries(probes).filter(([k, [rel, text]]) => unreservedPaidCalls(rel, (k === 'fakeLocalReserve' ? '' : IMP) + text).length !== 1).map(([k]) => k)
  assert.deepEqual(missed, [])
  assert.equal(unreservedPaidCalls('lib/x.ts', `import { reserveCredits } from './not-the-pool.ts'\nasync function p() { const h = await ${R}; ${C} }`).length, 1, 'reserveCredits imported from another module')
  assert.deepEqual(unreservedPaidCalls('lib/x.ts', `import { reserveCredits as rc } from '@/lib/enrich/credit-pool'\nasync function p() { const h = await rc(db, t, "apollo", 1); ${C} }`), [], 'renamed credit-pool import')
})

test('#849 inventory: a nullable hold guards only behind a truthiness check of its own const', () => {
  const HOLD = `async function holdCredits(db: D, t: string, p: 'apollo' | 'pdl', u: number, j: string) { try { return await reserveCredits(db, t, p, u) } catch { return null } }\n`
  const at = (body: string) => caughtIn('lib/scan/commenter-import.ts', HOLD + `async function p(x: boolean, xs: string[]) { ${body} }`)
  const H = 'await holdCredits(db, t, "apollo", 1, j)'
  // accepted: the shapes commenter-import uses
  assert.equal(at(`const hold = x ? null : ${H}; if (hold && g) try { ${C} } catch { return }`), 0, 'inside if (hold && ...)')
  assert.equal(at(`const hold = ${H}; if (!hold) return; ${C}`), 0, 'after if (!hold) return')
  assert.equal(at(`for (const a of xs) { const hold = ${H}; if (!hold) continue; ${C} }`), 0, 'after if (!hold) continue')
  assert.equal(at(`const hold = ${H}; if (!hold) { log(); throw new Error('x') } ${C}`), 0, 'after if (!hold) { ...; throw }')
  // rejected
  assert.equal(at(`const hold = ${H}; if (!hold) log(); ${C}`), 1, 'the check does not exit')
  assert.equal(at(`const hold = ${H}; if (hold || x) { ${C} }`), 1, 'hold || x does not require hold')
  assert.equal(at(`const hold = ${H}; if (other) { ${C} }`), 1, 'checks another variable')
  assert.equal(at(`const hold = ${H}; if (hold) log(); else { ${C} }`), 1, 'in the else branch')
  assert.equal(at(`let hold = ${H}; if (!hold) return; hold = null; ${C}`), 1, 'not a const')
  assert.equal(at(`${C}; const hold = ${H}; if (!hold) return`), 1, 'check after the call')
  assert.equal(caughtIn('lib/x.ts', HOLD + `async function p() { const hold = await holdCredits(db, t, "apollo", 1, j); if (!hold) return; ${C} }`), 1, 'holdCredits outside commenter-import is not a reservation')
})

// Hermes review of #1079, round 3: a reservation covers ONE paid call. Each of these was accepted before.
test('#849 inventory: one reservation guards exactly one paid call, never a loop of them, and reserves at least 1 unit', () => {
  const HOLD = `async function holdCredits(db: D, t: string, p: 'apollo' | 'pdl', u: number, j: string) { try { return await reserveCredits(db, t, p, u) } catch { return null } }\n`
  const viaParam = (body: string) => `async function run(k: string, hold: CreditHold) { ${body} }\n`
  const PDL = 'await pdlPeopleSearch(k, c, f, 5)', RP = 'reserveCredits(db, t, "pdl", 5)'
  const reported: Record<string, [string, string]> = {
    loopUnderOneHold: ['lib/x.ts', `async function p(xs: string[]) { const h = await ${R}; for (const x of xs) { ${C} } }`],
    twoCallsOneHold: ['lib/x.ts', `async function p() { const h = await ${R}; ${C}; ${C} }`],
    zeroUnits: ['lib/x.ts', `async function p() { await reserveCredits(db, t, "apollo", 0); ${C} }`],
    negativeUnits: ['lib/x.ts', `async function p() { const h = await reserveCredits(db, t, "apollo", -1); ${C} }`],
    forLoop: ['lib/x.ts', `async function p() { const h = await ${R}; for (let i = 0; i < 2; i++) ${C} }`],
    forInLoop: ['lib/x.ts', `async function p(o: object) { const h = await ${R}; for (const x in o) ${C} }`],
    whileLoop: ['lib/x.ts', `async function p(x: boolean) { const h = await ${R}; while (x) { ${C} } }`],
    doLoop: ['lib/x.ts', `async function p(x: boolean) { const h = await ${R}; do { ${C} } while (x) }`],
    callInTryAndCatch: ['lib/x.ts', `async function p() { const h = await ${R}; try { ${C} } catch { ${C} } }`],
    paramTwoCalls: ['lib/x.ts', viaParam(`${PDL}; return ${PDL}`) + `async function go() { const hold = await ${RP}; await run(k, hold) }`],
    paramLoop: ['lib/x.ts', viaParam(`for (const q of qs) ${PDL}`) + `async function go() { const hold = await ${RP}; await run(k, hold) }`],
    paramCalledTwice: ['lib/x.ts', viaParam(`return ${PDL}`) + `async function go() { const hold = await ${RP}; await run(k, hold); await run(k, hold) }`],
    paramCalledInLoop: ['lib/x.ts', viaParam(`return ${PDL}`) + `async function go(xs: string[]) { const hold = await ${RP}; for (const x of xs) await run(k, hold) }`],
    paramPlusDirect: ['lib/x.ts', viaParam(`return ${PDL}`) + `async function go() { const hold = await ${RP}; await run(k, hold); ${PDL} }`],
    // the two real-code shapes from the review, on their own files
    workEmailRetry: ['lib/people/work-email.ts', `async function find(xs: CreditProvider[], key: string) { for (const prov of xs) { let hold: CreditHold
      try { hold = await reserveCredits(db, tenantId, prov, 1, { env, now }) } catch { continue }
      try { if (prov === 'apollo') { const m = await apolloPersonMatch(key, want, fetchImpl); const retry = m ? null : await apolloPersonMatch(key, want, fetchImpl); await settle(db, hold, 1); use(m, retry) }
      else { const r = await pdlPersonEnrich(key, want, fetchImpl); await settle(db, hold, r.billed ? 1 : 0) } } catch { continue } } }`],
    commenterImportLoop: ['lib/scan/commenter-import.ts', HOLD + `async function imp(gs: G[]) { for (const g of gs) { if (pdlKey) {
      const hold = await holdCredits(db, tenantId, 'pdl', 5, batch.job_id); if (!hold) return
      try { const found: P[] = []; for (const q of [g.company, g.domain]) found.push(...await pdlPeopleSearch(pdlKey, q, fetchImpl, 5)); await quietly(() => settleCredits(db, hold, found.length)) } catch { return } } } }`],
  }
  assert.deepEqual(Object.entries(reported).filter(([, [rel, text]]) => unreservedPaidCalls(rel, IMP + text).length === 0).map(([k]) => k), [], 'accepted, must be reported')
  const accepted: Record<string, [string, string]> = {
    newHoldBetween: ['lib/x.ts', `async function p() { const h = await ${R}; ${C}; await settleCredits(db, h, 1); const h2 = await ${R}; ${C} }`],
    exclusiveBranches: ['lib/x.ts', `async function p(x: boolean) { const h = await ${R}; if (x) { ${C} } else { await apolloPersonMatch(k, w, f) } }`],
    exclusiveTernary: ['lib/x.ts', `async function p(x: boolean) { const h = await ${R}; const o = x ? ${C} : await apolloPersonMatch(k, w, f) }`],
    holdInsideLoop: ['lib/x.ts', `async function p(xs: string[]) { for (const x of xs) { const h = await ${R}; ${C} } }`],
    loopOverArgsOnce: ['lib/x.ts', `async function p() { const h = await ${R}; for (const x of [${C}]) use(x) }`],
    variableUnits: ['lib/x.ts', `async function p(n: number) { const h = await reserveCredits(db, t, "apollo", n); ${C} }`],
    paramOnce: ['lib/x.ts', viaParam(`return ${PDL}`) + `async function go(xs: string[]) { for (const x of xs) { const hold = await ${RP}; await run(k, hold) } }`],
  }
  assert.deepEqual(Object.entries(accepted).filter(([, [rel, text]]) => unreservedPaidCalls(rel, IMP + text).length !== 0).map(([k]) => k), [], 'one call per reservation: accepted')
})
