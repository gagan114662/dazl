# Reviewed thread replies (Reddit / X)

Surface fresh Reddit and X threads where someone asks a question the tenant's product
answers, draft a reply, and hand it to the user to post themselves.

## Why dazl never posts

- Both platforms require automated access to go through their official APIs and identify
  as automation. Posting through a copied session cookie violates those terms and risks
  the tenant's own account - the same reason the session worker is read-only and
  rate-capped (see `session-worker/src/fetchers.ts` and the 2026-10-21 decision in
  `web/lib/advanced/config.ts`).
- Official posting routes exist but are separate commitments: Reddit posting needs a
  registered Reddit app and OAuth consent from the tenant; X write access needs a paid
  API tier. Neither is included here, and adding one would be its own reviewed change
  with the tenant's explicit consent.
- The send action is therefore "Copy & open thread": the reply is copied, the thread
  opens in the user's own browser, and they paste and post it from their own session.
  "Mark posted" is the user's own record-keeping, never a verification.

## What it does

- Searches: up to 5 per tenant (`reply_queries`). Refresh calls the tenant's own session
  worker (`adv:reddit-replies`, `adv:x-replies`), shares each platform's hourly budget
  with every other advanced feature, requires the existing advanced-connector consent,
  and is limited to 10 refreshes/hour.
- Only threads dated within 14 days whose title looks like a question are kept
  (`looksLikeQuestion`). Deduped by URL per tenant. LinkedIn is deliberately excluded.
- Drafts are written on the tenant's OWN AI key (BYOK, same as content briefs) with the
  seller profile as context. The draft answers the question first; the product is
  mentioned only on a direct fit. The user can edit, rewrite, copy, and dismiss.

## Files

- `web/lib/replies/threads.ts` - storage, refresh, drafting
- `web/app/api/replies/route.ts`, `web/app/api/replies/[id]/route.ts` - API
- `web/app/app/replies/` - UI
- `web/test/replies.test.ts` - tests
