// #2084, after Ziggy's call on the PR: readings are not a profile-save call on the tenant's key, and never a platform-key side channel.
// They happen inside the scan, on the scan's own metered provider (the same key, spend cap and ledger as its other model calls), as ONE
// bounded call covering every uncompiled wording together, cached per wording text. A wording the call does not answer is labelled
// honestly ("this wording couldn't be turned into a search; try rewording it"), never dropped in silence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_WORDINGS, UNREAD_LABEL, parseReadings, readWordings } from '../lib/scan/signal-reading.ts'
import { withReadings } from '../lib/scan/signal-readings.ts'
import { normalizeIcp, type Icp } from '../lib/scan/icp.ts'
import { businessPlays, type BrainProfile } from '../lib/business-brain.ts'

const rd = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const icp = (lang: string, signals: string[]): Icp => normalizeIcp({
  summary: 'Dental practices in Ohio', who: ['Practice owner'], industries: ['dentistry'], sizes: [], where: ['Ohio'], signals, exclude: [], language: lang,
})!

// --- one bounded call, every wording at once ------------------------------------------------------------------------------------

test('#2084 all uncompiled wordings go in ONE call, numbered, and each answer is read back by its number', async () => {
  const prompts: string[] = []
  const read = async (prompt: string) => { prompts.push(prompt); return '1. HIRING: SDRs\n2. NOT_HIRING\n3. OTHER' }
  const got = await readWordings(['Wir stellen SDRs ein', 'keine Einstellungen', 'Kaffee'], 'de', read)
  assert.equal(prompts.length, 1, 'one call for three wordings')
  assert.match(prompts[0], /1\. Wir stellen SDRs ein/)
  assert.match(prompts[0], /3\. Kaffee/)
  assert.match(prompts[0], /one line per wording/i)
  assert.deepEqual(got['Wir stellen SDRs ein'], { kind: 'hiring', role: 'SDRs' })
  assert.deepEqual(got['keine Einstellungen'], { kind: 'not_hiring' })
  assert.equal(got.Kaffee, null, 'OTHER is no reading')
})

test('#2084 the call is bounded: at most MAX_WORDINGS wordings, and a missing answer is no reading, never a guess', async () => {
  const many = Array.from({ length: 20 }, (_, i) => `w${i}`)
  const got = await readWordings(many, 'de', async () => '1. HIRING: SDRs')
  assert.equal(Object.keys(got).length, MAX_WORDINGS)
  assert.deepEqual(got.w0, { kind: 'hiring', role: 'SDRs' })
  assert.equal(got.w1, null, 'an unanswered wording is null')
  assert.deepEqual(parseReadings('1. HIRING: SDRs\n2. NOT_HIRING', 3), [{ kind: 'hiring', role: 'SDRs' }, { kind: 'not_hiring' }, null])
})

// --- the save path is not where readings are paid for --------------------------------------------------------------------------

test('#2084 a profile save makes no paid call: no reader, no readings, and nothing labelled', async () => {
  const saved = await withReadings(icp('de', ['Wir stellen SDRs ein']), null)
  assert.equal(saved.signal_readings, undefined, 'nothing is read at save')
  assert.equal(saved.signal_unread, undefined, 'and nothing is labelled without an attempt')
})

test('#2084 the route no longer builds a reader: no key read, no guarded completion, no owner key at save', () => {
  const route = rd('../app/api/settings/profile/route.ts')
  assert.doesNotMatch(route, /readKeyStatus|fetchKey|ownerGuarded/, 'the save path makes no model call')
  assert.doesNotMatch(route, /withReadings\(icp, await reader/, 'no reader is built on save')
  assert.doesNotMatch(route, /operatorKey|DAZL_TRIAL_ANTHROPIC_KEY/, 'and no platform key anywhere in it')
})

test('#2084 the scan does the reading: the discover lane passes its own metered provider and key, one call for the run', () => {
  const runner = rd('../lib/scan/runner.ts')
  assert.match(runner, /fillReadings\(/, 'the lane fills readings')
  const lane = runner.slice(runner.indexOf('async function runDiscoverLane'))
  assert.match(lane, /fillReadings\(db, job\.user_id, profile, key, profileProvider/, 'on the scan’s key and the scan’s provider (guarded, metered, on the ledger)')
  assert.doesNotMatch(lane, /operatorKey\(\)[^\n]*reading/i, 'never the operator key for readings')
})

// --- a wording that could not be read is labelled, and never silently dropped ---------------------------------------------------

test('#2084 a refused or unanswered wording is kept with the honest label and makes no play', async () => {
  const read = async () => '1. HIRING: SDRs'
  const got = await withReadings(icp('de', ['Wir stellen SDRs ein', 'Wir haben eine Kaffeemaschine']), read)
  assert.deepEqual(got.signal_readings?.['Wir stellen SDRs ein'], { kind: 'hiring', role: 'SDRs', at: got.signal_readings!['Wir stellen SDRs ein'].at })
  assert.ok(got.signal_unread?.['Wir haben eine Kaffeemaschine'], 'the unanswered wording is recorded as unread')
  assert.equal(got.signal_unread!['Wir stellen SDRs ein'], undefined, 'the answered one is not')
  assert.match(UNREAD_LABEL, /couldn't be turned into a search/)
  assert.match(UNREAD_LABEL, /try rewording it/)
  // the unread wording still makes no play, and the read one does
  const readings = Object.fromEntries(Object.entries(got.signal_readings ?? {}).map(([k, v]) => [k, { kind: v.kind, role: v.role ?? null }]))
  const plays = businessPlays({ buyer: got } as BrainProfile, [], readings).map(p => p.query)
  assert.equal(plays.length, 1)
  assert.match(plays[0], /hiring SDRs/)
})

test('#2084 an over-cap or refused call labels every wording it could not read, and the scan is not failed by it', async () => {
  const got = await withReadings(icp('de', ['Wir stellen SDRs ein']), async () => { throw new Error('over_limit') })
  assert.equal(got.signal_readings, undefined)
  assert.ok(got.signal_unread?.['Wir stellen SDRs ein'], 'the wording is labelled, not dropped')
})

// --- the label survives a save and is shown where the plays are ----------------------------------------------------------------

test('#2084 normalizeIcp keeps the unread labels, bounded and keyed by the wording text', () => {
  const now = Math.floor(Date.now() / 1000)
  const raw = { summary: 'x', who: [], industries: [], sizes: [], where: [], signals: ['a'], exclude: [], language: 'de', signal_unread: { a: { at: now }, '': { at: now }, b: { at: 'nope' } } }
  const got = normalizeIcp(raw)!
  assert.deepEqual(Object.keys(got.signal_unread ?? {}), ['a'])
  const many = normalizeIcp({ ...raw, signal_unread: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`w${i}`, { at: now }])) })!
  assert.ok(Object.keys(many.signal_unread!).length <= MAX_WORDINGS)
})

test('#2084 the plays card says the wording could not be turned into a search', () => {
  const client = rd('../app/app/business/business-client.tsx')
  assert.match(client, /signal_unread/, 'the card reads the labels')
  assert.match(client, /UNREAD_LABEL/, 'and shows the one honest sentence')
})
