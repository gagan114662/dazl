-- Preserve uploaded row order when copying between SQLite and Postgres.
CREATE SEQUENCE IF NOT EXISTS commenter_rows_insert_seq_seq;
ALTER TABLE commenter_rows ADD COLUMN insert_seq BIGINT DEFAULT nextval('commenter_rows_insert_seq_seq');
ALTER SEQUENCE commenter_rows_insert_seq_seq OWNED BY commenter_rows.insert_seq;
CREATE INDEX IF NOT EXISTS commenter_rows_insert_seq_idx ON commenter_rows (insert_seq);
