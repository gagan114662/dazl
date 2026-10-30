// #349 fail closed: a page shows a play's offer only from a well-formed /api/campaigns/[id] reply
// (lib/play-offer-reply.ts). Every malformed reply is 'unreadable' (the card says it could not be loaded), never
// "no offer" (null) and never a half-empty offer or choice. Pure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { offerFromReply } from '../lib/play-offer-reply.ts'

const MALFORMED: [string, unknown][] = [
  ['no reply (network or 5xx)', null],
  ['an empty object', {}],
  ['an error body', { error: 'Not found' }],
  ['offer is an empty object', { offer: {} }],
  ['offer is a string', { offer: 'CRM setup' }],
  ['offer is an array', { offer: [] }],
  ['a shown offer with empty text', { offer: { offer: ' ', source: 'play', conflict: null } }],
  ['an unknown source', { offer: { offer: 'CRM setup', source: 'guess', conflict: null } }],
  ['a conflict with no details', { offer: { offer: null, source: 'conflict', conflict: null } }],
  ['a conflict with no recorded offer', { offer: { offer: null, source: 'conflict', conflict: { stated: 'CRM setup', recorded: '' } } }],
  ['a withdrawal with nothing withdrawn', { offer: { offer: null, source: 'conflict', conflict: { stated: null, recorded: 'Dental software' } } }],
  ['a conflict that also claims an offer', { offer: { offer: 'CRM setup', source: 'conflict', conflict: { stated: 'CRM setup', recorded: 'Dental software' } } }],
  ['an offer that also carries a conflict', { offer: { offer: 'CRM setup', source: 'play', conflict: { stated: 'x', recorded: 'y' } } }],
]
// Controls: the route's real shapes (test/helpers/play-offer-route-runtime.mts) pass through unchanged.
const WELL_FORMED: unknown[] = [
  { offer: 'CRM setup', source: 'play', conflict: null },
  { offer: 'Dental software', source: 'recorded', conflict: null },
  { offer: null, source: 'conflict', conflict: { stated: 'CRM setup', recorded: 'Dental software' } },
  { offer: null, source: 'conflict', conflict: { stated: null, recorded: 'Dental software', withdrawn: 'Dental software' } },
  { offer: null, source: 'none', conflict: null },
]

test(`#349 a malformed campaign reply is unreadable, never "no offer" (${MALFORMED.length} variants)`, () => {
  for (const [name, reply] of MALFORMED) assert.equal(offerFromReply(reply), 'unreadable', name)
})
test('#349 the route\'s real replies pass through; an explicit null offer is "none"', () => {
  for (const o of WELL_FORMED) assert.deepEqual(offerFromReply({ job: {}, offer: o }), o)
  assert.equal(offerFromReply({ offer: null }), null)
})
// The rule, not the string: no page reads a campaign reply's offer by hand.
test('#349 every page reads a play\'s offer through offerFromReply', () => {
  const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/app')
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.tsx')) files.push(p) } }
  walk(app)
  const offenders = files.flatMap(f => readFileSync(f, 'utf8').split('\n').map((l, i) => [l, i] as const)
    .filter(([l]) => /'offer' in\b|\.offer \?\? null|j\??\.offer as PlayOffer/.test(l)).map(([, i]) => `${path.relative(app, f)}:${i + 1}`))
  assert.deepEqual(offenders, [])
  const users = files.filter(f => /offerFromReply\(/.test(readFileSync(f, 'utf8'))).map(f => path.relative(app, f)).sort()
  assert.deepEqual(users, ['campaigns/[id]/campaign-view.tsx', 'journey.tsx', 'outreach/outreach-client.tsx', 'play-offer.tsx'])
})
