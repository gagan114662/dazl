# Cold sequences

## Enable only after review

This change does not enable first-touch autopilot. It adds a separate server gate,
`SEQUENCES_ENABLED=1`, default off. `AUTOPILOT_KILL=1` also blocks sequence sends.
The existing authenticated `POST /api/internal/tick` drives the sequence scheduler.
Keep that scheduler running, ideally once per minute for own-inbox test mode.
A scheduled delay is a minimum, not a guarantee of delivery at the exact second.
No scheduler setup or flag was changed as part of the implementation.

## User flow

1. Draft an email from a verified lead with a published business address.
2. In Outreach, choose Create 3-step sequence.
3. Read/edit all three messages. The later messages use the tenant's key when
   available, otherwise fixed templates. Approval freezes the words. No model
   calls happen at send time.
4. Enable reply reading in Settings, accepting the new October 21 consent text.
   Existing read consent must be renewed. Gmail needs gmail.readonly scope.
5. Approve all three steps together, then click Send now on the original email.
6. Steps 2/3 become due at 3/7 days from the first send. Any human reply, bounce,
   opt-out, manual stop, account pause, revoked read permission, or failed reply
   refresh blocks the later sends. Autoreplies do not count as human replies.

The original message and sequence share a single approval state. Editing any
message before sending clears every approval. Active sequences cannot be edited.
Stop them instead. The scheduler never layers warm-reply automation onto a lead
that has a cold sequence.

## Tomorrow's test

Only explicitly entered own-inbox addresses may use the test allowlist in
Outreach. These use +3 minutes / +7 minutes. A recipient not in that tenant's
current list always uses +3 days / +7 days. No client flag can change this.
Removing an address restores normal delays. Saving the list sends nothing.
This implementation was tested with synthetic fixtures and mocked Gmail only.
No real message was sent during development.

### Test-only route to a consumer test inbox (OUTREACH_TEST_MODE)

Drafts are normally rejected when the recipient is a consumer mailbox
(Gmail, Yahoo, ... - a published address there is not a business contact).
For the approved own-inbox test only, the operator can set
`OUTREACH_TEST_MODE=1`. With that env on, the consumer-recipient gate is
bypassed ONLY for addresses the tenant explicitly entered in their own
test-inbox allowlist - nothing else changes: prospect addresses are not on
that list, every other consumer address still rejects, and with the env
unset even an allowlisted consumer address rejects. Drafts to any
allowlisted test inbox are stored with `test = 1`, badged "test mode" in
Outreach and on sequence cards, and logged as `outreach TEST MODE send`.
Test sends still count against the shared 20-per-day account budget, and
approve-before-send still applies to step 1. Turn the env off after the
test; it must never be on for real tenant sends.

## Send safety

A shared rolling budget reserves at most 20 emails per account in 24 hours across
first-touch, warm follow-ups and sequence steps. In-flight/uncertain attempts
reserve slots. Each sender claims synchronously and checks the budget after its
claim. Unknown outcomes never auto-retry. They pause the account. Resolve them
against Gmail Sent, then explicitly resume. An interrupted claim older than 10
minutes becomes uncertain.

Steps use the original Gmail thread and Message-ID. Every send adds the standard
sender details and unsubscribe link. Suppression is checked again after token
refresh. Reply sync reads only threads the product started, not the whole inbox.
There is inevitably a narrow race between the final mailbox read and send; this
is polling, not an instantaneous reply webhook. Failed/partial sync fails closed.

## Analytics

Campaign = scan. Counts cover first messages, sequence steps and existing warm
follow-ups. Replies/bounces are distinct threads. The UI labels the derived
sent-minus-recorded-permanent-bounces number "No bounce reported". It is not
proof of delivery. Opens and bookings are not measured. No tracking pixel.

## Verification

Run `npm test` and `npm run build` in web. Tests use injected Gmail/token responses,
never real mail. Browser previews use an isolated local database and synthetic
addresses ending in example.invalid. Production verification remains a separate,
explicitly approved own-inbox test after merge/deploy.
