-- MISSION v2 part E: the nightly per-city x category refresh table. DESIGN ONLY (Hermes 02:28: no cron on prod tonight, freeze until 07:00).
-- NOT APPLIED: this file is outside lib/db/migrations/pg and no migrate*() creates it. Wiring it is one later PR:
--   1. the Postgres DDL below as lib/db/migrations/pg/00NN_registry_refresh.sql (next free number; ~/work/migration_claims.txt),
--   2. its SQLite twin (same columns, INTEGER for BIGINT) as migrateRegistryRefresh() in migrateAllSqlite, the schema files regenerated,
--   3. a nightly job (lib/scheduler) that runs every RegistrySource for every market in registry_markets and upserts here,
--   4. huntWithRegistry reading the stored candidates first (fresh: refreshed_at inside 26 h) and calling the source live only on a miss.
--
-- Why a table: every source is a free public API, but a scan should not wait 15 s on EDGAR's fair-access pace or re-read the same city's
-- permits for every tenant. The rows are public records only (no tenant, no lead, no person beyond what the public record names), so the
-- table is platform-level, like the search cache: never tenant-scoped, never erased with a tenant, readable by every tenant's scan.
--
-- Reads are by primary key (source, market_key): indexed, no scan. The nightly job's "what is stale" read uses the refreshed_at index.

-- Which markets the nightly job refreshes: a market enters when a scan asks for it (the first scan reads live), and leaves after 30 days
-- with no scan (last_asked_at), so the nightly cost follows real demand.
CREATE TABLE registry_markets (
    market_key     TEXT NOT NULL PRIMARY KEY,      -- 'austin texas|roofing contractors' (the case's where|category, lower-cased, spaces folded)
    where_text     TEXT NOT NULL,                  -- the case's where, as asked ("Austin, Texas")
    category_text  TEXT NOT NULL,                  -- the case's category, as asked ("roofing contractors")
    window_days    INTEGER NOT NULL DEFAULT 90,
    first_asked_at BIGINT NOT NULL,
    last_asked_at  BIGINT NOT NULL
  );
CREATE INDEX registry_markets_last_asked ON registry_markets (last_asked_at);

-- One row per (source, market): the last refresh's candidates (A's Candidate[] as JSON, public-record facts only) and how it went.
-- A failed refresh keeps the previous good candidates (candidates_json untouched) and records the failure, so one bad night never empties
-- a market; a scan sees the age (refreshed_ok_at) and the failure note.
CREATE TABLE registry_refresh (
    source            TEXT NOT NULL,               -- RegistrySource.id: 'socrata-permits:austin', 'opendatasoft-licences:vancouver', 'sec-form-d'
    market_key        TEXT NOT NULL REFERENCES registry_markets (market_key) ON DELETE CASCADE,
    since             TEXT NOT NULL,               -- the window start the candidates were collected for (YYYY-MM-DD)
    candidates_json   TEXT NOT NULL DEFAULT '[]',
    candidates        INTEGER NOT NULL DEFAULT 0,
    notes_json        TEXT NOT NULL DEFAULT '[]',  -- the source's notes on the last attempt ('throttled', 'renewals_unknown', ...)
    status            TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
    refreshed_at      BIGINT NOT NULL,             -- last attempt
    refreshed_ok_at   BIGINT,                      -- last good attempt (NULL: never)
    seconds           INTEGER,
    PRIMARY KEY (source, market_key)
  );
CREATE INDEX registry_refresh_refreshed_at ON registry_refresh (refreshed_at);
