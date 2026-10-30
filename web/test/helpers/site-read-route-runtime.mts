// POST /api/scan/icp-from-url's trial admission, through the real route handler on a real SQLite store: the trial is the
// workspace's own (its founder's account, read on the server), never the acting member's. Instinct's negative on
// fa220d8: an owner refused for an already-used company domain must stay refused when an invited member with a free
// email address acts in that workspace. Synthetic accounts; the page fetch and model call are stubbed
// (icp-from-site-stub.ts); no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { handedKeys } from './icp-from-site-stub.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { admitTrialScan } from '../../lib/billing/trial-budget.ts'
import { POST } from '../../app/api/scan/icp-from-url/route.ts'

const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
Object.assign(process.env, { DAZL_TRIAL_ANTHROPIC_KEY: OP, DAZL_TRIAL_SITE_READS_PER_DAY: '50', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' })
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch

const uid = (n: number) => n.toString(16).padStart(32, '0')
let ip = 10
const post = async () => {
  const req = new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `198.51.100.${ip++}` }, body: JSON.stringify({ url: 'https://acme.example' }) })
  const before = handedKeys.length
  const r = await POST(req)
  const j = await r.json() as { error?: string; trial?: string }
  return { trial: j.trial ?? null, operatorKey: handedKeys.length > before }
}

test('the site read trial is the workspace founder\'s own account, acting itself (owner, invited member, another actor, Google, same domain, team workspace)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw)
  const account = async (id: string, email: string, personal = true, google = true) => {
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
    if (google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
    if (personal) await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [id, id])
  }
  const PRIOR = uid(1), OWNER = uid(2), INVITED = uid(3), FREE = uid(4), CORP_ACTOR = uid(5), TEAM = uid(6), NOGOOGLE = uid(7), SAME = uid(8)
  await account(PRIOR, 'b@corp.example'); await account(OWNER, 'a@corp.example'); await account(INVITED, 'invited@gmail.com')
  await account(FREE, 'solo@gmail.com'); await account(CORP_ACTOR, 'c@corp.example')
  assert.equal((await admitTrialScan(db, { id: PRIOR, email: 'b@corp.example' }, { env: process.env })).ok, true, 'fixture: corp.example already used a trial')

  // 1. Same-domain control: the founder of a workspace whose company domain already had its trial is refused.
  setUser({ id: OWNER, business_name: 'Acme', email: 'a@corp.example' })
  assert.deepEqual(await post(), { trial: 'domain_used', operatorKey: false }, 'owner: domain_used')
  // 2. Instinct's negative: the same workspace, acted in by an invited member with a free address. Refused, no key.
  setUser({ id: OWNER, actorId: INVITED, role: 'operator', business_name: 'Acme', email: 'invited@gmail.com' })
  assert.deepEqual(await post(), { trial: 'workspace_not_eligible', operatorKey: false }, 'invited member: never the workspace trial')
  // 3. Positive control: an eligible workspace's founder is admitted (the operator key is handed to the read).
  setUser({ id: FREE, business_name: 'Solo', email: 'solo@gmail.com' })
  assert.deepEqual(await post(), { trial: null, operatorKey: true }, 'eligible founder: admitted')
  // 4. Another member acting in that eligible workspace (own address at the used domain or not): refused, as for scans.
  for (const [actor, email] of [[CORP_ACTOR, 'c@corp.example'], [INVITED, 'invited@gmail.com']]) {
    setUser({ id: FREE, actorId: actor, role: 'operator', business_name: 'Solo', email })
    assert.deepEqual(await post(), { trial: 'workspace_not_eligible', operatorKey: false }, `member ${email} in an eligible workspace`)
  }
  // 5. The founder's own Google sign-in decides, not a member's: a founder without one is refused google_required.
  await account(NOGOOGLE, 'nog@fresh.example', true, false)
  setUser({ id: NOGOOGLE, business_name: 'NoG', email: 'nog@fresh.example' })
  assert.deepEqual(await post(), { trial: 'google_required', operatorKey: false }, 'founder without Google sign-in')
  // 6. Same-domain control for the session email: a founder whose session claims another address is judged by its own
  //    users row (corp.example, used), never by the session's. getSessionUser reads both from one users row, so the
  //    store cannot produce this session today; the case pins that admission never reads the session's email.
  await account(SAME, 'd@corp.example')
  setUser({ id: SAME, business_name: 'Corp D', email: 'd-alias@gmail.com' })
  assert.deepEqual(await post(), { trial: 'domain_used', operatorKey: false }, 'founder: the stored address decides')
  // 7. A team workspace (no founder users row for its id): fails closed, whoever acts.
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'Team', 'team', ?, 1)", [TEAM, FREE])
  for (const [actor, email] of [[FREE, 'solo@gmail.com'], [INVITED, 'invited@gmail.com'], [TEAM, 'team@gmail.com']]) {
    setUser({ id: TEAM, actorId: actor, role: 'owner', business_name: 'Team', email })
    assert.deepEqual(await post(), { trial: 'workspace_not_eligible', operatorKey: false }, `team workspace, actor ${email}`)
  }
  console.log('SITE_READ_ROUTE ok')
})
