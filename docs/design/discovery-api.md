# Scoped discovery API (MCP) — #392

Status: built, **OFF** by default. The owner turns it on by setting `DAZL_API_TOKENS=1` on the deployment; until then
`POST /api/mcp` answers 404 and no token can be created (listing and revoking existing tokens always work).

## What it is

- **Tokens** (`lib/api-tokens.ts`, `app/api/settings/api-tokens`): an admin of a workspace creates a token with a label,
  scopes and limits (fresh sign-in required). The secret (`dzl_` + 43 base64url chars) is shown once; the store keeps only
  its SHA-256 and a public id. Tokens expire (default 90 days, max 365); revoking is immediate on every instance. At most
  10 working tokens per workspace. They are credentials: tenant deletion removes them at the `revoked` step.
- **Scopes**: `read` (always required) and `scan`. There is no send, draft, CRM or settings scope. On every request the
  granted scopes are intersected with the creator's *current* role in the workspace (`read` needs viewer, `scan` needs
  operator); a removed member's tokens stop working, a demoted one loses `scan`.
- **Endpoint** (`app/api/mcp/route.ts`, `lib/mcp/discovery.ts`): MCP over Streamable HTTP, JSON responses only, stateless.
  `Authorization: Bearer dzl_...`. Rate limited per IP (120/min, before the token lookup) and per token (60/min); both fail
  closed. A browser `Origin` must be this host (DNS-rebinding guard). Nothing logs the header, the token or the body.
  The body is read at most 64 KB (a larger stated or streamed body is refused with 413 without buffering it), must be
  valid UTF-8 JSON, one message (no batches), with object params; an unexpected error answers JSON-RPC -32603 and is
  recorded scrubbed (lib/ops/errors.ts), never with headers or the body.

## Tools

| tool | scope | returns |
|---|---|---|
| `list_scans` | read | the same list as `GET /api/scan/jobs` |
| `get_scan` | read | the same payload as `GET /api/scan/status?passive=1` (status, progress, outcome, quality, cost) |
| `get_leads` | read | the same payload as `GET /api/leads` (evidence, timing proof, entity checks, held flags), `limit` ≤ 200 |
| `list_monitors` | read | the recurring plays (monitors), the same list as `GET /api/monitors`; read-only |
| `get_profile` | read | the saved seller line |
| `start_scan` | scan | one scan through every gate of `POST /api/scan` (`lib/scan/start-scan.ts`, moved there unchanged) |

Lead/page content is returned under `data` next to a fixed notice that it is untrusted third-party text. Authority is never
derived from tool output or arguments; unknown arguments are refused.

## start_scan spend and retries

- Required `idempotency_key`: the key is claimed (`api_token_scans`) before anything starts. Retrying the same request
  returns the same `job_id`; the same key with a different request is refused; a start that is in flight or died midway is
  never retried automatically (`start_in_progress`). A refused start releases the key.
- The token's own reservation: `scans_per_day` (1-20, default 3, shared rate_limits store, fails closed; refused starts are
  refunded) and `max_usd_per_scan` (default $2, max $25) forced as the run budget, with `paid_fallback` and
  `credit_enrichment` off. A larger `max_usd` is refused, never clamped.
- Then the app's gates unchanged: the workspace's 10 scans/hour (same key as the app), one active scan, plan quota, cost
  estimate / owner spend pools, offer conflicts. API scans never use the free trial (workspace's own model key only).
- Every started scan writes an `api.scan_started` audit event (actor = token creator, `api_id` = token public id).

## Connecting a client

Any MCP client that can send a bearer header, e.g. the OpenAI Responses API `mcp` tool
(`server_url: https://<host>/api/mcp`, `headers: { Authorization: "Bearer dzl_..." }`). ChatGPT's own connector UI expects
OAuth, which is **not** built here.

## Not done (Refs, not Closes)

- OAuth 2.1 authorization for ChatGPT's connector UI.
- Creating, changing or pausing recurring plays over the API (standing spend; read-only `list_monitors` only).
- A settings UI for tokens (the API route exists; no page).
- The Dazl-assisted vs plain-ChatGPT benchmark under #372.
