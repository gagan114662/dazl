export function scanSpendSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS scan_spend_calls (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      scan_job_id TEXT NOT NULL,
      attempt     INTEGER NOT NULL,
      kind        TEXT NOT NULL CHECK (length(kind) <= 32),
      reserve_usd REAL NOT NULL CHECK (reserve_usd >= 0),
      actual_usd  REAL CHECK (actual_usd IS NULL OR actual_usd >= 0),
      status      TEXT NOT NULL CHECK (status IN ('reserved','settled','kept','refused')),
      reason      TEXT CHECK (reason IS NULL OR length(reason) <= 80),
      created_at  INTEGER NOT NULL,
      settled_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS scan_spend_calls_job ON scan_spend_calls (user_id, scan_job_id);
CREATE TABLE IF NOT EXISTS scan_native_search_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scan_job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  allowance INTEGER NOT NULL CHECK (allowance >= 0 AND allowance <= 15),
  used INTEGER CHECK (used IS NULL OR (used >= 0 AND used <= allowance))
);
CREATE INDEX IF NOT EXISTS scan_native_search_calls_job ON scan_native_search_calls(user_id,scan_job_id);
  `
}

// Previously dispatched searches have no trustworthy counter: retain the whole allowance
// when introducing the native ledger. Later migrations leave new jobs' reservations alone.
export const backfillNativeSearchCallsSql = `
INSERT INTO scan_native_search_calls(id,user_id,scan_job_id,attempt,allowance,used)
SELECT 'legacy:' || s.scan_job_id,s.user_id,s.scan_job_id,MAX(s.attempt),15,NULL
FROM scan_spend_calls s
WHERE s.kind = 'llm.anthropic.web_search' AND s.status <> 'refused'
  AND NOT EXISTS (SELECT 1 FROM scan_native_search_calls n WHERE n.scan_job_id = s.scan_job_id AND n.user_id = s.user_id)
GROUP BY s.user_id,s.scan_job_id;
`
