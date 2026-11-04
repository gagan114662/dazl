// #569: CRM push outcomes proven against provider response fixtures, replayed through the real pushLead.
// fixtures/crm/provider-shapes.json holds the providers' published response shapes (see its provenance);
// fixtures/crm/recorded/*.json holds captures from a sandbox run (scripts/crm-live-acceptance.mts --record), replayed
// the same way once they exist. A case passes only when pushLead reaches the recorded outcome using exactly the
// recorded requests, in order. No request leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { RecordedCase } from '../lib/crm/acceptance.ts'
import { replayCase } from './helpers/crm-replay.ts'

const DIR = fileURLToPath(new URL('./fixtures/crm/', import.meta.url))
type FixtureFile = { provenance: string; cases: RecordedCase[] }
const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as FixtureFile
const recordedDir = path.join(DIR, 'recorded')
const files = [path.join(DIR, 'provider-shapes.json'), ...(existsSync(recordedDir) ? readdirSync(recordedDir).filter(f => f.endsWith('.json')).sort().map(f => path.join(recordedDir, f)) : [])]

for (const file of files) {
  const fx = load(file)
  test(`replay ${path.relative(DIR, file)}: every case reaches its recorded outcome with exactly the recorded requests`, async () => {
    assert.ok(typeof fx.provenance === 'string' && fx.provenance.length > 20, 'a fixture says where its responses came from')
    assert.ok(Array.isArray(fx.cases) && fx.cases.length > 0)
    for (const c of fx.cases) {
      const { got, problems } = await replayCase(c)
      assert.deepEqual(problems, [], c.name)
      assert.deepEqual(got, c.expect, c.name)
    }
  })
}

test('provider shapes: a create is "created" only after a read-back that shows the lead; every other read-back is unknown', async () => {
  const fx = load(files[0])
  for (const c of fx.cases) {
    const posts = c.exchanges.filter(x => x.method === 'POST')
    assert.equal(posts.length, 1, `${c.name}: one create request`)
    const created = posts[0].status >= 200 && posts[0].status < 300
    if (c.expect.outcome === 'ok' && created) {
      const read = c.exchanges[1]
      assert.ok(read && read.method === 'GET' && read.status === 200 && read.path.endsWith(`/${c.expect.externalId}`), `${c.name}: ok only after reading the record back`)
    }
    if (created && c.exchanges.length === 2) assert.ok(c.expect.outcome === 'ok' || c.expect.outcome === 'unknown', `${c.name}: an unconfirmed create is never 'failed' (it may exist)`)
  }
  // the failure kinds #569 names, each covered for each provider
  const names = fx.cases.map(c => c.name)
  for (const want of [/hubspot create 201, read-back shows the lead/, /hubspot create 201, read-back holds another email/, /hubspot create 201, read-back 404/, /hubspot 409 CONFLICT/, /hubspot 409 OBJECT_ALREADY_EXISTS/, /hubspot 200 \{\}/,
    /pipedrive create 201, read-back shows the lead/, /pipedrive create 201, read-back holds another email/, /pipedrive create 201, read-back 404/, /pipedrive create 201, read-back soft-deleted/, /pipedrive 200 \{\}/])
    assert.ok(names.some(n => want.test(n)), String(want))
})

test('a fixture whose outcome is wrong, or whose requests differ, fails the replay (the check bites)', async () => {
  const c = load(files[0]).cases.find(x => x.name.startsWith('hubspot create 201, read-back holds another email'))!
  // the same exchanges claimed as "created" are not what pushLead does
  assert.equal((await replayCase(c)).got.outcome, 'unknown')
  // drop the read-back: pushLead asks for it anyway, which the replay reports
  const noRead = await replayCase({ ...c, exchanges: c.exchanges.slice(0, 1) })
  assert.match(noRead.problems.join(), /request 2: GET \/crm\/v3\/objects\/contacts\/151, recorded nothing/)
  assert.equal(noRead.got.outcome, 'unknown')
  // an exchange pushLead never asks for is reported too
  const extra = await replayCase({ ...c, exchanges: [...c.exchanges, { method: 'GET', path: '/crm/v3/objects/contacts/999', status: 200, body: {} }] })
  assert.match(extra.problems.join(), /1 recorded exchange\(s\) never requested/)
})
