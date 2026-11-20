# Production literal gate

The existing required merge job, `static-quality`, runs a blocking check before its previous calibrations and analysis. It compares the exact reviewed ancestor against the candidate tree. After the one reviewed bootstrap for #1430, the checker and policy come from the reviewed base, not from the candidate. It does not import candidate source.

## Scope and policy

A regular expression that checks only generic work modes (for example, remote or hybrid) is not a named-location override. Combining those modes with a place name is still blocked.

The syntactic rule covers new static literals in explicit operational city, region, country, location, industry/category and company/employer fields and statically named per-case or evaluator override containers in production JS/TS under `web/lib`, `web/app` and `web/components`. It detects static property and element-key assignments/comparisons, object binding defaults, same-file const aliases, switch cases, literal override-map payloads, named eval/scorecard numeric ordinals and direct string/regex matching of governed slots. Ordinary UI copy, schema types, generic signal names and generic unkeyed thresholds are not evidence. There is no production name allowlist or catalog-path bypass. Legacy entries at the exact base path and equivalent AST slot are grandfathered as baseline counts only. Inventory/review of the remaining legacy cases is separate work; it is not a pass for new additions.

Dynamic computed fields, exported/inter-file data flow, alias graphs, implicit locale strings and arbitrary positional lists do not receive semantic classification. This is not a universal hardcoding detector. Oversize, malformed or unavailable scoped evidence fails closed. Do not use a different encoding, file type or unclassified expression to evade review. Keep protected workflow, scanner and policy changes under normal maintainer review; an ordinary GitHub Actions job does not defend against someone allowed to replace the required workflow or protection settings.

## Bootstrap and receipts

Review the exact first PR and first main transition separately; only the pinned bootstrap base and PR number can read the candidate gate code when both trusted base files are absent. The one-time first main push is limited to that base as first parent. Subsequent missing or invalid protected policy/tooling is failure. Re-pin and re-review explicitly if the bootstrap base moves.

The workflow uses a fixed minimal compiler package, no candidate npm/package install before this step, and no expanded GitHub permissions. Hosted output shows only pass/fail; source strings, URLs, cases and raw provider data do not go to CI reports. The existing normal quality analysis still runs after a green check.
