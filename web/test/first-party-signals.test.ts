// #390: consent-aware first-party signals. Synthetic sender, synthetic secret; no production tracking, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { setConsent, registerDomain, ingest, signatureFor, leadsFor, purge, WINDOW_S, type Incoming, type Deps } from '../lib/signals/first-party.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = 1_790_000_000, SECRET = 'synthetic-secret-1234'
const deps = (o: Partial<Deps> = {}): Deps => ({ now: NOW, secretFor: (t, d) => (t === 't1' && d === 'seller.example' ? SECRET : null), resolveOrg: async ip => ip === '203.0.113.9' ? { kind: 'business', company: 'Harbor Dental', domain: 'harbordental.example' } : ip === '198.51.100.7' ? { kind: 'residential' } : ip === '192.0.2.1' ? { kind: 'vpn' } : { kind: 'unknown' }, ...o })
const ev = (o: Partial<Incoming> = {}): Incoming => ({ site: 'seller.example', kind: 'demo_request', ts: NOW - 10, nonce: `n${Math.random().toString(36).slice(2, 12)}`, body: { email: 'fay@harbordental.example', name: 'Fay Buyer' }, ...o })
const send = (db: Db, e: Incoming, d: Deps = deps(), tenant = 't1', sigSecret = SECRET) => ingest(db, tenant, e, signatureFor(sigSecret, tenant, e), d)
async function ready(db: Db, visitor = false) { await setConsent(db, 't1', { collection: true, visitor }, NOW); await registerDomain(db, 't1', 'https://www.seller.example/') }

bothEngines('a consented synthetic form event produces a tenant-scoped, deduped lead with source, time and identity confidence', async ({ db }) => {
  await ready(db)
  const r = await send(db, ev()); assert.ok(r.ok && r.created && r.level === 'person' && r.identity_confidence === 80)
  const again = await send(db, ev({ ts: NOW - 5 })); assert.ok(again.ok && !again.created && again.id === (r as { id: string }).id, 'same person, same kind, same day: one lead')
  const leads = await leadsFor(db, 't1'); assert.equal(leads.length, 1); assert.equal(leads[0].source, 'first_party'); assert.equal(leads[0].occurred_at, NOW - 10); assert.match(leads[0].claim, /submitted your demo request/)
  assert.equal((await leadsFor(db, 't2')).length, 0, 'another tenant sees nothing')
})

bothEngines('collection is off until consent and opt-out disables it; opt-out also stops visitor events', async ({ db }) => {
  assert.deepEqual(await send(db, ev()), { ok: false, reason: 'collection_disabled' })
  await ready(db, true); assert.ok((await send(db, ev())).ok)
  await setConsent(db, 't1', { collection: false, visitor: true }, NOW)
  assert.deepEqual(await send(db, ev()), { ok: false, reason: 'collection_disabled' })
  assert.deepEqual(await send(db, ev({ kind: 'visitor', body: { ip: '203.0.113.9' } })), { ok: false, reason: 'collection_disabled' })
})

bothEngines('spoofing and replay: wrong domain, wrong/other-tenant signature, stale timestamp and a repeated nonce are all refused', async ({ db }) => {
  await ready(db)
  assert.deepEqual(await send(db, ev({ site: 'evil.example' })), { ok: false, reason: 'unknown_domain' })
  assert.deepEqual(await send(db, ev(), deps(), 't1', 'wrong-secret-0000'), { ok: false, reason: 'bad_signature' })
  const tampered = ev(); const sig = signatureFor(SECRET, 't1', tampered); tampered.body.email = 'boss@bigco.example'
  assert.deepEqual(await ingest(db, 't1', tampered, sig, deps()), { ok: false, reason: 'bad_signature' })
  assert.deepEqual(await send(db, ev({ ts: NOW - WINDOW_S - 1 })), { ok: false, reason: 'stale' })
  const e = ev(); assert.ok((await send(db, e)).ok); assert.deepEqual(await send(db, e), { ok: false, reason: 'replay' })
  assert.deepEqual(await send(db, ev({ nonce: 'x' })), { ok: false, reason: 'malformed' })
  await setConsent(db, 't2', { collection: true }, NOW); await registerDomain(db, 't2', 'seller.example')
  assert.deepEqual(await send(db, ev(), deps(), 't2'), { ok: false, reason: 'bad_signature' }, 'a tenant without the secret cannot post for this domain')
})

bothEngines('visitors: business traffic is an account-level lead; residential / VPN / unresolved create nothing; never a named person', async ({ db }) => {
  await ready(db, true)
  const v = await send(db, ev({ kind: 'visitor', body: { ip: '203.0.113.9' } })); assert.ok(v.ok && v.level === 'account' && v.identity_confidence <= 55)
  assert.deepEqual(await send(db, ev({ kind: 'visitor', body: { ip: '198.51.100.7' } })), { ok: false, reason: 'not_a_business' })
  assert.deepEqual(await send(db, ev({ kind: 'visitor', body: { ip: '192.0.2.1' } })), { ok: false, reason: 'not_a_business' })
  assert.deepEqual(await send(db, ev({ kind: 'visitor', body: { ip: '10.9.9.9' } })), { ok: false, reason: 'unresolved_visitor' })
  const viaEmail = await send(db, ev({ kind: 'visitor', body: { ip: '203.0.113.9', email: 'fay@harbordental.example', name: 'Fay Buyer' } as never, nonce: 'another-nonce-1' }))
  const l = (await leadsFor(db, 't1')).filter(x => x.kind === 'visitor'); assert.ok(viaEmail.ok)
  assert.ok(l.every(x => x.person_email === null && x.level === 'account'), 'a visit never names a person, even if the payload carries an email')
  assert.match(l[0].claim, /not a named person/)
})

bothEngines('visitor events need their own opt-in; free-mail form senders get low identity confidence and no company domain', async ({ db }) => {
  await ready(db, false)
  assert.deepEqual(await send(db, ev({ kind: 'visitor', body: { ip: '203.0.113.9' } })), { ok: false, reason: 'visitor_disabled' })
  const f = await send(db, ev({ body: { email: 'someone@gmail.com' } })); assert.ok(f.ok && f.identity_confidence === 40 && f.level === 'person')
  const nameless = await send(db, ev({ kind: 'form', body: {} })); assert.deepEqual(nameless, { ok: false, reason: 'no_identity' })
})

bothEngines('retention and erase-on-request purge what was collected', async ({ db }) => {
  await setConsent(db, 't1', { collection: true, retentionDays: 30 }, NOW); await registerDomain(db, 't1', 'seller.example')
  assert.ok((await send(db, ev())).ok)
  assert.equal(await purge(db, 't1', {}, NOW + 10 * 86400), 0)
  assert.equal(await purge(db, 't1', {}, NOW + 31 * 86400), 1); assert.equal((await leadsFor(db, 't1')).length, 0)
  assert.ok((await send(db, ev({ ts: NOW + 31 * 86400 - 5 }), deps({ now: NOW + 31 * 86400 }))).ok)
  assert.equal(await purge(db, 't1', { all: true }, NOW + 32 * 86400), 1)
})
