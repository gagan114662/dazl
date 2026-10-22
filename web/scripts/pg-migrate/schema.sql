-- Postgres schema for the GET /api/leads read slice (W1 architecture proof).
-- SLICE SUBSET: only tables/columns the 8 LeadsReadDb methods touch. NOT the full
-- production schema - the full translation comes from the migration rehearsal.
-- Defaults using strftime are translated to extract(epoch from now()); SQLite
-- length() checks become char_length(). Triggers (leads_only_while_running,
-- sequence_sent_final) are intentionally deferred - they are write-path guards,
-- out of scope for this read slice.

CREATE TABLE IF NOT EXISTS scan_jobs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  business_name TEXT NOT NULL CHECK (char_length(business_name) BETWEEN 1 AND 150),
  industry      TEXT NOT NULL CHECK (char_length(industry) BETWEEN 1 AND 100),
  location      TEXT NOT NULL CHECK (char_length(location) BETWEEN 1 AND 100),
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT CHECK (error IS NULL OR char_length(error) <= 200),
  created_at    INTEGER NOT NULL DEFAULT (CAST(extract(epoch from now()) AS INTEGER)),
  claimed_at    INTEGER,
  finished_at   INTEGER,
  funded_by     TEXT NOT NULL DEFAULT 'user',
  watch_id      TEXT,
  candidates    INTEGER,
  needs_review  INTEGER,
  dropped       INTEGER,
  drop_reasons  TEXT,
  verified      INTEGER,
  query         TEXT CHECK (query IS NULL OR char_length(query) <= 600),
  icp           TEXT CHECK (icp IS NULL OR char_length(icp) <= 4000),
  icp_inferred  INTEGER,
  sources       TEXT CHECK (sources IS NULL OR char_length(sources) <= 2000)
);
CREATE INDEX IF NOT EXISTS scan_jobs_user ON scan_jobs (user_id, created_at);
CREATE INDEX IF NOT EXISTS scan_jobs_status ON scan_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 150),
  company     TEXT NOT NULL DEFAULT '' CHECK (char_length(company) <= 150),
  contact     TEXT CHECK (contact IS NULL OR char_length(contact) <= 254),
  signal      TEXT NOT NULL CHECK (char_length(signal) BETWEEN 1 AND 500),
  source_url  TEXT NOT NULL CHECK (char_length(source_url) <= 500 AND (source_url LIKE 'https://%' OR source_url LIKE 'http://%')),
  score       INTEGER NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
  created_at  INTEGER NOT NULL DEFAULT (CAST(extract(epoch from now()) AS INTEGER)),
  evidence_excerpt TEXT CHECK (evidence_excerpt IS NULL OR char_length(evidence_excerpt) <= 400),
  event_date TEXT, date_status TEXT CHECK (date_status IS NULL OR date_status IN ('verified','unverified','undated')),
  retrieved_at INTEGER, confidence INTEGER CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  dedup_key TEXT, review_reason TEXT, fit INTEGER CHECK (fit IS NULL OR fit BETWEEN 0 AND 5),
  intent INTEGER CHECK (intent IS NULL OR intent BETWEEN 0 AND 5),
  action INTEGER CHECK (action IS NULL OR action BETWEEN 0 AND 5),
  why TEXT CHECK (why IS NULL OR char_length(why) <= 600),
  signals TEXT CHECK (signals IS NULL OR char_length(signals) <= 1000),
  company_domain TEXT CHECK (company_domain IS NULL OR char_length(company_domain) <= 253),
  icp_match TEXT CHECK (icp_match IS NULL OR char_length(icp_match) <= 400),
  watch_new INTEGER NOT NULL DEFAULT 0, seen_before INTEGER NOT NULL DEFAULT 0,
  stage TEXT, signal_kind TEXT, source_kind TEXT,
  CHECK (name <> '' OR company <> '')
);
CREATE INDEX IF NOT EXISTS leads_job ON leads (scan_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_dedup ON leads (scan_job_id, dedup_key) WHERE dedup_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outreach_messages (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  lead_id        TEXT NOT NULL,
  to_email       TEXT NOT NULL,
  subject        TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150),
  body           TEXT NOT NULL CHECK (char_length(body) BETWEEN 20 AND 3000),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','skipped','uncertain')),
  approved_hash  TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  claimed_at     INTEGER,
  sent_at        INTEGER,
  error          TEXT,
  created_at     INTEGER NOT NULL DEFAULT (CAST(extract(epoch from now()) AS INTEGER))
);

CREATE TABLE IF NOT EXISTS sequences (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  lead_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  to_email    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','active','replied','done','stopped')),
  stop_reason TEXT CHECK (stop_reason IS NULL OR char_length(stop_reason) <= 40),
  created_at  INTEGER NOT NULL DEFAULT (CAST(extract(epoch from now()) AS INTEGER)),
  UNIQUE (tenant_id, lead_id)
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  tenant_id     TEXT NOT NULL,
  sequence_id   TEXT NOT NULL,
  step          INTEGER NOT NULL CHECK (step BETWEEN 1 AND 3),
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  approved_hash TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','uncertain')),
  gmail_id      TEXT,
  claimed_at    INTEGER,
  sent_at       INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (CAST(extract(epoch from now()) AS INTEGER)),
  PRIMARY KEY (tenant_id, sequence_id, step)
);

CREATE TABLE IF NOT EXISTS sequence_settings (
  tenant_id      TEXT PRIMARY KEY,
  test_addresses TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS lead_enrichments (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  connector   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL CHECK (char_length(value) <= 254),
  label       TEXT CHECK (label IS NULL OR char_length(label) <= 200),
  confidence  INTEGER,
  source_url  TEXT NOT NULL CHECK (char_length(source_url) <= 500 AND source_url LIKE 'http%'),
  source_date TEXT NOT NULL CHECK (char_length(source_date) = 10),
  retrieved_at INTEGER NOT NULL DEFAULT (CAST(extract(epoch from now()) AS INTEGER))
);

CREATE TABLE IF NOT EXISTS company_events (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  company_key        TEXT NOT NULL CHECK (char_length(company_key) <= 254),
  company_name       TEXT CHECK (company_name IS NULL OR char_length(company_name) <= 200),
  scope              TEXT NOT NULL CHECK (scope IN ('account','market')),
  lead_id            TEXT,
  event_type         TEXT NOT NULL,
  summary            TEXT NOT NULL CHECK (char_length(summary) <= 300),
  detail             TEXT,
  source_url         TEXT NOT NULL CHECK (char_length(source_url) <= 500 AND source_url LIKE 'http%'),
  source_published_at TEXT CHECK (source_published_at IS NULL OR char_length(source_published_at) = 10),
  retrieved_at       INTEGER NOT NULL,
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  confidence         INTEGER
);

CREATE TABLE IF NOT EXISTS suppressions (
  tenant_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('unsubscribe','manual','bounce')),
  created_at INTEGER NOT NULL DEFAULT (CAST(extract(epoch from now()) AS INTEGER)),
  PRIMARY KEY (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  gmail_id TEXT NOT NULL, tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, lead_id TEXT, from_email TEXT NOT NULL,
  excerpt TEXT NOT NULL CHECK (char_length(excerpt) <= 200), classification TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, gmail_id)
);
