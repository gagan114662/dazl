// Follow-ups from Hermes-PC's reviews of #1144 and #1141.
// (1) #1144: the verifier (runner.ts) and the evidence recheck (evidence-recheck.ts) each kept their own copy of the date
//     rejections (DATE_REJECTS); a new date reason added to one would split them again. Now one set, in evidence.ts.
// (2) #1141: a careers vacancy offered with no quote (the posting never states the role) wrote an evidence label ending
//     in a dangling "; " (sales-hiring-gate.ts). Labels are now joined from their non-empty parts.
// Namespace imports, so each test fails on its own assertion (not at import) against the code before this change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as evidence from '../lib/scan/evidence.ts'
import * as gate from '../lib/scan/sales-hiring-gate.ts'

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../lib/scan/${p}`, import.meta.url)), 'utf8')
const page = { text: 'Acme raised a seed round to grow its sales team.', title: 'Acme news', retrievedAt: Math.floor(Date.parse('2026-11-13T12:00:00Z') / 1000) }
const cand = (event_date: string) => ({ name: '', company: 'Acme', contact: null, signal: 'Raised a seed round', source_url: 'https://acme.example/news', excerpt: 'Acme raised a seed round to grow its sales team.', event_date, score: 80 }) as never

test('#1144 follow-up: one DATE_REJECTS set, exported by evidence.ts, holds every reason verifyEvidence gives a day that fails the date rules', () => {
  const set = (evidence as { DATE_REJECTS?: ReadonlySet<string> }).DATE_REJECTS
  assert.ok(set, 'evidence.ts exports DATE_REJECTS')
  const now = new Date('2026-11-13T12:00:00Z')
  for (const [day, why] of [['2026-13-45', 'malformed'], ['2019-01-01', 'too old'], ['2027-06-01', 'in the future']] as const) {
    const v = evidence.verifyEvidence(cand(day), page as never, now)
    assert.equal(v.ok, false, `${day} (${why}) is rejected`)
    assert.ok(set!.has((v as { reason: string }).reason), `${day} (${why}): reason ${(v as { reason: string }).reason} is a DATE_REJECTS reason`)
  }
  assert.deepEqual([...set!].sort(), ['bad_date', 'future_date', 'stale'])
})

test('#1144 follow-up: no file under lib/scan except evidence.ts lists the date-rejection reasons itself (any literal copy, not only `new Set([`)', () => {
  const dir = fileURLToPath(new URL('../lib/scan/', import.meta.url))
  for (const f of readdirSync(dir).filter(f => f.endsWith('.ts') && f !== 'evidence.ts')) {
    const s = readFileSync(dir + f, 'utf8')
    // an array or set literal naming 'bad_date' with 'stale' or 'future_date' is a copy of the set (review on #1148: runner.ts:439 had
    // `['bad_date', 'stale', 'future_date'].includes(...)`); a TypeScript union of reason names (scoreboard.ts) is a different list
    assert.doesNotMatch(s, /\[[^\]\n]*'bad_date'[^\]\n]*'(?:stale|future_date)'[^\]\n]*\]|\[[^\]\n]*'(?:stale|future_date)'[^\]\n]*'bad_date'[^\]\n]*\]/, `${f} keeps no copy of the date rejections`)
  }
  for (const f of ['runner.ts', 'evidence-recheck.ts']) assert.match(src(f), /import \{[^}]*\bDATE_REJECTS\b[^}]*\} from '\.\/evidence\.ts'/, `${f} imports the shared set`)
})

test('#1141 follow-up: a careers evidence label never ends in a dangling "; " when the vacancy has no quote', () => {
  const label = (gate as { evidenceLabel?: (...p: (string | null | undefined | false)[]) => string }).evidenceLabel
  assert.ok(label, 'sales-hiring-gate.ts exports evidenceLabel')
  const dateLabel = 'Greenhouse first-published date read from the linked posting'
  assert.equal(label!('Requested role: Account Executive', dateLabel, ''), 'Requested role: Account Executive; Greenhouse first-published date read from the linked posting')
  assert.equal(label!(dateLabel, ''), 'Greenhouse first-published date read from the linked posting')
  assert.equal(label!('', ''), '')
  assert.equal(label!('generic hiring - no requested-role match in the sampled roles', '', 'We are hiring an AE.'), 'generic hiring - no requested-role match in the sampled roles; We are hiring an AE.')
  assert.equal(label!('Long-open: first published 2026-01-01', false, ''), 'Long-open: first published 2026-01-01')
  // the quote is stored exactly as offered (review on #1148): a trailing ";" or edge spaces in the quote are not touched
  assert.equal(label!(dateLabel, 'We hire;'), 'Greenhouse first-published date read from the linked posting; We hire;')
  assert.equal(label!('Requested role: AE', dateLabel, ' We hire '), 'Requested role: AE; Greenhouse first-published date read from the linked posting;  We hire ')
  // and every careers label in the gate is built with it (no template ending in "; ${v.quote}")
  assert.doesNotMatch(src('sales-hiring-gate.ts'), /; \$\{(?:dateLabel\}\$\{)?v\.quote\}`/)
})

// Review (Hermes-PC) on #1148: behavioural proof that the verifier's main rejection branch uses the shared set. Every DATE_REJECTS
// reason a claimed day gets from verifyEvidence ends in review as event_date_<reason> through verifyLeads (not dropped).
test('#1148: every DATE_REJECTS reason sends the lead to review as event_date_<reason> through verifyLeads', async () => {
  const { verifyLeads } = await import('../lib/scan/runner.ts')
  const now = new Date('2026-11-13T12:00:00Z')
  const text = 'Acme raised a seed round to grow its sales team.'
  const read = async () => ({ text, title: 'Acme news', retrievedAt: Math.floor(now.getTime() / 1000), structured: [] })
  const draft = (event_date: string) => ({ name: '', company: 'Acme', contact: null, signal: 'Raised a seed round', source_url: 'https://acme.example/news', excerpt: text, event_date, score: 80 })
  const seen: string[] = []
  for (const [day, reason] of [['2026-13-45', 'bad_date'], ['2019-01-01', 'stale'], ['2027-06-01', 'future_date']] as const) {
    assert.ok(evidence.DATE_REJECTS.has(reason))
    const o = await verifyLeads([draft(day) as never], read as never, now)
    assert.deepEqual(o.leads.length, 0, `${day}: not verified`)
    assert.deepEqual(o.review.map(r => r.review_reason), [`event_date_${reason}`], `${day}: held for review as event_date_${reason}`)
    seen.push(reason)
  }
  assert.deepEqual(seen.sort(), [...evidence.DATE_REJECTS].sort(), 'every reason in the shared set is exercised')
})
