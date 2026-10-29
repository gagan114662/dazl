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

- **Signup** (password) sends a verification link. Settings > Account shows the state and can resend it
  (3 per hour).
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

Google accounts count as verified: new ones at sign-up, existing ones by the backfill.

## Delivery

`lib/system-mail.ts` sends dazl's own mail over SMTP when `SYSTEM_MAIL_SMTP_URL` and `SYSTEM_MAIL_FROM` are both
set (nodemailer). Otherwise nothing leaves the host: the message goes to `system_mail_outbox`, which is reaped after
24 hours by the tick. Production and staging have no SMTP today, so links sit in the outbox until the owner picks a
provider. Tests read the outbox and never send.

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
