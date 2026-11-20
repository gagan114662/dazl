# Dazl repository rules

These rules apply to changes anywhere in this repository. Read `docs/NEVER-AGAIN.md` and the repository release and review instructions before changing or deploying code.

- Do not hardcode places, industries, or company or person names in production targeting, discovery, or verification. Use the user's reviewed intent and independently sourced evidence. Keep test cases and recorded fixtures out of production paths.
- Claude is the only paid API allowed. The per-scan ceiling is USD 5; a lower trial, account, or platform limit still applies. Reserve before dispatch, account for all paid calls including search, fetch, and judging, and settle actual usage before authorizing more. An unknown charge or a refusal stops further paid work. Never describe an estimate as an invoice guarantee.
- Keep holds strict. Show only leads that pass the existing proof requirements; keep held leads out of user-visible results. Fix a false hold only with a failing-then-passing test proving the underlying check was wrong. Do not loosen a correct hold.
- Scorecard numbers must not regress. Use comparable recorded inputs and evidence when comparing variants; no loss of qualified yield, precision, or evidence coverage and no increase in cost or latency beyond the approved limits. Missing or unknown results are not a pass. The required PR smoke check uses recorded fixtures only and spends $0.
- No test-only shortcuts, bypasses, fake readiness, replay flags, or special-case credentials in production paths. Never log private evaluation briefs, tokens, raw provider output, or tenant data in shared CI artifacts.
- Build the new company-first finder in its own module and keep it disabled by default. Keep the old finder intact. Switch only after the new path beats the existing path on the approved private scorecard with every hold still strict and the owner approves the exact production release.
