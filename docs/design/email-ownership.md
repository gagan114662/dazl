# Email ownership and account recovery (#357)

Status: increment 1 (verification, reset, recovery revokes sessions, verified email required to join a workspace)
and increment 2 (change email, explicit Google linking) built.

## Tokens

- `email_tokens (user_id, purpose 'verify'|'reset', email, token_hash, created_at, expires_at, used_at)`.
- A link carries a random 256-bit token in the URL `#fragment` (never in a server log). Only its SHA-256 is stored.
- A token is used up in the same transaction that acts on it, so a replayed link does nothing. Issuing a new token
  of a purpose makes the account's earlier unused ones of that purpose stop working.
- Verification links last 24 hours, and only while the account's email is still the one the link was sent to.
- Reset links last 30 minutes.

## Flows

- **Signup** (password, `POST /api/auth/signup`). While dazl can deliver mail (`systemMailAvailable()`), it signs
  nobody in. Every accepted request gets the same answer (200, `{ ok, check_email, message }`, no cookie), whether or
  not the address already has an account:
  - a new address becomes an unconfirmed account marked `users.email_confirmation_required = 1` and gets a
    verification link;
  - an address that already has an account gets a notice ("someone tried to sign up with your email") that carries
    no link acting on the account; the account is untouched;
  - mail to one address is capped (3 per hour), keyed by the address and not by whether it has an account: past
    the cap every address gets the same answer and nothing is created or sent;
  Both paths spend the same scrypt work and one mail send, so they take about the same time.
  Without mail delivery, sign-up is exactly main's (review on #608): the account is made with
  `email_confirmation_required = 0` and signed in, and a taken address gets main's 400. So the sign-up enumeration
  gap stays open until a mail sender is configured; that is a separate owner/infra step, and #357 stays Refs.
- **App access needs a confirmed email, for accounts made under the requirement** (Gagan, 2026-11-03; narrowed per
  review on #608). `getSessionUser` and `hasLiveSession` (the API routes, `proxy.ts` and the `/app` layout) find no
  session only for `email_confirmation_required <> 0 AND email_verified_at IS NULL` (`CONFIRMED_OR_NOT_REQUIRED`,
  `confirmationPending` in `lib/auth-db.ts`). Sign-in with the right password to such an account answers 403
  `email_unverified`, makes no session, and sends a fresh link (3 per hour per account); a wrong password gets the
  same 401 as an unknown address. Confirming the link, then signing in, opens the app.
  - Every account that existed before the column gets 0 from its default: it keeps its sessions and password sign-in
    exactly as on main, confirmed or not, with or without mail. Nobody is backfilled or marked verified.
  - Every ownership gate already on main (invitations, preview claim, lifecycle mail, email change) still keys on
    `email_verified_at` alone, as on main. Checkout is exactly main's.
- **Verify**: `POST /api/auth/verify { token }`. This is public, because the link may be opened in another browser.
- **Forgot password**: `POST /api/auth/reset/request { email }` gives the same answer, byte for byte, for a password
  account, a Google account, an unknown email and a malformed one. It is rate limited per IP and per email.
  - A password account gets a reset link.
  - A Google-only account gets a note to use Google. Setting a password there would add a way in that Google does
    not guard.
- **Reset**: `POST /api/auth/reset { token, password }` does all of the following in one transaction:
  - sets the new password;
  - marks the email verified (opening the link proved it);
  - uses up every reset link of the account;
  - revokes every session (`revoke_reason = 'recovery'`).
  The person then signs in with the new password.

## What needs a verified email

| action | rule |
|---|---|
| accept a workspace invitation | the invitation is bound to an email, so the account must have proved it owns that address (`email_unverified`, 403) |
| link a Google identity to an existing account | never by email alone; see "Google linking" below |
| free trial scans (dazl's own key) | already require Google sign-in, which Google verifies |
| outreach sends | go through the tenant's own Gmail OAuth, which proves the mailbox |
| dazl's own lifecycle mail (`lib/outreach/lifecycle.ts`) | goes only to verified addresses; an unverified signup stays pending |

Google accounts count as verified: new ones at sign-up, existing ones by the backfill. Every other paid action runs
on the tenant's own key or connection (model key, enrichment, CRM, Cal.com), which is not dazl's mail or money.
The session carries `emailVerified`, read with the session on every request (`getSessionUser`).

## Delivery

`lib/system-mail.ts` sends dazl's own mail over SMTP when `SYSTEM_MAIL_SMTP_URL` and `SYSTEM_MAIL_FROM` are both
set (nodemailer). Otherwise nothing leaves the host: the message goes to `system_mail_outbox`, which is eligible for deletion after
24 hours only when `ACCOUNT_RETENTION_ENABLED=1` is explicitly configured after an approved policy (OFF by default). Without configured SMTP, public reset/resend/change requests return503 before issuing links, never claim delivery. Signup remains usable but unverified; its fixture/local outbox is not external mail delivery. Tests read the outbox and never send.

## Change email (increment 2)

`POST /api/auth/email { email }` needs a session signed in within the last hour. It sends a `change` link to the new
address and a notice to the current one. The email changes, already verified, only when the link is opened, and only
if no other account has taken that address meanwhile. The answer is the same whether or not the new address is in
use; when it is, nothing is sent to it.

## Google linking (increment 2)

Signing in with Google using the email of an existing password account is still refused (`email_exists`). Linking
is an explicit action instead: Settings > Account > "Add Google sign-in" (`/api/auth/google?link=1`). The callback
links the Google identity only when all of these hold:

- the request carries that account's own session, signed in within the last hour;
- the account's email is verified;
- the account's email is the Google identity's email (Google verified it);
- the Google identity belongs to no other account.

Otherwise it lands on Settings with the reason (`mismatch`, `unverified`, `taken`, `reauth_required`,
`signed_out`). Linking keeps the current session and never creates one.

## Acceptance tests

| criterion | tests (both engines unless noted) |
|---|---|
| expired, used and replayed tokens fail (verify, reset, change) | `email-ownership.test.ts` (expired, superseded, old-email, replayed), `email-linking.test.ts` (change replay), `email-routes-runtime.mts` via `workspace-routes.test.ts` (route replay and route expiry for reset and verify; SQLite) |
| recovery revokes old sessions | `email-ownership.test.ts` reset, `recovery-capabilities.test.ts` (pending change token, late change request, late password sign-in), `email-linking.test.ts` (late Google link), `email-routes-runtime.mts` (route) |
| enumeration-resistant answers | `email-routes-runtime.mts`: forgot password is byte-identical for password, Google, unknown and malformed addresses; change email is identical for a taken and a free address and sends nothing to the taken one. `signup-confirmation-runtime.mts` via `signup-confirmation.test.ts` (SQLite): signup is byte-identical (status, body, no cookie) for a new, a confirmed, an unconfirmed, a Google and a case-variant address, takes about the same time (interleaved medians), answers the same past the per-address cap, under a race and with mail down or unavailable |
| no app access before the email is confirmed | `signup-confirmation-runtime.mts`: unconfirmed sign-in 403 with no session; a session held by an unconfirmed account gets 401 from API routes and the sign-in redirect from `/app` pages; superseded, expired and replayed links refuse; the newest link confirms and sign-in then opens the app. `pg-tenant-instance.mts` (PG): signup, refused sign-in, only the newest link confirms, then sign-in. `auth-session.test.ts`, `email-ownership.test.ts` (both engines) |
| two-account linking only after fresh proof | `email-linking.test.ts` (three accounts), `google-auth-route-runtime.mts` (signed out, stale, fresh) |
| existing accounts keep sessions and sign-in; gates as on main | `email-confirmation-flag.test.ts` (both engines: legacy session and sign-in, marker fail-closed, invitation still needs a verified email, additive re-runnable column), `signup-confirmation-runtime.mts` (legacy account with and without mail; sign-up without mail is main's), `billing-e2e-runtime.mts` (checkout as on main for an unconfirmed legacy account), `preview-claim.test.ts` (unverified claim refused, unchanged) |

Without `SYSTEM_MAIL_SMTP_URL` and `SYSTEM_MAIL_FROM` (production today), password sign-up behaves exactly as on main
and no account is made under the confirmation requirement. Existing accounts keep their access when this ships.
Checkout for an unconfirmed account is not gated by this change (as on main): a known gap against #357.

## Open: response timing on sign-up (#608 review item 1, unresolved)

When mail is configured, the new-account path awaits sendVerification and the taken-address path awaits
sendSignupNotice before answering. The equal-time tests use an immediate fake SMTP transport, so they cannot show
that real providers and different templates answer in the same time. Timing enumeration is therefore NOT proven
closed. The fix would be durable uniform enqueue (answer first, send from the outbox), which is not in this PR.
