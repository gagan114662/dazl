# Legacy Cloudflare/Clicky worker (removed)

HISTORICAL RECORD ONLY. These are not current operator instructions.

The `clicky-proxy` Cloudflare Worker (Durable Objects, D1, Workflows, a Sandbox
"brain" container) used to live under `worker/src` with its own migrations,
brain seed, TypeScript tests and `wrangler.toml`. It was removed from the tree on
2026-11-06 (#895) after the owner confirmed no deployed service, outside caller,
operator workflow or rollback depends on it. The backup runbook already recorded
that its D1 stack never ran (`web/docs/backup-runbook.md`). No Cloudflare
account resource was deleted by that change.

The files here (`PRODUCT.md`, `MULTITENANCY.md`, `RUNTIME_VERIFY.md`) are kept
as design history. The design plans under `docs/superpowers/` are history too.

The maintained code in `worker/` is the Node advanced-connectors worker
(`server.js`, `lib/*.js`, `test/*.test.js`). See `worker/README.md`.
