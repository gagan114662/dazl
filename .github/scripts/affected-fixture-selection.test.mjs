import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const selector=process.env.SELECTOR_UNDER_TEST??fileURLToPath(new URL('./affected-tests.mjs',import.meta.url))
const worker='web/test/fixtures/workers/echo.v1.0.0.ts'
const route='web/test/workers-route.test.ts'
const direct='web/test/echo.test.ts'

function selected(change){
  const cwd=mkdtempSync(join(tmpdir(),'affected-fixture-'))
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim()
  function put(path,text){const full=join(cwd,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,text)}
  try{
    git('init','-q')
    git('config','user.name','Fixture')
    git('config','user.email','fixture@example.invalid')
    put(worker,'export const status=200\n')
    put(direct,'// fixtures/workers/echo.v1.0.0.ts direct reference\n')
    put(route,"import './helpers/workers-route-runtime.mts'\n")
    put('web/test/helpers/workers-route-runtime.mts',"import '../../lib/worker-registry.ts'\n")
    put('web/lib/worker-registry.ts',"import '../test/fixtures/workers/echo.v1.0.0.ts'\n")
    git('add','.');git('commit','-qm','base')
    const base=git('rev-parse','HEAD')
    change({put,git,cwd})
    git('add','-A');git('commit','-qm','change')
    return execFileSync(process.execPath,[selector,base],{cwd,encoding:'utf8'}).trim()
  }finally{rmSync(cwd,{recursive:true,force:true})}
}
test('a directly named fixture also serves an indirect worker-route test: conservatively select both via ALL',()=>{
  assert.equal(selected(({put})=>put(worker,'export const status=404\n')),'ALL')
})
test('top-level executable test still selects itself',()=>{
  assert.equal(selected(({put})=>put(route,'// changed\n')),'test/workers-route.test.ts')
})
test('a fixture deletion and data-only input both select ALL',()=>{
  assert.equal(selected(({git})=>git('rm',worker)),'ALL')
  assert.equal(selected(({put})=>put('web/test/fixtures/source-data.json','{}')),'ALL')
})
