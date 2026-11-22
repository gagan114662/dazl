# dazl launch brief (owner: Gagan, 2026-11-22 12:41pm ET)

**This brief overrides CLAUDE.md, AGENTS.md, docs/, the issue queue and every earlier decision it contradicts** (including strict holds, the 3/hr LinkedIn caps, throwaway-account-only LinkedIn, and closed issues as the progress metric).

## Why
144 commits in 4 days, 25 on #1122, 0 ready leads. Most fixes are one-company fixes. The only measure of progress is how many good leads a real request returns.

## Goal
For any reasonable B2B request ("[service] companies in [place] showing [signal]" or "people engaging with [competitor]'s posts"), return at least 5 leads. Each lead has:
- a real company + domain,
- a dated intent signal with its proving URL (or a LinkedIn activity link),
- a named decision-maker with title + LinkedIn where findable,
- a confidence label.

The only paid API is Claude. LinkedIn comes from each customer's own account. Beat Gojiberry/Pancake on the same prompts.

## Step 1: Benchmark first (no product changes until it exists)
- `bench/prompts.json` with 16 prompts:
  - 12 open-web prompts covering 5+ countries and 3+ non-tech industries (e.g. dental clinics Toronto, roofers Pune, law firms Dubai, SaaS hiring SDRs Austin), with hiring / funding / new-leadership / expansion signals.
  - 4 LinkedIn prompts (e.g. people engaging with [competitor] posts; new Heads of Sales at 20–200 person SaaS).
- `bench/run.ts` runs the REAL prod scan path (no QA modes) and outputs:
  `prompt | candidates | leads shown | % domain | % named person | % dated evidence URL | cost USD | time s`
- Commit a baseline now.
- Every PR posts a before/after benchmark table. A PR that doesn't improve or protect the number doesn't merge.
- Gagan runs the same prompts on Gojiberry/Pancake.

## Step 2: Discovery is one Claude agent loop
- One Claude agent loop using web_search + web_fetch, returning typed JSON:
  `{company, domain, signal, signal_date, evidence_url, person, title, person_source_url, linkedin_url, confidence}`.
- Claude reads the request into a structured plan. No regexes, no hand-typed place or industry lists (#1395, #1394).
- Start from the cf_runner company-first prototype and extend it; stop porting it stage by stage.
- Job boards, registries and permits are optional enrichers and never decide keep/drop.
- Delete the second, switched-off engine and the fake "Claude-only" mode (#1393, #1392).

## Step 3: Show, don't hide
- A lead is shown if it has a real company + a dated signal with an evidence URL (or a LinkedIn activity link).
- A missing person, email or domain lowers confidence and never hides the lead; the card says plainly what's missing.
- Measure each hold/drop rule against the benchmark; delete the ones that hide more good leads than bad, and show the before/after table.
- Emails: own-domain published only; otherwise show "no published email" and still show the lead.

## Step 4: LinkedIn from the customer's own account
(Overrides the 11-06/09 decision in docs/linkedin-people-source.md.)
1. Remove LINKEDIN_SESSION_TENANTS / the multiple_tenants refusal / LINKEDIN_SESSION_ACCOUNT. Replace the 7 flags with one condition: the workspace has connected LinkedIn and accepted the risk notice.
2. LinkedIn reads run in the extension, in the user's browser on their IP, at human pace. The server only queues and receives. Stop server cookie replay.
3. Replace the 3/hr and 2/scan caps with a daily per-account budget at human pace (propose the number with a reason). On a challenge/429/999, pause the account for 24h. Add a Settings pause button.
4. LinkedIn signals are first-class: engagement with competitor/category posts, job changes into buyer roles, hiring/buying/evaluating posts. Claude judges intent. A dated LinkedIn signal + profile URL counts as a ready lead, not "review" just because of login.
5. LinkedIn gives person + intent; Claude web research fills in company, domain, funding, hiring and published email.
6. The connect screen shows a plain risk notice.
7. Publish dazl Connect to the Chrome Web Store. Onboarding: install, connect, run first play.
8. Before building further: prove extension + session worker end to end on one real connected account and report what broke.

## Step 5: Only this infra
No Postgres cutover / ECS / load tests / multi-AZ; stay on EC2 + SQLite.
1. Backups today: S3 off-host per ops/backup/INSTALL.md plus one restore drill with proof (#1080).
2. Alerts: SENTRY_DSN or OPS_ALERT_WEBHOOK_URL plus an external uptime check (#1088).
3. Workspace isolation test: every API route called with another workspace's IDs must fail; LinkedIn sessions encrypted per workspace.
4. Fix the #1463 hang.

Revisit scale only when queue wait > 2 min or memory > 80%.

## Rules
- BANNED: fixes naming a specific company/city/province/country/job title (change the prompt/schema instead).
- BANNED: QA-only paths/fixtures/test modes in prod builds (#1398).
- BANNED: PRs without a benchmark table, unless Step 5 only.
- Small PRs, each one moving the benchmark or a Step 5 item. No follow-up-of-follow-up PRs.
- The no-cheating rule still applies. Merge-line and gate discipline stay.
- This brief beats CLAUDE.md / AGENTS.md / docs.

## Scope freeze
Only: #1122, #1037, #1392, #1393, #1395, #1394, #1400, #1398, #1463, #1080, #1088, plus the LinkedIn and benchmark work. Everything else is labelled after-launch and not touched (session expiry, ownership enforcement, reply reading, registry adapters, cost-panel polish, RLS/Postgres #1092). The Common Crawl ATS index and JobSpy stop unless reframed as optional enrichers that move the benchmark.

## Done = launch
- ≥5 shown leads on ≥13 of 16 prompts.
- ≥70% of shown leads with a named person; 100% with a dated evidence URL or LinkedIn link.
- Cost per prompt under **$1** (set by Gagan, 2026-11-22).
- Gagan spot-checks 20 random leads and ≥16 are real.
- Beats Gojiberry/Pancake on leads shown and % named person.
- A new user can sign up → install extension → connect LinkedIn → get leads with no dead ends (#1095).
- Backups proven, alerts live, isolation test passing, #1463 fixed.

## Daily report to Gagan
One short message: the benchmark table today vs yesterday, what changed and why it moved, and blockers only she can decide.
