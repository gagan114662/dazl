import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkChanges, fromGit } from '../scripts/production-literals.mjs'

const source = 'web/lib/scan/discover.ts'
const catalog = 'web/lib/sources/registry-source-catalog.ts'
const policyPath = '.github/policy/production-literals.json'
const policy = { version: 2, grandfathering: 'trusted_same_path_slot_counts' }
const check = (after, before = '', path = source, p = policy) => checkChanges([{ path, before, after }], p)
const literals = rows => rows.map(r => [r.kind, r.literal, r.receipt])
const marked = (kind, literal) => [kind, literal, null]

test('actual candidate policy validates; no terms, registry path or exception schema exists', () => {
  const actual = JSON.parse(readFileSync(new URL('../policy/production-literals.json', import.meta.url), 'utf8'))
  assert.deepEqual(checkChanges([], actual), [])
  for (const p of [{ ...actual, terms: [] }, { ...actual, registryPaths: [catalog] }, { ...actual, receipts: [] }, { ...actual, grandfathering: 'allow_all' }, null])
    assert.throws(() => checkChanges([], p), /invalid reviewed production-literal policy/)
})

test('operational identity slots deny unseen city, region, country, industry and company', () => {
  const patch = 'const q = { targetCity: "A city", fallbackRegion: "A region", countryCodes: ["AQ"], targetIndustry: "An industry", companyName: "A company" }'
  assert.deepEqual(literals(check(patch)), [
    marked('city', 'A city'), marked('region', 'A region'), marked('country', 'AQ'), marked('industry', 'An industry'), marked('company', 'A company'),
  ])
  assert.deepEqual(literals(check(patch, '', catalog)), literals(check(patch)))
})

test('literal computed comparison/assignments, destructured aliases, static alias values and switches', () => {
  const code = [
    'config["region"] = "Unseen A"',
    'if ("Unseen B" !== data[`country`]) hit()',
    'const { "companyName": org = "Unseen C", ["industry"]: sectorKey } = data;',
    'if (sectorKey === "Unseen D") hit()',
    'const geoKey = query.region; switch (geoKey) { case "Unseen E": hit() }',
    'const cityValue = "Unseen F"; const req = { city: cityValue }',
    'const unrelated = (geoKey) => geoKey === "not bound to the region";',
  ].join('\n')
  assert.deepEqual(literals(check(code)), [
    marked('region','Unseen A'), marked('country','Unseen B'), marked('company','Unseen C'),
    marked('industry','Unseen D'), marked('region','Unseen E'), marked('city','Unseen F'),
  ])
})

test('per-case markers cover string comparisons and typed map keys, numbers and booleans, not generic tuning', () => {
  const rows = check('if (plan.evalCaseId === "Case A") hit(); const cfg={perCaseTuning:{["Case B"]:{threshold:0.91,enabled:false}}}; const generic={threshold:0.91,enabled:false}; cfg.caseOverrides["Case C"]=0.23;')
  assert.ok(rows.length >= 4)
  for (const value of ['Case A','Case B','Case C','0.91','0.23','false'])
    assert.ok(rows.some(x => x.kind === 'case_tuning' && x.literal === value && !x.receipt), value)
  assert.deepEqual(check('const generic={threshold:0.91,enabled:false}; const genericSignal = "job_hiring";'), [])
})

test('ordinary UI copy, types, schema keys, imports, dynamic lookups and enum-like generic event data not guessed', () => {
  const code = [
    'import place from "uninterpreted"; type Shape = { region: "symbolic"; company: "company type" }',
    'const labels={countryLabel:"Choose a country",exampleTitle:"Dentists in Main City", companyCaption:"Who?"};',
    'const schema={type:"object", properties:{country:{type:"string"}}};',
    'const row={city:"",industry:"    ",locationLabel:"West",region:input.region};',
    'const { [raw]: country="unknown", title: city="display" } = data;',
    'if (opts[key] === "unknown" || opts["generic"] === "unknown") hit();',
  ].join('\n')
  assert.deepEqual(check(code), [])
})

test('legacy same-path/same-slot formatting stable; count, slot, lexical owner and runtime move are not allowances', () => {
  const initial = 'const target = { country: "AQ" }'
  assert.deepEqual(check("const target = { country: 'AQ' }", initial), [])
  assert.equal(check('const target = { countries: ["AQ", "AQ"] }', 'const target = { countries: ["AQ"] }')[0].added, 1)
  assert.equal(check('const target = { fallbackCountry: "AQ" }', initial)[0].added, 1)
  assert.equal(check('const other = { country: "AQ" }', initial)[0].added, 1)
  assert.equal(check('if (profile.country === "AQ") find()', initial)[0].added, 1)
})

test('production lib/app and existing components included, docs/fixtures/declarations excluded', () => {
  const addition = 'const q = { city: "New Name" }'
  for (const p of ['web/lib/site/a.ts','web/app/target/a.tsx','web/components/b.js']) assert.equal(check(addition, '', p).length, 1)
  for (const p of ['web/docs/notes.ts','web/test/a.ts','web/lib/__fixtures__/a.ts','web/lib/a.d.ts','web/lib/a.test.ts']) assert.deepEqual(check(addition, '', p), [])
})

function repoTest(fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'production-literal-blocking-'))
  const git = (...args) => execFileSync('git', args, { cwd, encoding:'utf8' })
  const write = (path, data) => { mkdirSync(dirname(join(cwd,path)), {recursive:true}); writeFileSync(join(cwd,path),data) }
  const commit = () => { git('add','-A'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'); return git('rev-parse','HEAD').trim() }
  try { git('init','-q'); fn({cwd,git,write,commit}) } finally { rmSync(cwd,{recursive:true,force:true}) }
}
test('trusted base policy wins over a candidate self-edit, and fixture/catalog moves do not import grandfathering',()=>{
  repoTest(({cwd,git,write,commit})=>{
    write(policyPath,JSON.stringify(policy))
    write(source,'const city="legacy";')
    write(catalog,'const country="old config";')
    write('web/test/fixture.ts','const company="fixture company";')
    const base=commit()
    renameSync(join(cwd,catalog), join(cwd,'web/lib/sources/renamed.ts'))
    renameSync(join(cwd,'web/test/fixture.ts'),join(cwd,'web/lib/sources/fixture-moved.ts'))
    write(policyPath,JSON.stringify({ ...policy, registryPaths: ['web/lib'] }))
    write(source,'const city="legacy"; const country="new country";')
    const head=commit()
    const rows=fromGit(base,head,git)
    assert.deepEqual(new Set(rows.map(r=>r.literal)),new Set(['new country','old config','fixture company']))
    assert.ok(rows.every(r=>r.receipt===null))
  })
})
test('CLI redacts raw source and returns nonzero on a true finding; parse and unsafe source modes fail unavailable',()=>{
  repoTest(({cwd,git,write,commit})=>{
    write(policyPath,JSON.stringify(policy))
    const base=commit()
    write(source,'const country="do not leak raw value";')
    const head=commit()
    const cli=fileURLToPath(new URL('../scripts/production-literals.mjs',import.meta.url))
    const r=spawnSync(process.execPath,[cli,base,head],{cwd,encoding:'utf8'})
    assert.equal(r.status,1,r.stderr)
    assert.deepEqual(JSON.parse(r.stdout),[{kind:'country',added:1,receipt:null}])
    assert.ok(!r.stdout.includes('raw value'))
    write(source,'const country=')
    assert.throws(()=>fromGit(base,commit(),git),/cannot parse/)
    rmSync(join(cwd,source));symlinkSync('unreviewed-source',join(cwd,source))
    assert.throws(()=>fromGit(base,commit(),git),/unexpected production source mode|unsupported status/)
  })
})
test('oversize either source side refuses rather than silently dropping scope',()=>{
  assert.throws(()=>check('/*'+ 'x'.repeat(2*1024*1024)+'*/ const city="Unseen";'), /oversize/)
})

test('location, where, target category and employer names and explicitly named numeric case comparisons are governed', () => {
  const code = [
    'const target={location:"A",locations:["B"],where:"C",targetLocation:"D",category:"E",targetCategory:"F"};',
    'const cfg={employer:"G",organization:"H",businessName:"I"};',
    'if (ctx.scorecardCaseOrdinal >= 4 || -1 === ctx.evalCaseIndex) hit();',
    'const nth=3; if (ctx.scorecardCaseIndex !== nth) hit();',
    'switch(ctx.benchmarkCaseIndex){case 5: break}',
    'if (list.index > 4 || generic.threshold >= 0.90) hit();',
  ].join('\n')
  assert.deepEqual(literals(check(code)), [
    ...['A','B','C','D'].map(x=>marked('location',x)), ...['E','F'].map(x=>marked('industry',x)),
    ...['G','H','I'].map(x=>marked('company',x)), ...['4','-1','3','5'].map(x=>marked('case_tuning',x)),
  ])
})

test('static comparison methods detect governed intent, not generic regex, paths, labels, SQL or arbitrary string calls', () => {
  const code = [
    'const org = intent.businessName;',
    'if (org.trim().startsWith("exact prefix")) hit();',
    'if (intent.where.includes("needle")) hit();',
    'if (/^fixed location$/iu.test(intent.targetLocation)) hit();',
    'const matchIndustry = /industry fixed/i; if (matchIndustry.test(intent.targetCategory)) hit();',
    'if (["fixed member"].includes(intent.employer)) hit();',
    'if (title.includes("user facing") || /hello/i.test(message) || window.location.href.startsWith("/about")) hit();',
    'query("select * from teams where location=literal");',
  ].join('\n')
  assert.deepEqual(literals(check(code)), [
    marked('company','exact prefix'),marked('location','needle'),marked('location','/^fixed location$/iu'),
    marked('industry','/industry fixed/i'),marked('company','fixed member'),
  ])
})

test('import-bound error location tags are not targeting; unrelated and shadowed copies still govern where', () => {
  const code = [
    'import {captureError as record} from "../ops/errors.ts";',
    'record(err,{where:"diagnostic tag"});',
    'const override = {where:"actual targeting"};',
    'function other(record){record(err,{where:"govern a shadowed call"});}',
  ].join('\n')
  assert.deepEqual(literals(check(code)), [marked('location','actual targeting'),marked('location','govern a shadowed call')])
})

test('generic work-mode rejection is not a named-location exception; mixed patterns still fail', () => {
  const generic = String.raw`/\b(remote|hybrid|multiple locations)\b/i`
  const mixed = String.raw`/\b(remote|Example City)\b/i`
  assert.deepEqual(literals(check(`const rejected = ${generic}.test(location);`)), [])
  assert.deepEqual(literals(check(`const rejected = ${mixed}.test(location);`)), [marked('location', mixed)])
  assert.deepEqual(literals(check(`const rejected = ${generic}.test(company);`)), [marked('company', generic)])
})
