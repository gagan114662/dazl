export type MemoryKind = "fact" | "lesson" | "preference";

export interface MemoryRow {
  id: number;
  employeeName: string;
  kind: MemoryKind;
  content: string;
  createdAt: number;
}

// Append a durable memory row for an employee.
export async function rememberFact(
  db: D1Database,
  employeeName: string,
  kind: MemoryKind,
  content: string
): Promise<void> {
  await db
    .prepare("INSERT INTO memory (employee_name, kind, content) VALUES (?, ?, ?)")
    .bind(employeeName, kind, content)
    .run();
}

// Return an employee's most recent memories, newest first.
export async function recallRecentMemories(
  db: D1Database,
  employeeName: string,
  limit: number
): Promise<MemoryRow[]> {
  const result = await db
    .prepare(
      "SELECT id, employee_name, kind, content, created_at FROM memory " +
        "WHERE employee_name = ? ORDER BY id DESC LIMIT ?"
    )
    .bind(employeeName, limit)
    .all<{
      id: number;
      employee_name: string;
      kind: MemoryKind;
      content: string;
      created_at: number;
    }>();

  return result.results.map((databaseRow) => ({
    id: databaseRow.id,
    employeeName: databaseRow.employee_name,
    kind: databaseRow.kind,
    content: databaseRow.content,
    createdAt: databaseRow.created_at,
  }));
}
