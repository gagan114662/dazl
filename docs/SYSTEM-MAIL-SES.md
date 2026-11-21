# Account email through Amazon SES (#1428)

dazl's own account email (password reset, email confirmation, email change, play-run notices) goes out through
`web/lib/system-mail.ts`, which sends over SMTP to `SYSTEM_MAIL_SMTP_URL` from `SYSTEM_MAIL_FROM`. The owner's decision
on #1428: that relay is **Amazon SES** on dazl's existing AWS account (us-east-2), sending as the `dazl.ai` domain with
SPF and DKIM. Outreach to prospects is not affected: it always goes from each customer's own Gmail.

The code needs no change for SES: SES offers an SMTP endpoint, and the deploy already refuses a release env without both
settings (`ops/prod/deploy-prod.sh`). These are the one-time operator steps.

**Do this before deploying the release that carries #1428:** its privacy policy names Amazon SES as the account-email
provider, which is only true once both relays below point at SES.

## 1. Domain identity with DKIM (SES console, region us-east-2)

1. SES -> Configuration -> Identities -> Create identity -> Domain `dazl.ai`.
2. Easy DKIM, RSA 2048. SES shows three CNAME records; add them to the `dazl.ai` DNS zone.
3. Custom MAIL FROM domain: `bounce.dazl.ai` (a subdomain used for nothing else; NOT `mail.dazl.ai`, which is already the
   inbound mail host and MX target, see `ops/inbound-mail/README.md`). Add the MX record SES shows
   (`10 feedback-smtp.us-east-2.amazonses.com`) and the SPF TXT record on `bounce.dazl.ai`:
   `v=spf1 include:amazonses.com ~all`.
4. Wait until the identity shows DKIM "Successful" and MAIL FROM "Success".
5. DMARC (if `dazl.ai` has none yet): TXT `_dmarc.dazl.ai` = `v=DMARC1; p=none; rua=mailto:privacy@dazl.ai`.

## 2. Leave the SES sandbox

SES -> Account dashboard -> Request production access (transactional mail: password resets and account confirmations,
low volume). In the sandbox, mail only reaches verified addresses, so a real user's reset would not arrive.

## 3. SMTP credentials

SES -> SMTP settings -> Create SMTP credentials. This creates an IAM user allowed only `ses:SendRawEmail`. Keep the SMTP
user name and password in the operator's secret store only; never paste them into an issue, a PR or a log.

## 4. The two settings on the box

In the production release env (the file `deploy-prod.sh` reads), replacing the current relay:

```
SYSTEM_MAIL_SMTP_URL=smtps://<SMTP user>:<SMTP password, URL-encoded>@email-smtp.us-east-2.amazonaws.com:465
SYSTEM_MAIL_FROM=dazl <no-reply@dazl.ai>
```

The inbound mail receiver keeps its own copy of the relay URL (`/etc/dazl-inbound-mail/env`, see
`ops/inbound-mail/README.md`) for forwards and replies: set the same SES URL there too, so support mail also goes out
through SES.

The SES SMTP password usually contains `/` and `+`: URL-encode it (`/` -> `%2F`, `+` -> `%2B`) or the URL is malformed.
Port 465 (implicit TLS) or 587 (STARTTLS) both work; port 25 is refused by the launch check.

## 5. Check it

- `GET https://dazl.ai/api/ready`: `checks.mail_relay.relay` is `"ses"` (worked out from the relay host only; it never
  changes `ok`), and `checks.mail.ok` is `true` (a real SMTP login within the last 5 minutes; the first probe after a
  restart reads `verify_pending`).
- Live check for #1428: on https://dazl.ai/reset ask for a link for a real account; the email arrives from
  `no-reply@dazl.ai`, its headers show `dkim=pass` and `spf=pass` for `dazl.ai` / `bounce.dazl.ai`, and the link sets a
  new password.
