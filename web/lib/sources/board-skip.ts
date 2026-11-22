// #1205: the status the runner records for a job-board source it did not select automatically, before any collection (runner.ts).
// chosen = the adapters the person picked (null when they picked none). A selection that includes the job boards is not a skip: the
// source is 'started', its own run then records what happened, and a collection that never finishes leaves it as 'error'
// (source-runs.ts), never without a row. Every skip status this returns has a plain reason in lib/scan/progress.ts skipNote.
import { placeSkipReason } from './jobboards.ts'

export function boardStatusBeforeRun(o: { chosen: readonly string[] | null; hiring: boolean; query: string; where: readonly unknown[] }): string {
  if (o.chosen) return o.chosen.includes('jobboards') ? 'started' : 'skipped_explicit_sources'
  if (!o.hiring) return 'skipped_no_hiring_signal'
  return placeSkipReason(o.query, o.where)
}
