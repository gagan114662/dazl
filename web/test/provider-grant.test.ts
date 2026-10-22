import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { tinyfishGrant } from '../lib/search/provider-grant.ts'
import { migrateTinyfish, tfSearch, tfFetch, resetTinyfishState } from '../lib/search/tinyfish.ts'
const now = 1_800_000_000
const entry = { tenantId: 'test', approvalRef: 'TEST ONLY, not real approval', acceptsPossibleCharges: true, expiresAt: now+60, maxRequests: 2 }
const env = (entries: unknown) => ({ TINYFISH_API_KEY: 'mock-only', TINYFISH_APPROVED_TENANTS: JSON.stringify(entries) })
test('grant gate fails closed for missing, malformed, wrong tenant, expired and free-only claims', () => {
  assert.equal(tinyfishGrant({},'test',now).allowed,false)
  assert.equal(tinyfishGrant({TINYFISH_APPROVED_TENANTS:'invalid'},'test',now).allowed,false)
  for(const e of [{...entry, tenantId:'other'},{...entry,expiresAt:now},{...entry,acceptsPossibleCharges:false},{...entry,maxRequests:0},{...entry,approvalRef:''}])
    assert.equal(tinyfishGrant(env([e]),'test',now).allowed,false)
  assert.equal(tinyfishGrant(env([entry,entry]),'test',now).allowed,false)
  assert.equal(tinyfishGrant(env([entry]),'test',now).allowed,true)
})
test('unapproved search/fetch call no network and consume no units', async () => {
  const db=new Database(':memory:'); migrateTinyfish(db); resetTinyfishState(); let calls=0
  const fetchImpl=(async()=>{calls++; return new Response('{}')}) as typeof fetch
  const e={TINYFISH_API_KEY:'mock-only'}
  assert.equal((await tfSearch(db,'test','query',{}, {searches:0},{env:e,fetchImpl,now})).ok,false)
  assert.equal((await tfFetch(db,'test',['https://example.com'],{fetches:0},{env:e,fetchImpl,now})).ok,false)
  assert.equal(calls,0); assert.equal((db.prepare('SELECT count(*) n FROM tinyfish_usage').get() as {n:number}).n,0)
})
test('shared search/fetch approval units reserve before calls and stop overflow', async () => {
  const db=new Database(':memory:'); migrateTinyfish(db); resetTinyfishState(); let calls=0
  const fetchImpl=(async()=>{calls++; return new Response('{"results":[]}')}) as typeof fetch
  const d={env:env([entry]),fetchImpl,now}
  assert.equal((await tfSearch(db,'test','query',{}, {searches:0},d)).ok,true)
  assert.equal((await tfFetch(db,'test',['https://example.com'],{fetches:0},d)).ok,true)
  assert.deepEqual(await tfSearch(db,'test','again',{}, {searches:0},d),{ok:false,reason:'approval_limit'})
  assert.equal(calls,2)
})
