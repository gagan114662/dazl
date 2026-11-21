// #1471: GET /api/plays as the real route (lib/workspace-plays.ts) answers for a stubbed jobs list with no watch or
// monitor: each own search sentence (a query; not a CSV import or a test fixture) is one play that ran once, named by its
// newest search, newest first. For browser tests that stub GET /api/scan/jobs and render Home's "Your plays".
export function oncePlaysAnswer(jobs) {
  const seen = new Map()
  for (const j of [...jobs].sort((x, y) => y.created_at - x.created_at)) {
    if (!j.query || !j.query.trim() || j.csv_domain || j.test_only) continue
    const s = j.query.trim(), p = seen.get(s)
    if (p) { p.runs.push(j.id); continue }
    seen.set(s, { key: `once-${j.id}`, kind: 'once', id: j.id, query: s, runs: [j.id], last_job_id: j.id, last_run_at: j.created_at, last_status: j.status })
  }
  return { plays: [...seen.values()], watches: [], monitors: [], emails: false }
}
