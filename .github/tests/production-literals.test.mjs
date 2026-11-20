import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,renameSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {checkChanges,fromGit,DESIGNATED_CATALOG} from '../scripts/production-literals.mjs'
const source='web/lib/scan/discover.ts'
const registry=DESIGNATED_CATALOG
const neighbor='web/lib/sources/registry-source-catalog-extra.ts'
const terms=[{kind:'city',label:'Utrecht',source:'docs/reviewed-geography.md'},{kind:'industry',label:'Dental Practices',source:'docs/reviewed-industries.md'}]
const policy={version:1,terms,registryPaths:[registry],receipts:[]}
const check=(after,before='',path=source,p=policy)=>checkChanges([{path,before,after}],p)
test('the policy blob from the same candidate commit passes the scanner schema',()=>{
  const actual=JSON.parse(readFileSync(new URL('../policy/production-literals.json',import.meta.url),'utf8'))
  assert.deepEqual(checkChanges([],actual),[])
  const widened={...actual,registryPaths:[...actual.registryPaths,neighbor]}
  assert.throws(()=>checkChanges([],widened),/invalid reviewed production-literal policy/)
})
test('new exact operational city/industry each fail; aliases/copy are not falsely inferred',()=>{
  assert.deepEqual(check('const targetCity = cfg?.city ?? "Utrecht"; let plan={industries:["Dental Practices"]};').map(x=>[x.kind,x.receipt]),[['city',null],['industry',null]])
  assert.deepEqual(check('const help = "Search Dental Practices in Utrecht"; const path = "./Utrecht"; import city from "Utrecht";'),[])
  assert.deepEqual(check('const city = "Utrechtshire"; const industry = "Utrecht";').map(x=>[x.kind,x.literal]),
    [['city','Utrechtshire'],['industry','Utrecht']])
})
test('formatting stays grandfathered, an added copy still gets flagged',()=>{
  assert.deepEqual(check("const city = 'Utrecht'\n",'const city="Utrecht";'),[])
  assert.equal(check('const cities=["Utrecht","Utrecht"]','const cities=["Utrecht"]')[0].added,1)
})
test('docs, fixtures, TS declarations and source outside lib/app/components not in scope',()=>{
  const hard='const city="Utrecht"'
  for (const p of ['web/scripts/home/reader.ts','web/lib/scan/docs/example.ts','web/lib/scan/path.test.ts','web/lib/scan/path.fixture.ts','web/lib/scan/path.d.ts','docs/notes.ts','web/lib/scan/fixtures/path.ts']) assert.deepEqual(check(hard,'',p),[],p)
})
test('only the designated catalog file is a permitted config location',()=>{
  const code='const rules={city:"Unseen city",industries:["Unseen industry"],fallbackCity:"Second city"};'
  assert.deepEqual(check(code,'',registry).map(r=>r.receipt?.authority),Array(3).fill('designated_catalog'))
  for(const path of [source,neighbor,'web/lib/sources/registry-source-catalog.tsx','web/lib/sources/Registry-source-catalog.ts']) {
    assert.deepEqual(check(code,'',path).map(r=>r.receipt),Array(3).fill(null))
  }
})
test('real local Git loader pins reviewed base policy and follows exact production rename only',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'literal-policy-'))
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trimEnd()
 const raw=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'})
 const write=(path,text)=>{mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),text)}
 const commit=()=>{git('add','-A');git('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','fixture');return git('rev-parse','HEAD')}
 try {
  git('init','-q')
  const cfg='.github/policy/production-literals.json'
  write(cfg,JSON.stringify(policy));write(source,'const city="Utrecht"');write('web/test/fixture.ts','const industry="Dental Practices"')
  const base=commit()
  renameSync(join(cwd,source),join(cwd,'web/lib/scan/renamed.ts'))
  mkdirSync(dirname(join(cwd,neighbor)),{recursive:true})
  renameSync(join(cwd,'web/test/fixture.ts'),join(cwd,neighbor))
  write(cfg,JSON.stringify({...policy,registryPaths:[registry,neighbor],receipts:[]}))
  assert.deepEqual(fromGit(base,commit(),raw).map(r=>[r.path,r.receipt]),[[neighbor,null]])
 } finally {rmSync(cwd,{recursive:true,force:true})}
})

test('same-count typed field move does not grandfather new fallback city or default industry', () => {
  const before='const config={city:"Utrecht"}; const industry="Dental Practices";'
  const after='const config={fallbackCity:"Utrecht"}; const defaultIndustry="Dental Practices";'
  const findings=check(after,before)
  assert.deepEqual(findings.map(r=>[r.kind,r.added,r.receipt]),[['city',1,null],['industry',1,null]])
})
test('same-count move from typed initializer to explicit match is new hardcoding', () => {
  assert.equal(check('if (config.city === "Utrecht") start();','const city = "Utrecht";')[0]?.added,1)
})
test('exact content renamed out of allowed catalog becomes new outside hardcoding',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'literal-catalog-rename-'))
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'})
 const write=(path,text)=>{mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),text)}
 const commit=()=>{git('add','-A');git('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','fixture');return git('rev-parse','HEAD').trim()}
 try {
  git('init','-q')
  write('.github/policy/production-literals.json',JSON.stringify(policy))
  write(registry,'const city="Catalog jurisdiction";')
  const base=commit()
  renameSync(join(cwd,registry),join(cwd,neighbor))
  const head=commit()
  assert.match(git('diff','--name-status','--find-renames=100%',base,head),/^R100/)
  assert.deepEqual(fromGit(base,head,git).map(r=>[r.path,r.receipt]),[[neighbor,null]])
 } finally {rmSync(cwd,{recursive:true,force:true})}
})

test('unlisted nonempty direct identity literals deny by default',()=>{
  const rows=check('const cfg={city:"Unlisted city", industries:["Unlisted industry"],fallbackCity:`Unlisted fallback`};')
  assert.deepEqual(rows.map(r=>[r.kind,r.literal,r.receipt]),[
    ['city','Unlisted city',null],['industry','Unlisted industry',null],['city','Unlisted fallback',null],
  ])
})
test('existing unlisted literal formatting is grandfathered, added slot or copy is not',()=>{
  const before='const cfg={city:"Unlisted city", industries:["Existing other"]};'
  assert.deepEqual(check("const cfg = { city:'Unlisted city', industries:['Existing other'] }",before),[])
  const rows=check('const cfg={fallbackCity:"Unlisted city", industries:["Existing other","Unlisted industry"]};',before)
  assert.deepEqual(rows.map(r=>[r.literal,r.added]),[['Unlisted city',1],['Unlisted industry',1]])
})
test('display copy, generic terms, empty sentinels and unsupported AST shapes remain outside strong slots',()=>{
  const rows=check('const cfg={title:"City: Unlisted", city:"", industries:["   "], sector:"Other", location:"Unlisted city", cityGuide:"Browse cities", cityLabel:"Choose a city", targetCity:raw, fallbackCity:`New ${name}`};')
  assert.deepEqual(rows,[])
})
test('trusted config cannot add a second path or broader receipt',()=>{
  const illegal={...policy,registryPaths:[registry,neighbor]}
  assert.throws(()=>check('const city="Other"','',neighbor,illegal), /invalid reviewed production-literal policy/)
  assert.throws(()=>check('const city="Other"','',neighbor,{...policy,registryPaths:[neighbor]}), /invalid reviewed production-literal policy/)
  assert.throws(()=>check('const city="Other"','',neighbor,{...policy,receipts:[{path:neighbor}]}), /invalid reviewed production-literal policy/)
})

test('oversized scoped input fails closed instead of dropping new literals',()=>{
  assert.throws(()=>check('/*'+ 'x'.repeat(2*1024*1024)+'*/ const city="Unseen";'), /oversize/)
})

test('production lib/app/components use the same explicit identity policy, not UI copy inference',()=>{
  assert.equal(check('const profile={defaultCity:"Outside list"}','', 'web/lib/profile/default.ts')[0]?.receipt,null)
  assert.equal(check('const Page=()=> <Search city="Outside list" />','', 'web/app/search/page.tsx')[0]?.receipt,null)
  assert.equal(check('const View=()=> <Search industry={`Outside list`} />','', 'web/components/search/view.jsx')[0]?.receipt,null)
  assert.deepEqual(check('const Page=()=> <Search cityLabel="Select a city" title="Outside list" />','', 'web/app/search/page.tsx'),[])
  assert.deepEqual(check('const Fixture=()=> <Search city="Outside list" />','', 'web/components/fixtures/search.tsx'),[])
})

test('legacy reviewed sector moved into original discovery scope does not inherit old uncovered slot',()=>{
  const code='const sector = "Dental Practices";'
  const r=checkChanges([{path:source,beforePath:'web/lib/seller/config.ts',before:code,after:code}],policy)
  assert.equal(r[0]?.receipt,null)
})

test('empty governed policy is valid deny-by-default, not an authorization gap',()=>{
  const empty={version:1,terms:[],registryPaths:[registry],receipts:[]}
  assert.deepEqual(check('const cfg={city:"Unexpected city", industry:"Unexpected industry"}','',source,empty).map(x=>[x.kind,x.receipt]),[
    ['city',null],['industry',null],
  ])
  assert.deepEqual(check("const city = 'Existing city'",'const city="Existing city"',source,empty),[])
  assert.throws(()=>check('const city="Existing city"','',registry,{...empty,registryPaths:[registry],receipts:[
    {path:registry,kind:'city',literal:'Existing city',issue:'#1393',rationale:'Purported source receipt without any approved terms.',maxAdded:1},
  ]}),/invalid reviewed production-literal policy/)
  assert.throws(()=>check('const city="Any city"','',source,{...empty,terms:null}),/invalid reviewed production-literal policy/)
})

test('explicit literal element keys and object binding defaults count as identity fields',()=>{
  const code=[
    'settings["city"] = "Unseen A";',
    'if (settings[`industry`] === "Unseen B") return;',
    'if ("Unseen C" !== settings["defaultCity"]) return;',
    'const { industry = "Unseen D", "city": locality = "Unseen E", ["targetIndustry"]: sector = "Unseen F" } = settings;',
    'const settingsOverride = { ["fallbackCity"]: "Unseen G" };',
  ].join('\n')
  assert.deepEqual(check(code).map(x=>[x.kind,x.literal,x.receipt]),[
    ['city','Unseen A',null],['industry','Unseen B',null],['city','Unseen C',null],
    ['industry','Unseen D',null],['city','Unseen E',null],['industry','Unseen F',null],['city','Unseen G',null],
  ])
})
test('dynamic keys, ungoverned destructured aliases, and positional binding defaults remain unclassified',()=>{
  const code=[
    'settings[city] = "Unknown A";',
    'if (settings[industry] === "Unknown B") return;',
    'const { [key]: city = "Unknown C", title: industry = "Unknown D" } = settings;',
    'const [city = "Unknown E"] = tuple;',
    'const override = { [key]: "Unknown F" };',
  ].join('\n')
  assert.deepEqual(check(code),[])
})
