import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
test('actual same-play research route validates before network/write',()=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT
 const result=spawnSync(process.execPath,['--experimental-strip-types','--import','./test/helpers/net-fence.ts','--loader','./test/helpers/sequence-route-loader.mjs','--test','./test/helpers/play-research-route-runtime.mts'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,encoding:'utf8',timeout:30000})
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/# pass 1/)
})
