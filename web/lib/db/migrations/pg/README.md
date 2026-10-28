# Postgres migrations

Applied in order by `npm run db:migrate` (`scripts/db-migrate.mts` → `lib/db/migrate-pg.ts`) when `DATABASE_URL` is set. Each file runs in its own transaction and is recorded in `dazl_schema_migrations` with a checksum. The run holds an advisory lock, so two instances deploying at once are safe.

SQLite is the runtime store until the owner authorizes cutover (`docs/PLATFORM.md`). Its tables are still created by each module's `migrate*()` at startup.

## When you change a table in a module's `migrate*()`

1. Regenerate the schema files (from `web/`):
   ```sh
   EXTRACT_OUT=/tmp/full node --experimental-strip-types scripts/pg-migrate/extract-schema.ts
   SQLITE_SCHEMA=/tmp/full.sql PG_SCHEMA_OUT=scripts/pg-migrate/schema-full.generated.sql \
     PG_SLICE_SCHEMA_OUT=/tmp/slice.sql PG_MIGRATION_OUT=/tmp/migration.sql \
     node --experimental-strip-types scripts/pg-migrate/translate-schema.ts
   cp /tmp/full.sql scripts/pg-migrate/schema-sqlite-reference.generated.sql
   ```
2. Add `NNNN_short_name.sql` here, using the next number, with the Postgres DDL for the change (for example `ALTER TABLE … ADD COLUMN …`). `/tmp/migration.sql` shows the translated form.
3. Never edit an applied file. Its checksum would change and `db:migrate` would refuse to run.

`test/pg-schema-drift.test.ts` fails when the committed generated files are stale. In the CI postgres job, it also fails when applying every migration here does not produce the same tables, columns, constraints, indexes and triggers as today's translation.

`0001_baseline.sql` is the generated translation of every SQLite table as of this PR. No database has applied it yet. Until the first real PG deploy, it may be regenerated in place. After that, it is frozen.
