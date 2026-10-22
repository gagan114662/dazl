# TinyFish approval gate - review only, not activation approval

This change must not be merged or deployed without a separate impact decision.
It does not establish a free-only account or prove provider billing.

## What fails closed

- Missing/malformed/expired tenant approval blocks search and fetch before network,
  request counters or API-key disclosure.
- Approval requires a source reference, exact tenant, expiry, explicit acceptance of
  possible charges and a request-unit maximum. It is configured by the operator
  only after source-grounded user authority has been checked. No UI creates approval.
- Atomic request-unit reservation happens before calls. Each fetched URL counts as
  one unit. Failures remain consumed because provider charging is unknown.
- Ordinary scan runner checks the grant before model planning. A missing grant
  cannot silently fall through to the model's paid built-in search.
- Existing SEO and advanced-X paths use the same low-level search gate.

## Impact if activated against current production configuration

Production has a TinyFish key but no approval grants. Every normal scan would fail
with search_approval_missing rather than invoking model research. SEO indexing and
advanced-X TinyFish search would return no new results. No existing leads, settings,
watch schedules, reply sync, sequences or follow-ups are deleted or disabled.
The mixed five-minute cron is unchanged. Other tenants are affected by these denied
provider calls, so deployment is held for an explicit impact decision.

## Limits

A grant is a record of authority verified elsewhere, not a substitute for it.
Its unit cap is not a dollar cap. It cannot know account-wide free allowance, wallet
balance, usage outside this app, provider price changes or actual charges. No provider
billing endpoint has been verified. No free-only mode is invented.
The change covers TinyFish and ordinary scan fallback when a TinyFish key is configured;
it is not a universal all-provider spending policy. Other unrelated BYOK features are
unchanged. A grants-aware user-facing explanation is still needed before rollout.

Mock-only tests: missing, malformed, wrong-tenant, duplicate, expired, free-only claim,
invalid caps, search/fetch zero-network refusal and shared-cap overflow. Full suite:
449 pass, TypeScript clean. No live provider calls for validation.
