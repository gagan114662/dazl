-- Event-level monitor detection (lib/monitor-events.ts, #387): per-tenant event state, alerts, per-source cursors.
CREATE TABLE monitor_events (
    user_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    monitor_id TEXT NOT NULL,
    first_seen_at BIGINT NOT NULL,
    occurred_at BIGINT,
    last_checked_at BIGINT NOT NULL,
    first_actionable_at BIGINT,
    reachable BIGINT NOT NULL DEFAULT 0,
    alerted_kind TEXT,
    alerted_at BIGINT,
    PRIMARY KEY (user_id, event_key)
  );
CREATE INDEX monitor_events_entity ON monitor_events (user_id, entity_key);
CREATE TABLE monitor_alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    monitor_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('new_company','new_signal','newly_actionable','now_reachable')),
    company TEXT,
    latency_s BIGINT,
    at BIGINT NOT NULL
  );
CREATE INDEX monitor_alerts_run ON monitor_alerts (run_id);
CREATE TABLE monitor_cursors (
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    last_event_at BIGINT,
    last_checked_at BIGINT NOT NULL,
    PRIMARY KEY (monitor_id, source)
  );
