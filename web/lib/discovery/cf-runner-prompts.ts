// cf_runner company-first prototype: the discover wording dazl's scan already runs (lib/scan/runner.ts, ported in #1458/#1464/#1472).
// Shared, unchanged, by the scan's company-first angles and the discovery agent loop (lib/discovery/agent-loop.ts), so both ask the
// model in the same words. Pure strings; no logic.

// cf_runner discover wording (run6: 10/10 past every hold): for a hiring request every angle prefers the public ATS boards whose
// records dazl reads and dates.
export const CF_BOARD_PREFERENCE = 'Strongly prefer postings hosted on boards.greenhouse.io / job-boards.greenhouse.io, jobs.lever.co or jobs.ashbyhq.com (their freshness can be verified). Prefer postings from the last 30 days; skip anything that looks older.'

// cf_runner stage 1 ANGLES, verbatim (the three that cite boards whose records dazl reads and dates, in cf_runner order).
export const CF_RUNNER_HIRING_ANGLES = [
  'Search company career pages and public applicant-tracking job boards (e.g. boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, apply.workable.com) for open postings that match the signal.',
  'Search jobs.ashbyhq.com and jobs.lever.co specifically for the role titles in the signal, newest first.',
  'Search boards.greenhouse.io and job-boards.greenhouse.io specifically for the role titles in the signal, newest first.',
]

// cf_runner discover() rules: only companies the search found evidence for, no staffing agencies, sizes as asked.
export const CF_RUNNER_RULES = 'Rules: only companies you found evidence for in search results this session; never invent. Exclude staffing/recruiting agencies posting for clients. Company size matters: respect the company sizes in the request; skip well-known large companies and public companies.'
