import migration0001 from "../../migrations/0001_init.sql?raw";

// Applies all migration SQL to a D1 database for tests.
// Splits on ";" and runs each non-empty statement.
export async function applyMigrations(db: D1Database): Promise<void> {
  const allMigrationSql = [migration0001].join("\n");
  const statements = allMigrationSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}
