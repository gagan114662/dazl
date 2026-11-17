# Code review guide (Hermes-PC reviews, Quest merges)

Gagan's 4-gate CI is in docs/CI-GATES.md. A reviewer approves the **code**. A merge needs that approval plus every required check green.

## Criteria
1. **Scope:** the PR does exactly what the issue's request says (quoted verbatim in the PR body). No unrelated changes.
2. **Acceptance criteria:** each AC is observable, and each has evidence: an Automated test, and a Live check step if a user would see it.
3. **RED then GREEN:** the new test failed before the fix (command + output shown) and passes after. Inherited failures are named, never counted as passes.
4. **Safety:** no paid third-party API except Claude; no data deletion or destructive migration without Gagan's yes; no secrets in code or logs; spend caps respected.
5. **Tests are real:** they run the shipped code path, not a copy or a mock of the thing being tested.
6. **Rollback:** a deploy can be undone (deploy-prod.sh keeps the old release running).

## False-PASS checklist (reject if any is true)
- [ ] The check passes when the feature is broken: there is no refusal/control case proving it can FAIL.
- [ ] "PASS" is printed from a page that loads, not from the feature working (a page smoke is not a feature check).
- [ ] The test asserts on logged text or a fixture instead of real output.
- [ ] A timeout, skip, or missing secret is treated as success.
- [ ] Evidence comes from a different commit than the one being merged/deployed.
- [ ] The test was changed to match the bug instead of the bug being fixed.
- [ ] Network calls quietly hit a paid or live service in CI (the net-fence must stay on).

## Findings format
One finding per bullet, with a stable fix code that the author keeps in every reply:

    F1 [P0|P1|P2] <file:line> <what's wrong> — Expected: <behavior>. Probe: <exact command/input that shows it>.

The author answers point by point with the same codes (`F1: fixed in <sha>, test <name>`). If a finding comes back twice, the author changes approach instead of repeating the same fix.

## Three-round stop (needs-human)
After **3 rounds of "changes requested"** on one PR, the `needs-human` workflow adds the `needs-human` label and fails its check. The author stops looping, and Quest and the reviewer agree on the fix together, or bring it to Gagan if it needs her call. Remove the label once there's an agreed plan.
