import migration0001 from "../../migrations/0001_init.sql?raw";
import migration0002 from "../../migrations/0002_multitenancy.sql?raw";
import migration0003 from "../../migrations/0003_cycle_runs.sql?raw";

// Migration files in order, paired with the schema artifact each one leaves
// behind (used to wait out a concurrent apply — see below).
const MIGRATIONS: Array<{ name: string; sql: string; appliedWhen: string }> = [
  {
    name: "0001_init.sql",
    sql: migration0001,
    appliedWhen: "SELECT name FROM sqlite_master WHERE type='table' AND name='employees'",
  },
  {
    name: "0002_multitenancy.sql",
    sql: migration0002,
    appliedWhen:
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants' " +
      "AND (SELECT COUNT(*) FROM pragma_table_info('memory') WHERE name='tenant_id') > 0",
  },
  {
    name: "0003_cycle_runs.sql",
    sql: migration0003,
    appliedWhen:
      "SELECT name FROM sqlite_master WHERE type='table' AND name='cycle_runs'",
  },
];

function splitStatements(sql: string): string[] {
  // `--` comment lines are stripped first (a comment-only fragment would
  // otherwise split into a statement-less chunk D1 rejects), then the SQL is
  // split on ";" and each non-empty statement is returned.
  const stripped = sql.replace(/^\s*--.*$/gm, "");
  return stripped
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

// Applies migrations to a D1 database for tests, exactly once per database
// even when test files run concurrently against the same shared storage
// (vitest config deliberately sets isolatedStorage: false because routes
// tests start real Workflow instances — see the comment there).
//
// `only` restricts the set of migrations applied — used by the cutover test
// to seed 0001-only data and then apply 0002 on top of it.
export async function applyMigrations(db: D1Database, only?: string[]): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
        "name TEXT PRIMARY KEY, " +
        "applied INTEGER NOT NULL DEFAULT 0" +
        ")"
    )
    .run();

  for (const migration of MIGRATIONS) {
    if (only !== undefined && !only.includes(migration.name)) continue;

    const claim = await db
      .prepare("INSERT OR IGNORE INTO schema_migrations (name, applied) VALUES (?, 0)")
      .bind(migration.name)
      .run();

    if (claim.meta.changes === 0) {
      // Another concurrent test file claimed (and is applying, or has
      // applied) this migration. Wait it out rather than re-running it.
      await waitForApplied(db, migration.name, migration.appliedWhen);
      continue;
    }

    const statements = splitStatements(migration.sql).map((statement) => db.prepare(statement));
    statements.push(
      db.prepare("UPDATE schema_migrations SET applied = 1 WHERE name = ?").bind(migration.name)
    );
    await db.batch(statements);
  }
}

// Runs ONE migration's raw SQL statements directly, bypassing the claim
// table — for tests that need to control exactly which migration runs when.
export async function runMigrationStatements(db: D1Database, migrationName: string): Promise<void> {
  const migration = MIGRATIONS.find((entry) => entry.name === migrationName);
  if (migration === undefined) throw new Error(`Unknown migration: ${migrationName}`);
  const statements = splitStatements(migration.sql).map((statement) => db.prepare(statement));
  await db.batch(statements);
}

async function waitForApplied(db: D1Database, migrationName: string, appliedWhen: string): Promise<void> {
  const timeoutMs = 15_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = await db
      .prepare("SELECT applied FROM schema_migrations WHERE name = ?")
      .bind(migrationName)
      .first<{ applied: number }>();

    if (row?.applied === 1) {
      // Defensive: the applied flag flipped — confirm the schema artifact is
      // actually visible to this connection before letting tests proceed.
      const artifact = await db.prepare(appliedWhen).first<{ name: string }>();
      if (artifact !== null) return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for migration ${migrationName} to be applied by a concurrent test file`);
}
