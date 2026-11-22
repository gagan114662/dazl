# Test-only Inbox fixture (#369)

Two Inbox criteria of #369 cannot be shown on live data from the test account: more than one page of
conversations, and a correlated delivery notice held for review (`bounce_review`). Replies only enter through the
consent-gated Gmail reply scan; sending mail or editing the database by hand is not allowed. This fixture writes a
clearly labelled synthetic set instead, for the designated test tenant only. It sends nothing and calls no
provider, model or network.

Code: `lib/outreach/inbox-fixture.ts`, route `app/api/outreach/inbox/fixture/route.ts`, tests
`test/inbox-fixture.test.ts` (both engines) and `test/inbox-fixture-route.test.ts`.

## Switches (both required; default OFF)

| Env | Default | Effect |
|---|---|---|
| `OUTREACH_INBOX_FIXTURE` | unset (off) | Exactly `1` turns the route on. Anything else (`true`, ` 1`, `0`, empty) is off. |
| `OUTREACH_TEST_TENANT_ID` | unset (nobody) | The one tenant that may seed or clean up. Unset or blank refuses everyone. Same variable as the sequence test fixture (docs/SEQUENCES.md). |

The route also needs a signed-in **owner** of that workspace and a same-origin JSON request, and is limited to
10 calls a minute per workspace. Every refusal past the role check is written to the audit trail
(`inbox_fixture.seed` / `inbox_fixture.cleanup`, decision `denied`, with the reason) and answers the same
`403 {"error":"fixture_unavailable"}`, so the answer does not say whether the flag is on. The request body is never
read: the tenant always comes from the session. Unset `OUTREACH_INBOX_FIXTURE` after the check.

## What a seed writes

All in one play named `dazl inbox pagination fixture (test only)`, ids derived from the tenant (idempotent; a
second or concurrent seed writes nothing):

- 120 reply threads, more than the Inbox's largest page (100) and the default page (50). Classes cycle
  `other`, `uncertain`, `negative`, `auto` (never `positive`, so nothing counts as real interest), so Needs-you
  has 60 of them. Every excerpt starts `[test-only fixture NNN/120]`.
- One `bounce_review` thread: a recorded test send (`test = 1`, no Gmail id, never claimed, a month old) and a
  synthetic delivery-status notice (5.1.1) passed through `judgeDeliveryNotice`, the same judgement the reply sync
  stores real notices with (`lib/outreach/replies.ts`).
- Every address is on `inbox-fixture.dazl.invalid`. Draft and send refuse it (`fixture_recipient`), and
  `recipientAllowed` refuses it, which every follow-up, sequence and re-open path checks.

Total: 121 threads, 61 need the owner, all unread.

## Reviewer steps

Signed in as the owner of the test tenant, with both switches set, from the browser console on dazl.ai:

```js
// 1. seed
await (await fetch('/api/outreach/inbox/fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
// -> { created: true, job_id: '<play>', threads: 121, bounce_review_thread: 'dazl-inbox-fixture-thread-bounce', page_max: 100 }

// 2. pagination: three pages of 50 in the fixture play, no repeats, totals stable on every page
let q = `/api/outreach/inbox?job_id=<play>&limit=50`, seen = []
for (;;) { const p = await (await fetch(q)).json(); seen.push(...p.threads.map(t => t.thread_id)); console.log(p.threads.length, p.counts); if (!p.next_cursor) break; q = `/api/outreach/inbox?job_id=<play>&limit=50&cursor=${encodeURIComponent(p.next_cursor)}` }
seen.length, new Set(seen).size   // 121, 121

// 3. bounce_review: one row, needs the owner
await (await fetch('/api/outreach/inbox?job_id=<play>&class=bounce_review')).json()
// the Outcomes "Conversations need you" tile of /app/outcomes?job_id=<play> uses the same needs-owner rule (lib/outreach/needs-owner.ts): 61

// 4. cleanup: removes exactly the fixture's rows; a second call deletes nothing
await (await fetch('/api/outreach/inbox/fixture', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
// -> { deleted: { threads: 121, sends: 1, leads: 121, plays: 1, reads: <opened threads> } }
```

Cleanup deletes only rows of the session's tenant under the fixture's derived ids, each pinned to its marker (play
name, fixture address, fixture play); real rows, other tenants' rows and look-alike ids are untouched (tested).
