# Master-key rotation runbook (operator procedure)

Rotates DAZL_MASTER_KEY by re-wrapping the data keys inside every registered
ciphertext envelope. Secret bodies (iv/ct/tag) are never re-encrypted and
plaintexts never touch the tool. Direction is by operator discipline: the
envelope carries no epoch marker, so the runbook direction is the only record.

## Facts that bound this procedure

- Registered columns (fixed allowlist, `REWRAP_COLUMNS` in lib/secrets-rewrap.ts):
  tenant_llm_keys.ciphertext, tenant_connectors.ciphertext, gmail_accounts.refresh_ct.
- The tool PREFLIGHTS every row before the first write: in default mode one
  unrewrappable row aborts with zero writes. Partial state is possible only
  from a crash or a fence violation mid-write; both directions are idempotent
  (re-run resumes, key-swapped run rolls back).
- The compare-and-swap on the preflight blob is defense-in-depth, NOT a proven
  multi-connection fence. A verified single-writer window is required.
- Old backups contain CIPHERTEXT, not the key. The old key must be retained
  until backups are rekeyed or retired per a verified backup-retention
  inventory (that inventory is a separate step, not done by this tool).
- No duration estimate exists until a rehearsal on a live-shape clone produces
  actual facts.

## Procedure

1. Fence writers: stop or fence every process that can write the database and
   VERIFY the drain (no in-flight transactions). A homepage health check does
   not prove this.
2. Take a consistent backup via the sqlite backup API (never cp of .db+WAL).
3. Rehearse on a read-only clone of the backup first; only then touch live.
4. Dry run (read-only, no sidecar writes):
   `rewrap-master-key.mts --db <path> --dry-run` with DAZL_MASTER_KEY=current,
   DAZL_MASTER_KEY_NEXT=new. Expect "would rewrap" counts and zero corrupt.
   Zero-corrupt is a hard gate: any corrupt row stops the procedure here.
5. Real run: same command without --dry-run. The tool exits non-zero unless
   the post-run gate passes: every row decrypts under the new key, a read-only
   re-check shows 0 would-change and 0 corrupt.
6. Only after the gate passes: swap the env value and restart the process.
7. Re-run `--verify` (read-only) against the new key after restart.
8. Retain the old key (secured) until step: backups rekeyed or retired per the
   verified retention inventory. Then revoke/destroy it deliberately.

## Rollback

Symmetrical: swap the two env values and run again (DAZL_MASTER_KEY=the key
the rows are currently under, DAZL_MASTER_KEY_NEXT=the previous one). The same
gates apply. Body bytes are byte-identical after any number of round trips.

## Failure modes

- Preflight abort: zero rows written. Fix the located rows, or make an
  explicit operator decision to run --quarantine-corrupt (recovery mode).
- Crash / fence-violation abort mid-write: partial state. Resume the same
  direction (idempotent) or roll back with keys swapped. Quarantined rows, if
  any, are counted and reported as unknown-affected tenants: their credentials
  may be unreadable. Never report the outcome as healthy while corrupt > 0.
- A globally wrong old key fails preflight on every row: zero writes, non-zero
  exit. Quarantine mode cannot silently succeed here either - the post-run
  gate fails because those rows do not decrypt under the new key.
