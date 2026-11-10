// Publish a live or recorded batch (and optionally its repeated-run analysis) to the scorecard page (#398).
//   node --experimental-strip-types scripts/publish-scorecard.mts --batch batch-XXXX.json [--superiority sup.json]
// It writes lib/benchmark/published/latest.json. It REFUSES a synthetic batch (that origin is only ever the labelled example), a batch whose
// evaluator is not independent, and an analysis that is synthetic or names a batch that is not the one being published. Nothing is called.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BatchResult } from '../lib/benchmark/runner.ts'
import type { Superiority } from '../lib/benchmark/superiority.ts'
import { distinctBatches, type Published } from '../lib/benchmark/published.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const die = (m: string): never => { console.error(`publish-scorecard: ${m}`); process.exit(2) }
const read = <T,>(f: string): T => { try { return JSON.parse(readFileSync(f, 'utf8')) as T } catch (e) { return die(`cannot read ${f}: ${(e as Error).message}`) } }

export function toPublished(batch: BatchResult, sup: Superiority | null, now: string): Published {
  const m = batch.manifest
  if (m.origin !== 'live' && m.origin !== 'recorded') throw new Error(`origin ${m.origin} cannot be published: only a live or recorded batch can`)
  if (!m.evaluator.independent) throw new Error('the evaluator is not independent of the systems under test')
  if (sup) {
    if (sup.origin === 'synthetic') throw new Error('the analysis is synthetic')
    if (!Array.isArray(sup.batches) || !sup.batches.every((b: unknown) => typeof b === 'string')) throw new Error('the analysis batches must be a list of batch ids')
    if (!sup.batches.includes(m.batch_id)) throw new Error(`the analysis does not include batch ${m.batch_id}`)
    if ((sup.overall.decision === 'win' || sup.overall.decision === 'loss') && distinctBatches(sup.batches) < 2) throw new Error(`a win or a loss needs at least 2 distinct batches; the analysis has ${distinctBatches(sup.batches)}`)
  }
  return {
    format: 'dazl-published-scorecard', version: 1, generated_at: now,
    batch: {
      manifest: { batch_id: m.batch_id, task_set_version: m.task_set_version, as_of: m.as_of, origin: m.origin, label: m.label, budget: m.budget, systems: m.systems.map(s => ({ system: s.system, origin: s.origin, available: s.available })) },
      evaluator: { name: m.evaluator.name, version: m.evaluator.version, independent: m.evaluator.independent },
      report: batch.report, spent_usd: batch.spent_usd,
    },
    superiority: sup,
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const bf = arg('--batch') ?? die('--batch BATCH.json is required')
  const sf = arg('--superiority')
  let out: Published
  try { out = toPublished(read<BatchResult>(bf), sf ? read<Superiority>(sf) : null, new Date().toISOString().slice(0, 10)) } catch (e) { out = die((e as Error).message) }
  const file = path.resolve(import.meta.dirname, '..', 'lib', 'benchmark', 'published', 'latest.json')
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
  console.log(`published ${out.batch!.manifest.batch_id} (${out.batch!.manifest.origin}) to ${file}`)
}
