// #1205: the status the runner records for a job-board source it did not select automatically (runner.ts). chosen = the adapters the
// person picked (null when they picked none). A selection that includes the job boards is not a skip: the board's own run records what
// happened. Every status this returns has a plain reason in lib/scan/progress.ts skipNote (the progress row and the saved run report).
import { placeSkipReason } from './jobboards.ts'

export function boardSkipStatus(o: { chosen: readonly string[] | null; hiring: boolean; query: string; where: readonly unknown[] }): string | null {
  if (o.chosen) return o.chosen.includes('jobboards') ? null : 'skipped_explicit_sources'
  if (!o.hiring) return 'skipped_no_hiring_signal'
  return placeSkipReason(o.query, o.where)
}
