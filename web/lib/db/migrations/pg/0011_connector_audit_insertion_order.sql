-- connector_audit joins the insertion-order tables (lib/db/insertion-order.ts, 0010): the settings audit list breaks
-- same-second ties by insert_seq, the order SQLite's rowid gave.

CREATE SEQUENCE IF NOT EXISTS connector_audit_insert_seq_seq;
ALTER TABLE connector_audit ADD COLUMN insert_seq BIGINT DEFAULT nextval('connector_audit_insert_seq_seq');
ALTER SEQUENCE connector_audit_insert_seq_seq OWNED BY connector_audit.insert_seq;
CREATE INDEX IF NOT EXISTS connector_audit_insert_seq_idx ON connector_audit (insert_seq);
