# Outcome-based autonomous pilots (#399)

`web/lib/pilots/pilot.ts` is the engine for an opt-in customer experiment. It runs **without per-message approval**,
strictly inside an authority the customer configured once:
- audience (cohorts, countries) and exclusions (domains, addresses, companies);
- approved offers and channels;
- sender identity;
- contact volume and sends per day;
- spend;
- time horizon;
- stop conditions;
- arms and their follow-up sequences.

The engine is pure. The sender, the clock and the outcome feed are ports, and the only sender in the repository is
`stubSender()`, which records and sends nothing. Wiring a real sender to the send rails (suppression, consent, sender
health) is a separate change, and it needs the authority below.

## Launch is not authority

`liveGate()` is `staging` unless every one of these holds:
- a separately configured customer authorization record;
- a verified sender;
- finite, positive volume and spend bounds;
- `DAZL_PILOTS_LIVE=1` for the deployment.

An issue, a plan or a test is never that record. Every logged send carries the mode, and a staging report says nothing was
sent.

## Assignment

Eligible accounts are split into arms by a seeded hash within each cohort, so arms are balanced per cohort and the result
does not depend on input order. An account whose address **or domain** is already in the pilot is skipped, so no prospect
hears from two competing arms.

The engine never asks anyone for approval; it fails closed instead:
- **Held:** an unverified identity or contact. The identity, date and contact gates stay upstream.
- **Skipped:** an account outside the audience, or excluded.
- **Escalated:** anything the authority does not cover, such as an unapproved offer or channel, or another sender.

## Running

`tick(day)` sends the next due step of each active prospect within the daily volume, the spend bound and the horizon.
- **Idempotent:** every action has a stable id `(pilot, account, step)`, and a re-run of the day or a retry after a crash
  never logs a send twice. The id is passed to the sender for its own dedupe.
- **Pause and resume:** `pause` / `resume`.
- **Pilot stops:** it stops by itself at the horizon, when the spend bound is reached, or on a health anomaly (bounce or
  complaint rate over its bound, once enough sends exist to measure it).
- **Prospect stops:** a reply, opt-out or bounce stops that prospect's follow-ups at once. An opt-out or a complaint also
  suppresses the address for every arm.

## Outcomes

`report()` gives, per arm, with denominators (prospects contacted) and 95% Wilson intervals:
- qualified conversations: an independent qualifier's verdict; `unknown` is not qualified and is counted separately;
- held meetings: the meeting's final status; scheduled, cancelled and no-show are not held, and are counted;
- opt-outs, bounces and complaints;
- spend, and cost per qualified conversation and per held meeting.

Only events with this pilot's own provenance (pilot id, arm, account) count. A reply to a benchmark-generated email, or to
another pilot, is ignored and counted as such: benchmark emails never demonstrate business lift.

## Audit

Every assignment, skip, send, failed send, outcome event and status change goes into an append-only log. `replay(log)`
rebuilds the exact state.

## Not built (each needs authority)

- A real sender adapter over the outreach rails.
- The customer-facing authorization screen that creates the record.
- The independent reply qualifier (the classifier in `lib/replies` is a candidate; it must be validated like a judge, #396).
- The meeting feed from the calendar integration (#367).
