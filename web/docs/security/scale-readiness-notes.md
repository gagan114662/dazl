# Scale-readiness security notes (F3 / F6 / F7)

Read-only design notes companion to `tenant-isolation-assessment.md`. No code
changes here; deployment verification belongs to the deploy owner.

## F3 - X-Forwarded-For trust (config-dependent)

`lib/rate-limit.ts` `clientIp()` takes the first XFF value verbatim. Whether this
is exploitable depends on the edge:

- If Caddy (or any proxy) terminates TLS and sets/overwrites XFF, the spoofed
  client value is replaced and the limits hold.
- If the proxy appends or passes through, an attacker rotates spoofed IPs to
  bypass sign-in (20/15min), signup (5/hr), unsubscribe (30/hr) and the trial
  scan IP throttle (free-scan farming on the shared operator key).

Verification (deploy owner, read-only): send a request with a forged
`X-Forwarded-For: 203.0.113.99` header through the public endpoint and check
what the app logs/observes as the client IP; or inspect the Caddyfile for how
the reverse_proxy directive handles XFF (Caddy's reverse_proxy sets XFF to the
immediate peer by default, which is safe if the app is only reachable through
Caddy).

Code-side hardening options (no deploy change needed):
1. Trust only the rightmost XFF entry appended by the known proxy count
   (with one proxy: the last value).
2. Fail closed to `unknown` when the immediate peer is not a configured proxy
   address (needs a TRUSTED_PROXY env var).

## F6 - Session hygiene

Current: 30-day absolute sessions, deleted only on explicit signout; no reaper;
no invalidation on password change (no password-change flow exists yet).

Proposed (small, no schema change):
1. Reaper: `DELETE FROM sessions WHERE expires_at < unixepoch()` on the
   existing autopilot tick or lazily inside `getSessionUser` (bounded, e.g.
   once per hour per process).
2. On signout-all / future password change: `DELETE FROM sessions WHERE
   user_id = ?`.
3. Optional at scale: shorten absolute TTL and add sliding rotation (re-issue
   the cookie when the session is half-expired).

## F7 - Rate limiter and multi-process (W3 dependency)

The in-memory fixed-window limiter silently multiplies every limit by the
process count once the web tier scales out (sign-in protection, send caps,
scan caps). Design options, in order of fit with the migration plan:

1. Postgres-backed fixed window after W1 lands: table
   `rate_buckets(key TEXT PRIMARY KEY, count INT, reset_at BIGINT)` with a
   single atomic `INSERT ... ON CONFLICT DO UPDATE` per check. Matches the
   current limiter semantics exactly; no new infra.
2. Redis/Valkey sliding window if a cache is introduced anyway for sessions
   (W3's session-store option).
3. Keep per-process limits temporarily but divide each limit by the expected
   process count - acceptable stopgap, must be explicit, never silent.

The limiter's call signature (`rateLimit(key, limit, windowMs)`) is already
shared-store friendly; only the storage backend changes.
