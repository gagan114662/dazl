// #1102 the grounded named-person step of a scan (lib/people/grounded-people.ts): one lookup per lead that still names nobody,
// ready leads first, never for a lead the crawl already named or a hold that puts the company in doubt; a person is stored only when
// the lookup keeps one, with its source. TEST-ONLY fixtures: invented companies and people; TinyFish and the model are stubbed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addEnrichment } from '../lib/connectors/store.ts'
import { findGroundedPeople, GROUNDED_CONNECTOR, newGroundedStats } from '../lib/people/grounded-people.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import { CONTACT_RESEARCH_MODEL } from '../lib/people/contact-research.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { setup, env, HELD_WHO, type Row } from './helpers/people-held-fixture.ts'

const ROWS: Row[] = [
  ['L-a', 'Pagewake', null, 90],               // ready, names nobody: looked up
  ['L-b', 'Meshgate', null, 80],               // ready, the crawl already named its Head of Sales: no lookup
  ['L-c', 'Surveyhive', 'place_mismatch', 70], // held with the company in doubt: no lookup
]
const TEAM = { url: 'https://pagewake.example/team', title: 'Our team | Pagewake', snippet: 'Dana Okoye, Head of Sales at Pagewake in Chicago, Illinois, leads our revenue team.' }
function harness(answer: unknown) {
  const calls = { searched: [] as string[], prompts: 0 }
  const fetchImpl = (async (u: string) => { calls.searched.push(/"([^"]+)"/.exec(new URL(String(u)).searchParams.get('query') ?? '')?.[1] ?? ''); return new Response(JSON.stringify({ results: [TEAM] })) }) as unknown as typeof fetch
  const provider: Provider = { research: async () => { throw new Error('never') }, configuredModel: () => CONTACT_RESEARCH_MODEL, completeDetailed: async () => { calls.prompts++; return { text: JSON.stringify(answer), model: CONTACT_RESEARCH_MODEL, usage: { input_tokens: 1500, output_tokens: 120 } } } }
  return { calls, opts: { provider, apiKey: 'sk-test', env, fetchImpl } }
}
const personRows = (db: ReturnType<typeof setup>['db'], id: string) => db.prepare("SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND kind = 'person'").all(id) as { connector: string; kind: string; value: string; label: string; source_url: string }[]

test('#1102 a lead that names nobody gets one grounded lookup and the kept person is stored with its source; named and in-doubt leads get none', async () => {
  const { db, job } = setup(ROWS)
  addEnrichment(db, 'A', 'L-b', { connector: 'sitecrawl', kind: 'person', value: 'Lee Park, Head of Sales', label: 'company site', confidence: null, source_url: 'https://meshgate.example/team', source_date: '2026-11-14', retrieved_at: 1 })
  const h = harness({ person: { name: 'Dana Okoye', title: 'Head of Sales', source: 'S1', quote: 'Dana Okoye, Head of Sales at Pagewake', linkedin_source: null } })
  const stats = newGroundedStats()
  const n = await findGroundedPeople(db, 'A', job, { ...h.opts, stats })
  assert.equal(n, 1); assert.equal(h.calls.prompts, 1, 'one model call, for Pagewake only')
  assert.deepEqual([...new Set(h.calls.searched.filter(Boolean))], ['Pagewake'], 'no search for the named lead or the in-doubt hold')
  assert.deepEqual(stats, { eligible: 1, looked_up: 1, found: 1, none: 0, refused: {}, failed: {} })
  const rows = personRows(db, 'L-a')
  assert.equal(rows.length, 1); assert.equal(rows[0].connector, GROUNDED_CONNECTOR); assert.equal(rows[0].value, 'Dana Okoye, Head of Sales'); assert.equal(rows[0].source_url, TEAM.url)
  const p = leadPerson(db.prepare("SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = 'L-a' AND kind IN ('person','contact')").all(), HELD_WHO.join('; '))
  assert.equal(p?.name, 'Dana Okoye', 'the lead now names its person')
  assert.equal(personRows(db, 'L-c').length, 0)
})

test('#1102 a person the sources do not support is not stored (the model named someone the result never mentions)', async () => {
  const { db, job } = setup(ROWS)
  const h = harness({ person: { name: 'Riley Quinn', title: 'Head of Sales', source: 'S1', quote: 'Riley Quinn, Head of Sales at Pagewake', linkedin_source: null } })
  const stats = newGroundedStats()
  assert.equal(await findGroundedPeople(db, 'A', job, { ...h.opts, stats }), 0)
  assert.equal(personRows(db, 'L-a').length, 0); assert.equal(stats.found, 0); assert.equal(stats.looked_up, 2, 'both ready leads name nobody here'); assert.equal(Object.values(stats.refused).reduce((a, b) => a + b, 0), 2, 'each refused in code, with a reason')
})

test('#1102 a job of another tenant is never read, and a lost job writes nothing', async () => {
  const { db, job } = setup(ROWS)
  const h = harness({ person: { name: 'Dana Okoye', title: 'Head of Sales', source: 'S1', quote: 'Dana Okoye, Head of Sales at Pagewake', linkedin_source: null } })
  assert.equal(await findGroundedPeople(db, 'B', job, h.opts), 0); assert.equal(h.calls.prompts, 0)
  assert.equal(await findGroundedPeople(db, 'A', job, { ...h.opts, alive: () => false }), 0); assert.equal(personRows(db, 'L-a').length, 0)
})
