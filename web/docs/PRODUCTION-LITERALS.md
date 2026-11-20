# Production city and industry literals

Lead discovery must take geography and business category from the actual play and source evidence, not from defaults for particular cities or industries. Registry endpoints can be explicitly scoped when the scope comes from the publisher. Keep that data in `web/lib/sources/registry-source-catalog.ts`, the only configuration exception. A registry source is optional evidence, not a prerequisite for a market.

## Reading the CI results

**Production literals (advisory only)** compares the current main-reviewed policy with the candidate merge. A failed run with unapproved findings means it detected added static strings in recognized city or industry fields outside the catalog. Inspect the diff and derive the value from the play or from a publisher-scoped catalog entry. If the run reports **unavailable**, it did not verify the exact Git refs or the scanner toolchain. That is not a clean result; look at the current PR event and rerun via the normal PR workflow once the refs are stable.

This is an advisory, not a required status or a replacement for a release gate or reviewer. It does not flag general product copy, fixtures, dynamic expressions, or arbitrary variable names. Existing identical uses are grandfathered, not endorsed. In particular, a clean report is not evidence that lead quality works in every market.

**Production literal checker tests** validates the scanner and policy from one pinned candidate. After changes to the gate itself, verify this fixture job on the PR. The advisory takes its checker from protected main, so a change to the advisory is observable there only on a separate PR event once the change is on main. Verify a clean and a rejecting fixture in CI; do not put deliberately hardcoded cases into live discovery code for a test.
