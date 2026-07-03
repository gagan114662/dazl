# dazl — Autonomous Go-To-Market Team (Marketing + Sales)

**Status:** Design (approved-in-progress)
**Date:** 2026-07-03
**Owner:** Gagan
**Repo:** extends `farzaa/clicky` (open-source Clicky)

---

## 1. One-line vision

dazl is an autonomous **go-to-market company** — a full team of AI marketing AND
sales employees that live on your Mac screen as individual interactive blobs, run
autonomously in the cloud for days and months, and grow **dazl.ai** for real:
strategy, content, SEO, creatives in every format, organic + paid distribution,
PR, email, community, growth launches, **and the full sales motion** — lead gen,
outbound, pipeline, CRM, closing, retention. It markets and sells itself:
dazl.ai's own GTM team runs dazl.ai's go-to-market.

## 2. What "good" looks like (success criteria)

1. **Installs and self-starts.** On install, the full team boots and begins real
   work with zero configuration. No "start each employee" step.
2. **Genuinely autonomous.** Employees keep working for days/months without the
   Mac being awake. Closing the laptop changes nothing.
3. **Real work, not fake.** Every "done" corresponds to a real artifact (a real
   tweet, a real published post, a real generated image/video, a real outbound
   email, a real CRM update) and real metrics.
4. **Whole funnel, not one channel.** Covers demand generation, demand capture,
   and sales — top to bottom of the funnel.
5. **Interactive per employee.** Any employee is a live blob you can drop into and
   talk to (voice or text), Clicky-style, and steer mid-task.
6. **Clicky-grade onboarding.** A warm, guided, voiced walkthrough that introduces
   the already-working team and unlocks capabilities as you connect accounts.
7. **Polished like Linear.** The on-screen experience and the dazl.ai web mirror
   feel like a finished product, not a demo.
8. **Award-grade, zero slop.** Output clears a taste bar: insight-driven, on-brand,
   original — never generic AI filler. Quality gates it, not volume. (See §2.5.)
9. **No API ceiling.** For anything without a clean API, employees operate a real
   browser like a human — so "all of GTM" isn't limited to what has an API. (See §7.2.6.)

## 2.5 The quality bar — insight quality & zero AI slop

The single biggest failure mode for an autonomous marketing team is confident,
generic **AI slop**: on-topic, competent-looking, and utterly forgettable. dazl's
defensibility is **taste**, not volume. Three mechanisms enforce it:

1. **A structured Brand Brain, not vibes.** All strategy and creative is grounded in
   a persistent brand model (§7.2.5) covering Product, User, Space (market & mind),
   Time, and User Experience — the holistic brand wheel — so insights come from a
   real model of dazl, its ICP, and its market, not from a blank prompt.
2. **Creative by cross-industry transfer, not templates.** Creatives are never "make
   a nice image." The method: find an **award-winning creative from a *different*
   industry**, extract its underlying concept/insight, and **transpose** it onto
   dazl. Borrowed brilliance beats generative averageness. (Full pipeline in §7.2-C.)
3. **An adversarial Taste gate on every artifact.** Before anything ships, a Critic
   scores it against a rubric — originality, insight depth, on-brand voice, and an
   explicit **anti-slop check** (clichés, hedge words, generic hooks, stock-photo
   energy, em-dash-and-emoji filler). Fails loop back to Draft. Volume is never an
   excuse to ship mediocrity.

## 3. Non-goals (v1)

- Multi-tenant SaaS with sign-up/billing for strangers. (dazl runs GTM for *you*
  first; productizing for others is a later North Star.)
- Actually spending money on ads / money-moving actions. (Guardrail: paid is
  *planned* only in v1, never executed with real budget.)
- Every channel/tool live at once. Channels and CRM connectors are adapters we
  add over phases, behind a stable interface.

---

## 4. Mental model — an AI GTM company

You run a company of **AI employees** organized into two departments under a
Coordinator. Each employee is:

- a **specialized role** (see the org chart, §5),
- a **living cloud process** (its own persistent memory, goal, and task state),
- an **on-screen blob** you can click into and interact with like a Clicky
  companion — its own conversation, its own session, independently steerable.

Employees are **config, not code** — you can hire/fire/add roles. The **Coordinator
(Head of Growth / CMO+VP Sales)** owns GTM strategy, sets goals, and dispatches
work across both departments, passing leads from Marketing to Sales.

---

## 5. The org chart (the full GTM surface)

Grouped by department. Each role maps to a granted subset of the capability layer
(§7.2). `[v1]` = default hire on install; others are one-click hires later — the
system is designed so *no aspect of GTM is conceptually missing*, only phased.

### Coordinator
- **Head of Growth `[v1]`** — GTM strategy, ICP/positioning, budget/guardrail owner,
  Marketing→Sales lead handoff, and owner of **Missions** (§6.5): decomposes big goals
  into parallel tracks across employees, monitors them as a unit, and re-plans as
  results land.

### Marketing department
- **Strategist `[v1]`** — market & competitor research, positioning, messaging, keywords.
- **Content/SEO Writer `[v1]`** — blog, long-form, technical + on-page SEO, landing copy.
- **Creative Director / Taste `[v1]`** — owns the quality bar: hunts award-winning
  cross-industry references, directs the concept, and runs the adversarial anti-slop
  Critique gate on every artifact (creative *and* copy) before it ships.
- **Designer `[v1]`** — executes creatives in **all formats** (images, ad creatives,
  memes/GIFs, short-form video, thumbnails, brand assets) via the cross-industry
  transfer pipeline (§7.2-C), against the brand kit.
- **Social/Distributor `[v1]`** — organic posting/replies + scheduling across channels.
- **Community** — Reddit/HN/Discord engagement, authentic participation.
- **Email/Lifecycle** — newsletters, drip & nurture sequences, segmentation.
- **Paid/Performance** — ad campaign + creative planning (Google/Meta/X/LinkedIn);
  audience/budget proposals. **Plans only, no spend in v1.**
- **PR/Partnerships** — journalist/podcast/influencer/partner outreach, guest posts.
- **Growth/Launches** — ProductHunt/HN launches, referral/viral loops, CRO & A/B tests.

### Sales department
- **SDR / Outbound `[v1]`** — intent-driven prospecting: sources leads from buying &
  social signals (§7.2-I), enriches & scores, runs coordinated personalized outreach
  across email + socials (no hand-built sequences), follows up, handles replies, books
  meetings. Autopilot or Review per autonomy level.
- **AE / Closer** — lead qualification, nurture, demo/meeting booking (calendar),
  proposals, objection handling, deal progression.
- **RevOps / CRM** — CRM hygiene, pipeline stages, lead scoring, routing, reporting.
- **Retention / Customer** — onboarding handoff, upsell/expansion, churn watch.

### Cross-cutting
- **Analyst `[v1]`** — full-funnel metrics, attribution, experiment readouts. Powers
  every employee's Observe step.

---

## 6. The core loop (the anti-fake-work guarantee)

Every employee runs a durable cycle, forever:

```
Plan      Claude (Opus) sets goal + next action, grounded in the Brand Brain (§7.2.5) & real metrics
Draft     produces the artifact (post, creative, outbound email) — creatives via the
          cross-industry transfer pipeline (§7.2-C)
Critique  an adversarial Taste gate scores it vs. the rubric (originality, insight depth,
          on-brand, zero-slop) and against its reference concept — REJECTS generic output,
          loops back to Draft until it clears
Act       ships the REAL artifact only after it clears the gate (+ human approval per autonomy level)
Observe   reads REAL results (impressions, clicks, replies, opens, pipeline) from real sources
Reflect   updates the Brand Brain + memory ("comparison posts convert; 9am threads win") → next Plan
```

An employee only "succeeds" when a real artifact clears the Taste gate, ships, and
real numbers return. No metrics = no learning = it knows it did nothing. Real *and*
non-slop by construction.

## 6.5 Missions & Campaigns — multi-employee autonomy over days (inspired by Factory "Missions")

Above the single-employee loop sits the **Mission**: a large GTM goal ("launch dazl
on Product Hunt," "run a 2-week intent-based outbound push") that the Head of Growth
decomposes into **parallel tracks across employees** and that runs for hours to days
as one coordinated unit — its own goal, plan, shared memory, budget, and a live group
status you watch. Factory's insight: real autonomy is *missions decomposed into
parallel tracks*, not one long chat. dazl treats every Campaign as a Mission —
durable, parallel, and re-planned by the Coordinator as results come in.

---

## 7. Architecture

Three layers over one cloud backend. Clicky's Cloudflare Worker seeds the backend;
Clicky's Swift app seeds the frontend.

### 7.1 Runtime — the durable spine (Cloudflare)

Grows `worker/` into a durable agent runtime. No always-on server to babysit.

| Primitive | Role |
|---|---|
| **Durable Object per employee** | The employee's living body: persistent memory, goal, tool + session state. Survives indefinitely. |
| **Cloudflare Workflows** | Runs the Plan→Act→Observe→Reflect loop as *durable execution*: sleeps for hours/days, wakes, auto-retries failed steps, never loses state across restarts. The "runs for months" engine. |
| **Cron Triggers** | Heartbeats: draft daily, send outbound batches, check metrics hourly, weekly strategy review. |
| **D1 (SQLite)** | Structured memory: employees, tasks, actions, artifacts, metrics, leads, deals, approvals, audit log. |
| **KV** | Fast config: brand kit, ICP, autonomy levels, guardrails. |
| **R2** | Generated creative assets (images, GIFs, video). |
| **Queues** | Employee-to-employee handoff (Strategist → Writer → Designer → Distributor; SDR → AE). |

### 7.2 Capability layer — all of marketing AND sales, real actions

Every tool is a real API call routed through the Worker (keys stay server-side,
as Clicky does today). Employees are granted subsets.

**A. Strategy & intelligence** — market/competitor research, ICP & positioning,
messaging, trend & keyword analysis, read own site + analytics.
**B. Content & SEO** — blog/long-form, technical + on-page SEO, link-building
outreach, landing-page copy, thought leadership.
**C. Creative — all formats, by cross-industry concept transfer.** Never "generate an
image." A directed pipeline for every creative (image, ad, meme/GIF, short video,
thumbnail, brand asset):
  1. **Reference-hunt** — pull *award-winning* work from a **different industry**
     (Cannes Lions, D&AD, One Show, Clio, Awwwards archives) that solves an analogous
     emotional/strategic job to dazl's.
  2. **Deconstruct** — extract the core concept, mechanism, and *why it won* — the
     idea, not the surface look.
  3. **Transpose** — adapt that concept onto dazl using the Brand Brain (§7.2.5), so it
     lands on dazl's actual differentiation and ICP.
  4. **Generate** — produce the asset in the target format against the brand kit
     (logo/palette/fonts); store in R2.
  5. **Critique** — the Taste gate checks originality vs. the source (not a rip-off,
     a transposition) and runs the anti-slop rubric before it can ship.
**D. Organic social & community** — X `[v1]`, then LinkedIn/Reddit/YouTube/IG/TikTok
(adapters); post/reply, community engagement, scheduling.
**E. Paid / performance (guardrailed)** — campaign + creative planning and
audience/budget proposals for Google/Meta/X/LinkedIn. **No spend in v1** — plans
only, approval-gated.
**F. Email & lifecycle** — newsletters, drip/nurture sequences, segmentation.
**G. Growth & launches** — ProductHunt/HN launch orchestration, referral loops,
CRO & A/B testing, waitlists.
**H. PR & partnerships** — journalist/podcast/influencer/partner outreach, guest
posts, co-marketing.
**I. Demand capture & lead gen — intent-driven (inspired by Gojiberry).** Not cold
list-scraping: detect **buying-intent & social signals** (15+ — e.g. competitor
engagement, funding rounds, new hires, job posts, community/group activity), filter
by ICP, enrich, score every prospect, and prioritize the *warm, in-market* ones
before any outreach — plus site lead capture. Quality of leads over volume.
**J. Outbound sales (SDR)** — cold email + cold DM/LinkedIn sequences, personalized
at scale, follow-up cadences, reply handling. Anti-spam guardrails enforced.
**K. Pipeline & closing (AE)** — CRM management, pipeline stages, nurture,
meeting/demo booking (calendar), proposals, objection handling, deal tracking.
**L. Revenue & retention** — onboarding handoff, upsell/expansion, churn watch,
customer marketing.
**M. Analytics & attribution (cross-cutting)** — full-funnel metrics, attribution,
experiment readouts, and **benchmarking against top performers in the category**;
powers every Observe step.
**N. Browser / web-action superpower** — for anything without a clean API, employees
drive a real cloud browser (§7.2.6) to act on any site like a human: log in, post,
DM, fill forms, engage, scrape gated content, operate web tools. This removes the
API-availability ceiling on §A–M.

All external / public / outbound actions pass the approval gate at each employee's
autonomy level; no-spend, rate-limit, and anti-spam guardrails enforced in the Worker.

### 7.2.5 The Brand Brain — the insight substrate (anti-slop)

A persistent, structured model of dazl that every employee reads and refines — the
antidote to generic output. Modeled on the holistic brand wheel: **Product** (needs,
differentiation, intrinsic benefits, variants), **User** (consumer / buyer /
influencer; psychographics), **Space** (in-market, on-shelf, in-the-mind, top-of-mind),
**Time** (consumption, purchase, receptive moments), and **User Experience**
(pre/post-purchase, lifecycle). Stored in D1/KV, seeded during onboarding and the
Strategist's first research pass, and updated by every Reflect step. Every Plan and
every creative Transpose step reads from it, so output is specific to dazl — never
interchangeable filler. The Brand Brain is what makes an insight *dazl's* insight.

### 7.2.6 Web-action superpower — real browser control (inspired by WebBrain)

APIs cover only part of GTM; the rest of the web (LinkedIn, Reddit, gated research,
niche tools, sites with no or expensive APIs) needs a **general browser agent**. dazl
employees drive a **real headless browser in the cloud** — Cloudflare Browser
Rendering (Playwright), so it stays on-platform and durable — to operate any website
like a human: navigate, click, type, fill forms, log in, post, DM, scrape.

Adopts WebBrain's proven safety model, which maps cleanly onto our approval gate (§9):
- **Ask vs. Act modes** — read-only analysis vs. consequential action.
- **Plan-before-act** — the employee shows its step plan; consequential steps hit the
  §9 approval gate before running; a stop control halts mid-run.
- **Bounded loops** — a max-step cap per task (à la WebBrain's step limit) to prevent
  runaway automation.
- **Credential vault + session persistence** — accounts are connected once during
  onboarding (progressive unlock); encrypted credentials + cookies live server-side
  (KV / Durable Object storage), so employees stay logged in across days/months
  without re-auth. Keys and sessions never touch the Mac client.

### 7.2.7 Skills system — extensible capabilities (inspired by WebBrain + Clicky)

Employee capabilities are an **extensible skills registry**, not a hardcoded list.
Each skill = a named, documented capability (an API tool, a browser routine, or a
composed workflow) an employee can be granted. New skills are added as config/data,
so the team grows new powers (a new channel, a new CRM, a new creative format)
without rewriting the runtime. This is how §7.2's surface expands over time — and how
you (or an employee) can teach the team something new.

### 7.3 Frontend — the blobs (Swift, extends Clicky)

- Reuse `OverlayWindow.swift` (non-activating full-screen overlay) → a **stack of
  employee blobs** on the screen edge, colored per role, with a live status dot,
  grouped by department.
- **Click a blob → enter that employee's session**: its live conversation, current
  task, recent artifacts. Talk by voice (reuse AssemblyAI push-to-talk) or text; it
  responds and adjusts, live.
- **Interrupt & inject context mid-run** — pause a working employee, add a note or
  redirect it, resume — the Factory-desktop pattern of monitoring sub-agents and
  injecting context *without* killing the Mission.
- **Completed task → the Image-2 card**: "Done ✓ + suggested next + follow-up
  (Text / Voice)."
- The Mac app is a **thin client**: renders employee state streamed from Cloudflare
  (SSE, like `/chat` today) and sends commands back. All real work happens in the
  cloud, so the laptop's state is irrelevant to autonomy.

### 7.4 dazl.ai (Next.js) — three jobs, one app

1. **Public marketing site** the team grows (living proof).
2. **Lead capture** surface (forms/CTAs) feeding the Sales department.
3. **Web mirror dashboard** — Linear-grade view to watch/steer employees and the
   pipeline when away from your Mac. Same backend as the blobs.

---

## 8. First-run experience — self-starting team + Clicky onboarding

**On install:**

1. The Coordinator provisions the default `[v1]` team.
2. Employees immediately begin the real work that needs **zero external setup**:
   Analyst reads dazl.ai, Strategist researches the market and drafts a plan,
   Writer produces first drafts, Designer generates creative concepts, SDR
   auto-reads dazl.ai to derive the ICP/pitch (Gojiberry-style zero-setup) and
   surfaces a first batch of intent-warm leads. Nothing is published/sent, so nothing
   needs approval — but it's all real output, and it seeds the Brand Brain.
3. The **onboarding walkthrough** runs *alongside*: not "configure each employee"
   but **"come meet your team — they're already working."** Uses Clicky's existing
   cursor-pointing (`[POINT:x,y]`) and voice to walk you through entering a blob,
   checking in, and approving the first public action.
4. **Progressive capability unlock**: the walkthrough surfaces the connections that
   unlock *more* (connect X, confirm brand kit, connect a mailbox/CRM) as first-class
   steps. Productive from second zero; more powerful as you plug things in.

---

## 9. Human-in-the-loop, autonomy & safety

- **Autonomy levels per employee**: `Propose → Approve → Full-auto`.
  **Default: Approve** — employees propose public/outbound actions; you one-tap
  approve/edit/reject from the blob. Graduate to Full-auto once trusted.
- **Approval gate**: anything public or outbound (tweet, published post, cold email,
  CRM-visible action) queues as a blob notification. Nothing external ships without
  passing the gate at its autonomy level.
- **Guardrails** (enforced in the Worker before any external call): brand-voice
  rules, banned-topics list, per-channel rate limits, anti-spam / cold-outreach
  volume caps, and a hard **no-paid-spend** cap in v1.
- **Full audit trail** in D1: every action, input, output, lead, deal, and metric —
  replayable in the timeline (blob session + web mirror).

---

## 10. Data model (D1, first cut)

- `employees` — id, dept, role, color, autonomy_level, system_prompt,
  granted_tools[], schedule, status.
- `tasks` — id, employee_id, goal, state, parent_task_id, created/updated.
- `actions` — id, task_id, tool, input, output, idempotency_key, status, ts.
- `artifacts` — id, task_id, type (post/image/video/thread/email/ad/proposal),
  r2_key or url, published_url, ts.
- `metrics` — id, artifact_id, source, metric, value, ts.
- `leads` — id, source, contact, ICP_score, stage, owner_employee_id, ts.
- `deals` — id, lead_id, stage, value, next_action, status, ts.
- `approvals` — id, action_id, state, decided_by, ts.
- `memory` — id, employee_id, kind (fact/lesson/preference), content, ts.
- `audit_log` — append-only mirror for replay.

---

## 11. Durability & correctness

- **Checkpointing**: Workflows checkpoint every step → a crash resumes mid-task.
- **Idempotency keys** on every external action → retries never double-post/-send.
- **At-most-once send/publish**: tools check `actions.idempotency_key` before shipping.
- **Backpressure**: Queues + per-channel rate + outreach caps prevent runaway sending.

---

## 12. Testing — how we prove it's real

- **`dryRun` mode** on every tool: returns the exact artifact/email it *would* ship
  without shipping. Used in CI and the first days of any new employee.
- **Staging brand**: throwaway X handle + preview dazl.ai + a sandbox mailbox/CRM —
  run a full autonomous week end-to-end and watch before pointing at real accounts.
- **Golden-path integration tests** on the loop (Plan→Act→Observe→Reflect with
  mocked tools returning fixture metrics/leads).
- **Proof of life = the product**: the timeline + real metrics/pipeline are the
  harness. You can always open the actual tweet, post, email, lead, and number.

---

## 13. Build sequencing (each phase independently alive)

1. **Runtime spine** — Worker → Durable Objects + Workflows + Cron + D1/KV/R2 +
   Queues. One trivial durable employee that survives restarts and a multi-day sleep.
   *Proof: an employee wakes on cron, does a real research step, persists memory.*
2. **One real marketing employee, end-to-end** — the Writer: research → draft →
   dryRun → approval → publish a real post to staging dazl.ai, read real metrics,
   reflect. *Proof: a real published post + real numbers + a learned lesson.*
3. **The blob frontend + onboarding** — Swift overlay blobs, click-in interactive
   sessions, Image-2 completion card, self-start-on-install, Clicky walkthrough.
   *Proof: install → team boots → you talk to the Writer blob live.*
4. **Full Marketing dept + all creative formats** — Strategist, Designer (all
   formats), Social/Distributor, Analyst, Coordinator dispatch; dazl.ai site + mirror.
   *Proof: a full autonomous marketing week on staging, then the real brand.*
5. **Sales dept, end-to-end** — SDR (prospect → sequence → dryRun → approval → real
   outbound), then AE + RevOps/CRM + lead capture on dazl.ai; Marketing→Sales handoff.
   *Proof: a real lead sourced, a real outbound email sent, a real CRM pipeline moving.*
6. **Depth hires** — Community, Email/Lifecycle, Paid (planning), PR/Partnerships,
   Growth/Launches, Retention — added as config against the existing runtime.

The **web-action layer + skills registry (§7.2.6–7.2.7)** are built alongside Phase 2
(the first employee that needs a no-API action) and hardened in Phase 5, since
outbound sales leans heavily on browser automation.

We build the whole GTM org. Nothing is faked; each phase ships something that runs.

---

## 14. Open questions / risks

- **X + LinkedIn + email/CRM API access & cost/ToS** — tiers needed; outbound is
  approval-gated and volume-capped to stay compliant and non-spammy.
- **Cold-outreach compliance** — CAN-SPAM/GDPR-aware sending, opt-outs, sane volume.
  *(Design into Phase 5.)*
- **Intent-signal data sources** — which providers/signals (competitor engagement,
  funding, hiring, social); some need paid data or scraping via the web-action layer.
  *(Decide in Phase 5.)*
- **Creative-generation model choice** — image/video APIs; brand consistency
  (reference images / templating). *(Decide in Phase 4.)*
- **dazl.ai publish + lead-capture mechanism** — git-commit MDX vs headless CMS;
  form/CRM wiring. *(Decide in Phases 2 & 5.)*
- **Cost ceiling** — Claude + creative-gen over months; needs budget caps and a
  cheap-model tier for routine steps.
- **Browser-automation ToS & bot detection** — logging into X/LinkedIn/etc. via a
  cloud browser risks account flags; needs human-like pacing, persistent sessions,
  egress/IP consideration, and per-site opt-in. *(Design into the web-action layer.)*
- **Credential security** — encrypted vault, least-privilege, revocable sessions;
  credentials and cookies stay server-side, never on the client.
- **Cloudflare Workflows + Browser Rendering limits** — max step duration / sleep
  windows / browser-session limits vs our cadence. *(Validate in Phase 1.)*

---

## 15. Defaults carried (editable)

- **v1 team on install:** Head of Growth, Strategist, Content/SEO Writer, Designer,
  Social/Distributor, SDR/Outbound, Analyst. Rest are one-click hires.
- **Autonomy:** Approve mode, graduating to Full-auto per employee.
- **v1 channels:** X (organic) + one outbound email channel; adapters for the rest.
- **No paid spend** in v1 (paid is planned, never executed).
