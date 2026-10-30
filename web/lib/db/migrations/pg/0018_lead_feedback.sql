-- Tenant lead feedback (lib/scan/feedback.ts, #385): a reasoned accept / reject verdict on an account, person or event,
-- applied to later runs until it is reset (reset_at and reset_reason keep the history). Tenant-scoped on every read.
CREATE TABLE lead_feedback (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('accept', 'reject')),
    level TEXT NOT NULL CHECK (level IN ('account', 'person', 'event')),
    reason TEXT,
    company_key TEXT NOT NULL,
    domain TEXT,
    person_key TEXT,
    event_date TEXT,
    source_host TEXT,
    lead_id TEXT,
    job_id TEXT,
    note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
    created_at BIGINT NOT NULL,
    reset_at BIGINT,
    reset_reason TEXT
  );
CREATE INDEX lead_feedback_tenant ON lead_feedback (tenant_id, reset_at);
