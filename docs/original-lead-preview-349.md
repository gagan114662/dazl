# Original stored-lead free preview and profile provenance (#349)

The existing qualification helper and GET are generic, tenant-joined saved-lead diagnostics; only the review-row UI restricted the component to hiring_feed. No sourcekind-based eligibility rule was found in that read-only helper. This change exposes the existing free preview for review rows without rewriting lead sourcekind or changing qualification/drafting/source verification. Existing page budgets/guards and global paid-off switch remain. Paid UI remains offered only on the previously eligible hiring_feed rows; the component defaults free-only. Known blocked/login-required review rows do not retry through this preview. No automatic fetch is added.

The preview separates stored raw request and serialized profile, reports actual source/context coverage, and makes no semantic or approval claim. Existing icp_inferred=0 means submitted, not authenticated review, so profile/reuse/Home copy now describes stored metadata honestly. Reuse rules, request criteria, API source enum, filters, records and approvals are not rewritten.

Current production492 direct authenticated GET for original Revnu proved539/539UTF16 criteriaunits, complete/noissues, stored_profile/unrecordedapproval, source4000/6757 truncated, model_callfalse/enabledfalse/storedempty. That direct GET is not visible UI journey proof. This change's visible original-row path is separately tested in compiled candidate app with synthetic nonhiring and blocked leads. No actual record was added or sourcekind changed to make a test pass.

No semantic business/subject reasoning fix, no qualified lead, no paid probe, no activation, no fullcontent history. Original request authorship/criteria approval remains unresolved. #349 stays open.
