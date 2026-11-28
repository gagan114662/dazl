// #2084 exact-head review (Ziggy) blockers, each with its own control:
//  B1 authorization: a scan input never carries readings - a planted reading is not merged; only this run's reading persists.
//  B2 guard latch: the optional reading call runs AFTER discovery reserves and spends, so a refused reading cannot stop discovery.
//  B3 write race: the merge is a compare-and-swap - a concurrent profile edit is preserved, not overwritten.
//  B4 cache identity: a reading judged in one language is not reused after a language change; it is re-read.
//  B5 repeat spend: OTHER is a persisted no-play reading and a refused wording backs off - neither is paid for twice.
//  plus a two-tenant control.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { fillReadings } from '../lib/scan/signal-readings.ts'
import { normalizeIcp, type Icp } from '../lib/scan/icp.ts'
import { providers } from '../lib/llm/provider.ts'

const rd = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const migrate = (db: Database.Database) => db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, buyer_profile TEXT)')
const profile = (lang: string, signals: string[]): Icp => normalizeIcp({
  summary: 'Dental practices in Ohio', who: ['Practice owner'], industries: ['dentistry'], sizes: [], where: ['Ohio'], signals, exclude: [], language: lang,
})!
const seed = (db: Database.Database, id: string, icp: Icp) => db.prepare('INSERT INTO users (id, buyer_profile) VALUES (?, ?)').run(id, JSON.stringify(icp))
const load = (db: Database.Database, id: string): Icp | null => { const raw = db.prepare('SELECT buyer_profile FROM users WHERE id = ?').pluck().get(id) as string | null | undefined; return raw ? normalizeIcp(JSON.parse(raw)) : null }
const provider = (complete: (key: string, prompt: string) => Promise<string>) => ({ ...providers.anthropic, complete }) as unknown as typeof providers.anthropic
const answer = (map: Record<string, string>, calls: string[][] = []) => provider(async (_k, prompt) => {
  const words = [...prompt.matchAll(/^(\d+)\. (.*)$/gm)].map(m => m[2].trim()); calls.push(words)
  return words.map((w, i) => `${i + 1}. ${map[w] ?? 'OTHER'}`).join('\n')
})

test('#2084 B1: a reading planted on the scan input is ignored; only this run\'s reading is merged (operator cannot plant)', async () => {
  const db = new Database(':memory:'); migrate(db)
  seed(db, 't1', profile('de', ['Wir stellen SDRs ein']))
  // the scan input carries a planted reading and label (what an `operate` member could submit)
  const input = normalizeIcp({ ...profile('de', ['Wir stellen SDRs ein']), signal_readings: { 'Wir stellen SDRs ein': { kind: 'hiring', role: 'PLANTED', at: 1 } }, signal_unread: { 'Wir stellen SDRs ein': { at: 1 } } })!
  const calls: string[][] = []
  const got = await fillReadings(db, 't1', input, 'sk-ant-scan', answer({ 'Wir stellen SDRs ein': 'NOT_HIRING' }, calls))
  assert.equal(calls.length, 1, 'the run reads it (the planted input is not used as a cache)')
  assert.equal(got.signal_readings?.['Wir stellen SDRs ein']?.kind, 'not_hiring', 'the run profile carries the judge reading, never the planted one')
  assert.notEqual((got.signal_readings?.['Wir stellen SDRs ein'] as { role?: string })?.role, 'PLANTED')
  const saved = load(db, 't1')!
  assert.equal(saved.signal_readings?.['Wir stellen SDRs ein']?.kind, 'not_hiring', 'the saved profile got the judge reading')
  assert.notEqual((saved.signal_readings?.['Wir stellen SDRs ein'] as { role?: string })?.role, 'PLANTED', 'the planted reading was not persisted')
})

test('#2084 B2: the reading call runs after discovery reserves and spends, and a refused reading never throws', () => {
  const runner = rd('../lib/scan/runner.ts')
  const lane = runner.slice(runner.indexOf('async function runDiscoverLane'))
  const reserve = lane.indexOf('reserveNativeSearch(spendGuards')
  const fill = lane.indexOf('fillReadings(db, job.user_id, profile, key, profileProvider')
  assert.ok(reserve > 0 && fill > 0, 'both present')
  assert.ok(reserve < fill, 'discovery is reserved BEFORE the optional reading call (a refused reading cannot latch it)')
  assert.match(lane.slice(fill - 200, fill + 120), /try \{[\s\S]*fillReadings[\s\S]*\} catch/, 'the reading call is best-effort')
})

test('#2084 B2: fillReadings swallows a refused provider and returns the profile (the scan is never failed by a reading)', async () => {
  const db = new Database(':memory:'); migrate(db)
  seed(db, 't1', profile('de', ['Wir stellen SDRs ein']))
  const icp = profile('de', ['Wir stellen SDRs ein'])
  const got = await fillReadings(db, 't1', icp, 'sk-ant-scan', provider(async () => { throw new Error('owner_pool_limit') }))
  assert.deepEqual(got.signals, ['Wir stellen SDRs ein'], 'the profile survives a refused reading')
  assert.equal(got.signal_readings, undefined)
  assert.ok(load(db, 't1')!.signal_unread?.['Wir stellen SDRs ein'], 'the refused wording is labelled with a backoff')
})

test('#2084 B3: a concurrent profile edit is preserved by the compare-and-swap merge, and the reading is still added', async () => {
  const db = new Database(':memory:'); migrate(db)
  const base = profile('de', ['Wir stellen SDRs ein'])
  seed(db, 't1', base)
  // the judge call edits the profile concurrently (as another request would) before returning its reading
  const concurrent = normalizeIcp({ ...base, who: ['Changed by an admin'] })!
  const p = provider(async () => { db.prepare('UPDATE users SET buyer_profile = ? WHERE id = ?').run(JSON.stringify(concurrent), 't1'); return '1. HIRING: SDRs' })
  await fillReadings(db, 't1', base, 'sk-ant-scan', p)
  const saved = load(db, 't1')!
  assert.deepEqual(saved.who, ['Changed by an admin'], 'the concurrent edit to another field is not overwritten')
  assert.equal(saved.signal_readings?.['Wir stellen SDRs ein']?.kind, 'hiring', 'this run\'s reading is merged onto the concurrent edit')
})

test('#2084 B4: a reading judged in one language is not reused after a language change; it is re-read', async () => {
  const db = new Database(':memory:'); migrate(db)
  const de = profile('de', ['Wir stellen SDRs ein'])
  // saved with a German reading, but the scan now runs the same wording as French
  seed(db, 't1', normalizeIcp({ ...de, signal_readings: { 'Wir stellen SDRs ein': { kind: 'hiring', role: 'SDRs', at: 100, lang: 'de' } } })!)
  const calls: string[][] = []
  const fr = profile('fr', ['Wir stellen SDRs ein'])
  await fillReadings(db, 't1', fr, 'sk-ant-scan', answer({ 'Wir stellen SDRs ein': 'NOT_HIRING' }, calls))
  assert.equal(calls.length, 1, 'a de reading is not reused for a fr run')
  const saved = load(db, 't1')!
  assert.equal(saved.signal_readings?.['Wir stellen SDRs ein']?.kind, 'not_hiring', 'the fr run re-read it')
  assert.equal(saved.signal_readings?.['Wir stellen SDRs ein']?.lang, 'fr')
})

test('#2084 B5: OTHER is persisted and not re-asked; a refused wording backs off and is not re-asked', async () => {
  const db = new Database(':memory:'); migrate(db)
  seed(db, 't1', profile('de', ['Kaffee']))
  const first: string[][] = []
  await fillReadings(db, 't1', profile('de', ['Kaffee']), 'sk-ant-scan', answer({ Kaffee: 'OTHER' }, first))
  assert.equal(first.length, 1)
  assert.equal(load(db, 't1')!.signal_readings?.Kaffee?.kind, 'other', 'OTHER is a persisted no-play reading')
  const second: string[][] = []
  await fillReadings(db, 't1', profile('de', ['Kaffee']), 'sk-ant-scan', answer({ Kaffee: 'HIRING: X' }, second))
  assert.equal(second.length, 0, 'a persisted OTHER wording is not paid for again')

  seed(db, 't2', profile('de', ['Wir stellen SDRs ein']))
  await fillReadings(db, 't2', profile('de', ['Wir stellen SDRs ein']), 'sk-ant-scan', provider(async () => { throw new Error('over_limit') }))
  assert.ok(load(db, 't2')!.signal_unread?.['Wir stellen SDRs ein']?.retry_after, 'a refusal sets a backoff')
  const third: string[][] = []
  await fillReadings(db, 't2', profile('de', ['Wir stellen SDRs ein']), 'sk-ant-scan', answer({ 'Wir stellen SDRs ein': 'HIRING: SDRs' }, third))
  assert.equal(third.length, 0, 'a wording inside its backoff is not paid for again')
})

test('#2084 control: two tenants never share readings', async () => {
  const db = new Database(':memory:'); migrate(db)
  seed(db, 'a', profile('de', ['Kaffee']))
  seed(db, 'b', profile('de', ['Kaffee']))
  await fillReadings(db, 'a', profile('de', ['Kaffee']), 'sk-ant-scan', answer({ Kaffee: 'HIRING: Barista' }))
  assert.equal(load(db, 'a')!.signal_readings?.Kaffee?.kind, 'hiring', 'tenant A is read')
  assert.equal(load(db, 'b')!.signal_readings, undefined, 'tenant B is untouched')
})
