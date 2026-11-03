// What every read returns, role by role, with real sessions and memberships (workspace-session-loader.mjs): workspace
// A holds a marker secret in every credential store (model key, CRM key and webhook URL, enrichment key, social
// session, Cal.com signing secret) and the stored ciphertexts. Every session GET route is called as A's owner, an
// admin, an operator and a viewer. No response ever carries a credential, a ciphertext or a capability URL, with one
// exception the role table allows: the Cal.com signing secret, shown to admins and owners (configure) to paste into
// Cal.com, and to nobody below them. Any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, hashToken } from '../../lib/auth-db.ts'
import { getDb } from '../../lib/db/client.ts'
import { writeKey } from '../../lib/llm/key-store.ts'
import { saveCrmConfig } from '../../lib/crm/index.ts'
import { writeCredential } from '../../lib/connectors/store.ts'
import { rotateSecret } from '../../lib/calcom/index.ts'
import { ROUTES } from '../tenant-isolation-manifest.ts'
import type { Role } from '../../lib/workspaces.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
const id = 'aaaaaaaaaaaaaaaaaaaaaaaa'

test('no read returns a secret, a ciphertext or a capability URL; the Cal.com signing secret only to admins and owners', async () => {
  for (const u of ['A', 'D', 'O', 'V']) await createPasswordUser(user(u))
  const role: Record<string, Role> = { A: 'owner', D: 'admin', O: 'operator', V: 'viewer' }
  for (const u of ['D', 'O', 'V']) raw.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 1)').run('A', u, role[u])
  const tokens: Record<string, string> = {}
  for (const u of ['A', 'D', 'O', 'V']) { tokens[u] = await createSession(u); raw.prepare('UPDATE sessions SET active_tenant_id = ? WHERE id = ?').run('A', hashToken(tokens[u])) }

  // marker secrets in every credential store of workspace A
  const db = await getDb()
  const marks = { llm: `sk-ant-MARKERLLM${randomBytes(12).toString('hex')}`, crmKey: `MARKERCRM${randomBytes(12).toString('hex')}`, crmUrl: `https://hooks.example.test/MARKERURL${randomBytes(8).toString('hex')}`, enrich: `MARKERENR${randomBytes(12).toString('hex')}`, social: `MARKERSOC${randomBytes(12).toString('hex')}` }
  await writeKey(db, 'A', 'anthropic', marks.llm)
  saveCrmConfig(raw, 'A', { provider: 'hubspot', key: marks.crmKey })
  await writeCredential(db, 'A', 'enrich:apollo', marks.enrich)
  await writeCredential(db, 'A', 'adv:linkedin', marks.social)
  const calcom = await rotateSecret(db, 'A')
  // every stored ciphertext, too: none may be returned either (collected before and after the CRM switches to a webhook)
  const stored = () => (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).flatMap(({ name }) =>
    (raw.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]).flatMap(r => Object.entries(r)
      .filter(([k, v]) => typeof v === 'string' && v.length >= 24 && /cipher|enc|secret|key|token|sealed|wrapped|blob|cred/i.test(k) && !/hash|_id$|^id$/i.test(k))
      .map(([, v]) => v as string)))
  const never = [...Object.values(marks), ...stored()]
  saveCrmConfig(raw, 'A', { provider: 'webhook', url: marks.crmUrl })
  never.push(...stored())
  // the Cal.com signing secret is stored as-is (it signs the HMAC) and is checked on its own below
  const neverShown = never.filter(v => v !== calcom)
  const failures: string[] = []
  let calls = 0
  const gets = ROUTES.filter(r => r.auth === 'session' && r.method === 'GET')
  for (const u of ['A', 'D', 'O', 'V']) {
    for (const r of gets) {
      const mod = await import(`../../app/api/${r.path}/route.ts`) as Record<string, (req: NextRequest, ctx: unknown) => Promise<Response>>
      const url = `http://localhost/api/${r.path.replace(/\[[a-z]+\]/g, id)}?id=${id}&job_id=${id}&lead_id=${id}`
      const req = new NextRequest(url, { method: 'GET', headers: { host: 'localhost', origin: 'http://localhost' } })
      const text = await withJar(new Map([['dazl_session', tokens[u]]]), async () => {
        try { const res = await mod.GET(req, { params: Promise.resolve({ id, lead: id, batch: id }) }); return `${res.status} ${res.headers.get('location') ?? ''} ${await res.text()}` } catch (e) { return `threw ${(e as Error).message}` }
      })
      calls++
      for (const s of neverShown) if (text.includes(s)) failures.push(`${role[u]} GET /api/${r.path}: returned a stored credential (${s.slice(0, 12)}…)`)
      const calcomShown = text.includes(calcom)
      if (calcomShown && (role[u] === 'viewer' || role[u] === 'operator')) failures.push(`${role[u]} GET /api/${r.path}: returned the Cal.com signing secret`)
      if (r.path === 'settings/calcom') {
        if ((role[u] === 'owner' || role[u] === 'admin') !== calcomShown) failures.push(`${role[u]} GET /api/settings/calcom: secret ${calcomShown ? 'shown' : 'hidden'}`)
        if (!calcomShown && !JSON.parse(text.slice(text.indexOf('{'))).secret_hidden) failures.push(`${role[u]} GET /api/settings/calcom: secret_hidden not set`)
      }
    }
  }
  assert.deepEqual(failures, [])
  assert.ok(neverShown.length >= 8, `seeded ${neverShown.length} secrets and ciphertexts`)
  console.log('ROLE READS', calls)
})
