-- connector_audit and warm_user_paths join the insertion-order tables (lib/db/insertion-order.ts, 0010): the settings
-- audit list and a lead's user-reported warm paths break same-second ties by insert_seq, the order SQLite's rowid gave.

CREATE SEQUENCE IF NOT EXISTS connector_audit_insert_seq_seq;
ALTER TABLE connector_audit ADD COLUMN insert_seq BIGINT DEFAULT nextval('connector_audit_insert_seq_seq');
ALTER SEQUENCE connector_audit_insert_seq_seq OWNED BY connector_audit.insert_seq;
CREATE INDEX IF NOT EXISTS connector_audit_insert_seq_idx ON connector_audit (insert_seq);

CREATE SEQUENCE IF NOT EXISTS warm_user_paths_insert_seq_seq;
ALTER TABLE warm_user_paths ADD COLUMN insert_seq BIGINT DEFAULT nextval('warm_user_paths_insert_seq_seq');
ALTER SEQUENCE warm_user_paths_insert_seq_seq OWNED BY warm_user_paths.insert_seq;
CREATE INDEX IF NOT EXISTS warm_user_paths_insert_seq_idx ON warm_user_paths (insert_seq);
