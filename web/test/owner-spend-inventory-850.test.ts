// Inventory of paid model calls outside the scan transports (#850, sibling of #848's scan inventory): every module in
// lib/ and app/ that calls a provider's complete / completeDetailed / research is classified, and each entry point
// outside a scan wraps the provider in the owner's spend guard before calling. A new, unclassified call site fails.
// Behavioral proof for the two entry points no other test refuses (SEO newsjack, sequence follow-ups): past the
// owner's limit no provider call is made. Synthetic tenant and key; stub fetch; nothing is billed or sent.
// Out of scope here: raw vendor HTTP outside a Provider (lib/evals/judge-validation-run.ts, the operator's claim-gated
// eval) is inventoried by #848's endpoint test (scan-spend-cap-paths, CLAIM_GATED).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createNewsjack } from '../lib/seo/newsjack.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'
import { saveSettings, createDraft } from '../lib/outreach/service.ts'
import { createSequence, draftSequenceSteps, sequenceStepText } from '../lib/outreach/sequences.ts'
import { saveMemory } from '../lib/memory.ts'
import * as ts from 'typescript'

const ROOT = join(import.meta.dirname, '..')

// Entry points outside a scan: must call the owner guard on the provider they call.
const OWNER_ENTRY = [
  'lib/outreach/draft-llm.ts', 'lib/outreach/sequences.ts', 'lib/replies/threads.ts',
  'lib/seo/brief.ts', 'lib/seo/newsjack.ts', 'lib/scan/icp-from-site.ts',
]
// Called only with a provider its one caller already guarded: [module, its exported function, that caller, the guarded call].
const GUARDED_BY_CALLER: [string, string, string, RegExp][] = [
  ['lib/scan/lead-qualify.ts', 'qualifyLead', 'lib/scan/qualify-run.ts', /qualifyLead\(ownerGuarded\(/],
  ['lib/scan/icp.ts', 'inferIcp', 'lib/scan/runner.ts', /inferIcp\(providers_\[vendor\]/],
]
// Scan work: the runner's providers are guarded per job and reserved on the scan cap (#848, scan-spend-cap-paths).
const SCAN = ['lib/scan/runner.ts', 'lib/scan/buyer-fit.ts', 'lib/scan/score.ts']
// Provider wrappers (decorate a provider, add no call of their own) and the guard itself.
const WRAPPERS = ['lib/evals/trace.ts', 'lib/outreach/launch-policy.ts', 'lib/scan/model-usage.ts']
// lib/llm itself: the providers (each delegates complete to its own completeDetailed) and the spend guard that wraps
// them. Any other lib/llm module that calls a model is unclassified and fails like anywhere else.
const LLM = ['lib/llm/provider.ts', 'lib/llm/spend-guard.ts']
// `.complete(token)` on a job queue, not a model.
const NOT_MODEL = ['lib/queue/scan-claimer.ts', 'lib/scan/queue-runner.ts']

// Every use of a provider method, found on the TypeScript syntax tree (not a text pattern): a call (`p.complete(`,
// `p.complete!(`, `p.complete?.(`, `p['complete'](`), an indirect call (`.call` / `.apply` / `.bind`), an alias
// (`const c = p.complete`) and destructuring (`const { complete } = p`). `research` is also a data field name
// (icp.research), so only its calls count. Each use carries the receiver expression it reads the method from.
const METHODS = new Set(['complete', 'completeDetailed', 'research'])
const ALIASABLE = new Set(['complete', 'completeDetailed'])
type Use = { line: number; method: string; receiver: ts.Expression | null; sf: ts.SourceFile }
const strip = (e: ts.Expression): ts.Expression => (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) ? strip(e.expression) : e
function methodOf(e: ts.Node): { method: string; receiver: ts.Expression } | null {
  if (ts.isPropertyAccessExpression(e) && METHODS.has(e.name.text)) return { method: e.name.text, receiver: e.expression }
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) && METHODS.has(e.argumentExpression.text)) return { method: e.argumentExpression.text, receiver: e.expression }
  return null
}
// An alias only counts when the file calls it (directly or via .call/.apply): `const done = packing.complete` is data.
function calledIn(sf: ts.SourceFile, name: string): boolean {
  return all(sf, n => ts.isCallExpression(n) && (() => { const c = strip(n.expression)
    return ts.isIdentifier(c) && c.text === name || ts.isPropertyAccessExpression(c) && ['call', 'apply'].includes(c.name.text) && ts.isIdentifier(strip(c.expression)) && (strip(c.expression) as ts.Identifier).text === name })()).length > 0
}
function modelUses(rel: string, text: string): Use[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Use[] = []
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const visit = (n: ts.Node): void => {
    const m = methodOf(n)
    if (m) {
      let up: ts.Node = n.parent
      while (ts.isNonNullExpression(up) || ts.isParenthesizedExpression(up)) up = up.parent
      const called = ts.isCallExpression(up) && strip(up.expression) === n
      const indirect = ts.isPropertyAccessExpression(up) && ['call', 'apply', 'bind'].includes(up.name.text)
      const aliasName = ts.isVariableDeclaration(up) && ts.isIdentifier(up.name) ? up.name.text
        : ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.right === n && ts.isIdentifier(up.left) ? up.left.text : null
      const aliased = ALIASABLE.has(m.method) && aliasName !== null && calledIn(sf, aliasName)
      if (called || indirect || aliased) out.push({ line: at(n), method: m.method, receiver: m.receiver, sf })
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
      for (const el of n.name.elements) {
        const key = (el.propertyName ?? el.name)
        if (ts.isIdentifier(key) && ALIASABLE.has(key.text) && ts.isIdentifier(el.name) && calledIn(sf, el.name.text)) out.push({ line: at(el), method: key.text, receiver: n.initializer, sf })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
// A receiver is guarded by the structure of its value, never by text: an ownerGuarded(...)/guardProvider(...) call is
// guarded; `a && b` when b is; `c ? x : y`, `a ?? b` and `a || b` only when every value they can produce is guarded or
// falsy (null/undefined/false/0/''); a variable of this file when every value it ever holds (its initializer and every
// later `x = ...` / `x ||= ...` etc.) is guarded or falsy, and at least one is guarded; `x.provider` where x comes from
// a function of this file whose EVERY return that sets `provider` sets it to a guarded value (draft-llm's
// pickProvider). Anything else is unguarded.
function all(root: ts.Node, pick: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = []
  const walk = (n: ts.Node): void => { if (pick(n)) out.push(n); ts.forEachChild(n, walk) }
  walk(root)
  return out
}
const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken])
function falsy(e: ts.Expression): boolean {
  const r = strip(e)
  return r.kind === ts.SyntaxKind.NullKeyword || r.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(r) && r.text === 'undefined')
    || (ts.isNumericLiteral(r) && Number(r.text) === 0) || (ts.isStringLiteralLike(r) && r.text === '') || ts.isVoidExpression(r)
}
// Every value the expression can evaluate to is guarded or falsy.
function safeExpr(e: ts.Expression, sf: ts.SourceFile, within: ts.Node, depth: number): boolean {
  return falsy(e) || guardedExpr(e, sf, within, depth)
}
function guardedExpr(e: ts.Expression, sf: ts.SourceFile, within: ts.Node = sf, depth = 0): boolean {
  if (depth > 5) return false
  const r = strip(e)
  if (ts.isCallExpression(r)) { const c = strip(r.expression); return ts.isIdentifier(c) && (c.text === 'ownerGuarded' || c.text === 'guardProvider') }
  if (ts.isConditionalExpression(r)) return safeExpr(r.whenTrue, sf, within, depth + 1) && safeExpr(r.whenFalse, sf, within, depth + 1)
    && (guardedExpr(r.whenTrue, sf, within, depth + 1) || guardedExpr(r.whenFalse, sf, within, depth + 1))
  if (ts.isBinaryExpression(r)) {
    const op = r.operatorToken.kind
    // `a && b` yields a falsy a or b
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return guardedExpr(r.right, sf, within, depth + 1)
    // `a ?? b` / `a || b` yield a (when set) or b: both must be guarded or falsy
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return safeExpr(r.left, sf, within, depth + 1) && safeExpr(r.right, sf, within, depth + 1)
      && (guardedExpr(r.left, sf, within, depth + 1) || guardedExpr(r.right, sf, within, depth + 1))
    return false
  }
  if (ts.isIdentifier(r)) {
    // every value the variable holds: its declarations' initializers and every later assignment to it
    const decls = all(within, n => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === r.text) as ts.VariableDeclaration[]
    const assigned = all(within, n => ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind) && ts.isIdentifier(strip(n.left)) && (strip(n.left) as ts.Identifier).text === r.text) as ts.BinaryExpression[]
    const values = [...decls.flatMap(d => d.initializer ? [d.initializer] : []), ...assigned.map(a => a.right)]
    // any other write (destructuring, ++, a for-of binding) is not judged: unguarded
    const otherWrites = all(within, n => (ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)) && ts.isBinaryExpression(n.parent) && n.parent.left === n
      && all(n, m => ts.isIdentifier(m) && m.text === r.text).length > 0).length > 0
      || all(within, n => (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && ts.isIdentifier(strip(n.operand)) && (strip(n.operand) as ts.Identifier).text === r.text).length > 0
    return decls.length > 0 && !otherWrites && values.every(v => safeExpr(v, sf, within, depth + 1)) && values.some(v => guardedExpr(v, sf, within, depth + 1))
  }
  if (ts.isPropertyAccessExpression(r) && ts.isIdentifier(r.expression)) {
    // the holder's declaration in the function that encloses this use (each function has its own `const p = ...`)
    let scope: ts.Node = r
    while (scope.parent && !ts.isFunctionLike(scope)) scope = scope.parent
    const holder = all(scope, n => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === (r.expression as ts.Identifier).text && !!n.initializer) as ts.VariableDeclaration[]
    if (holder.length !== 1) return false
    const init = strip(holder[0].initializer!)
    if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return false
    const fnName = init.expression.text
    const fn = all(sf, n => ts.isFunctionDeclaration(n) && n.name?.text === fnName)[0] as ts.FunctionDeclaration | undefined
    if (!fn?.body) return false
    // every object literal any return builds (also inside `cond ? { provider } : null`) that sets this property
    const sets = all(fn.body, n => ts.isReturnStatement(n) && !!n.expression)
      .flatMap(ret => all(ret, n => ts.isObjectLiteralExpression(n)) as ts.ObjectLiteralExpression[])
      .flatMap(o => o.properties)
      .filter(p => p.name && ts.isIdentifier(p.name) && p.name.text === r.name.text)
    return sets.length > 0 && sets.every(p =>
      ts.isShorthandPropertyAssignment(p) ? guardedExpr(p.name, sf, fn.body!, depth + 1)
        : ts.isPropertyAssignment(p) ? guardedExpr(p.initializer, sf, fn.body!, depth + 1) : false)
  }
  return false
}
function guardedReceiver(u: Use): boolean { return !!u.receiver && guardedExpr(u.receiver, u.sf) }
function unguardedUses(rel: string, text: string): string[] {
  return modelUses(rel, text).filter(u => !guardedReceiver(u)).map(u => `${rel}:${u.line} ${u.method}`)
}
function sources(dir: string): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...sources(p)); continue }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push({ rel: relative(ROOT, p).split(sep).join('/'), text: readFileSync(p, 'utf8') })
  }
  return out
}
const SOURCES = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app'))]
const KNOWN = new Set([...OWNER_ENTRY, ...GUARDED_BY_CALLER.map(g => g[0]), ...SCAN, ...WRAPPERS, ...LLM, ...NOT_MODEL])

function unclassified(srcs: { rel: string; text: string }[]): string[] {
  return srcs.filter(s => !KNOWN.has(s.rel) && modelUses(s.rel, s.text).length > 0).map(s => s.rel)
}

test('#850 inventory: every module calling a model provider in lib/ and app/ (lib/llm included) is classified', () => {
  assert.deepEqual(unclassified(SOURCES), [], 'a new paid model call site: an entry point must wrap its provider with ownerGuarded before calling')
})

const SHAPES = [
  'await provider.complete(key, prompt, f, 500)',
  'await provider.complete!(key, prompt, f, 500)',
  'await provider.completeDetailed?.(k, p)',
  "await provider['complete'](k, p)",
  'const complete = provider.complete\nawait complete(k, p)',
  'await provider.complete.call(provider, k, p)',
  'const c = provider.completeDetailed.bind(provider)',
  'const { complete } = provider\nawait complete(k, p)',
  'const { completeDetailed: cd } = provider\nawait cd(k, p)',
  'return p.research(k, q)',
]

test('#850 inventory: an unexpected new call site is caught in every call shape (the check is not vacuous)', () => {
  for (const text of SHAPES) assert.deepEqual(unclassified([{ rel: 'lib/outreach/new-ai-feature.ts', text }]), ['lib/outreach/new-ai-feature.ts'], text)
  // lib/llm is inventoried too: a new helper there is not exempt
  assert.deepEqual(unclassified([{ rel: 'lib/llm/new-helper.ts', text: SHAPES[0] }]), ['lib/llm/new-helper.ts'])
  // data fields named like the methods are not model calls
  assert.deepEqual(unclassified([{ rel: 'lib/x.ts', text: 'const r = icp.research; const done = packing.complete; if (job.complete) {}' }]), [])
})

test('#850 inventory: every model call in an owner entry point goes through the owner guard, call by call', () => {
  for (const rel of OWNER_ENTRY) {
    const src = SOURCES.find(s => s.rel === rel)?.text
    assert.ok(src, `${rel} exists`)
    assert.ok(modelUses(rel, src!).length > 0, `${rel} still makes a model call (else drop it from OWNER_ENTRY)`)
    assert.deepEqual(unguardedUses(rel, src!), [], `${rel}: each paid call's provider must come from ownerGuarded/guardProvider`)
  }
})

test('#850 inventory: a second, unguarded call in a file that already guards one is caught, in every call shape', () => {
  const guardedFirst = "const provider = raw && ownerGuarded(db, tenantId, raw)\nawait provider.complete(k, p)\n"
  assert.deepEqual(unguardedUses('lib/seo/x.ts', guardedFirst), [])
  for (const shape of SHAPES) assert.ok(unguardedUses('lib/seo/x.ts', guardedFirst + shape.replace(/\bprovider\b|\bp\b(?=\.research)/g, 'providers[vendor]')).length > 0, shape)
  assert.deepEqual(unguardedUses('lib/seo/x.ts', 'await ownerGuarded(db, t, providers[v]).complete!(k, p)'), [])
  // Hermes's mutations on #1078: a branch that falls back to the raw provider (M2, sequences.ts), and a guarded
  // variable later reassigned to the raw provider (M3, brief.ts). The guard text is present; the call is unguarded.
  const UNGUARDED_VALUES = [
    'const provider = providers[vendor] && (process.env.X ? providers[vendor] : ownerGuarded(db, tenantId, providers[vendor]))\nawait provider.complete(k, p)',
    'let prov = ownerGuarded(db, tenantId, providers[vendor]); prov = providers[vendor]\nawait prov.complete!(k, p)',
    'const provider = ownerGuarded(db, t, raw) ?? providers[vendor]\nawait provider.complete(k, p)',
    'const provider = raw || ownerGuarded(db, t, raw)\nawait provider.complete(k, p)',
    'let prov = ownerGuarded(db, t, raw)\nprov ||= providers[vendor]\nawait prov.complete(k, p)',
    'let prov\nawait prov.complete(k, p)',
  ]
  assert.deepEqual(UNGUARDED_VALUES.filter(text => unguardedUses('lib/seo/x.ts', text).length !== 1), [], 'each must be flagged unguarded')
  // every value these can produce is guarded or falsy
  const GUARDED_VALUES = [
    'const provider = ok ? ownerGuarded(db, t, raw) : null\nawait provider.complete(k, p)',
    'const provider = raw ? (x ? guardProvider(raw) : ownerGuarded(db, t, raw)) : undefined\nawait provider.complete(k, p)',
    'let prov = null\nprov = ownerGuarded(db, t, raw)\nawait prov.complete(k, p)',
  ]
  assert.deepEqual(GUARDED_VALUES.filter(text => unguardedUses('lib/seo/x.ts', text).length > 0), [], 'each must pass')
})

test('#850 inventory: each guarded-by-caller module has exactly that one guarded caller', () => {
  for (const [rel, fn, caller, guard] of GUARDED_BY_CALLER) {
    assert.ok(SOURCES.some(s => s.rel === rel), `${rel} exists`)
    assert.match(SOURCES.find(s => s.rel === caller)!.text, guard, `${caller} guards the provider it hands to ${rel}`)
    // Any import path that ends in the module (relative, '@/lib/...', with or without .ts), and a call of its function.
    const base = rel.split('/').pop()!.replace(/\.ts$/, '')
    const imports = new RegExp(`from\\s+['"][^'"]*/${base}(\\.ts)?['"]`)
    const callers = SOURCES.filter(s => s.rel !== rel && imports.test(s.text) && new RegExp(`\\b${fn}\\(`).test(s.text)).map(s => s.rel)
    assert.deepEqual(callers, [caller], `${fn} (${rel}) is called only from ${caller}`)
  }
})

// ---- behaviour: the two entry points no other test refuses ----

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const LIMIT = { DAZL_RUN_MAX_USD_USERS: 'A:0.0001', DAZL_OWNER_MONTH_MAX_USD_USERS: undefined, DAZL_ANTHROPIC_MODEL: undefined }
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const ARTICLE = `<html><head><title>Big CRM bought by MegaCorp</title></head><body><p>${'News content here. '.repeat(30)}</p></body></html>`
const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]

test('#850: SEO newsjack past the owner limit is refused with no model call', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  let modelCalls = 0
  const f = (async (u: string) => {
    if (String(u).includes('anthropic.com')) { modelCalls++; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'x'.repeat(200) }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }) }
    return new Response(ARTICLE, { status: 200 })
  }) as unknown as typeof fetch
  await withEnv(LIMIT, async () => {
    assert.deepEqual(await createNewsjack(sqliteDb(db), 'A', 'https://news.example/story', { fetchImpl: f, lookup: pubLookup, master }), { error: 'spend_limit' })
  })
  assert.equal(modelCalls, 0)
})

test('#850: sequence follow-up steps past the owner limit make no model call and keep the template text', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  saveMemory(db, 'A', { positioning: 'software that ramps new sales hires' })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.example', 'hiring AEs', 'https://n.example/a', 'quote', 80, 1800000000, 'test_review')").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const msg = createDraft(db, 'A', 'l1', 'Acme')
  const seq = createSequence(db, 'A', msg, { businessName: 'Acme' })
  let modelCalls = 0
  const f = (async () => { modelCalls++; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi Pat, a quick nudge about the AE hiring. Worth a short call?\n\nThanks,' }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }) }) as unknown as typeof fetch
  await withEnv(LIMIT, () => draftSequenceSteps(db, 'A', seq, 'Acme', { fetchImpl: f, master }))
  assert.equal(modelCalls, 0)
  const lead = { company: 'Acme', name: 'Pat', signal: 'hiring AEs', source_url: 'https://n.example/a' }
  const bodies = db.prepare('SELECT step, body FROM sequence_steps WHERE sequence_id = ? AND step > 1 ORDER BY step').all(seq) as { step: 2 | 3; body: string }[]
  assert.deepEqual(bodies.map(b => b.body), bodies.map(b => sequenceStepText(b.step, lead, 'Acme', null)))
})
