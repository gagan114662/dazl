export type MemoryKind = "fact" | "lesson" | "preference";

export interface MemoryRow {
  id: number;
  tenantId: string;
  employeeName: string;
  kind: MemoryKind;
  content: string;
  createdAt: number;
}

// Append a durable memory row for a tenant's employee. Every memory is
// tenant-scoped: the write carries tenant_id and every read filters on it,
// so two tenants' employees named identically never share or see each
// other's memories.
export async function rememberFact(
  db: D1Database,
  tenantId: string,
  employeeName: string,
  kind: MemoryKind,
  content: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO memory (tenant_id, employee_name, kind, content) VALUES (?, ?, ?, ?)"
    )
    .bind(tenantId, employeeName, kind, content)
    .run();
}

// Return a tenant's employee's most recent memories, newest first. Filtering
// on (tenant_id, employee_name) — not employee_name alone — is what keeps
// tenant A's memories for "researcher" invisible to tenant B.
export async function recallRecentMemories(
  db: D1Database,
  tenantId: string,
  employeeName: string,
  limit: number
): Promise<MemoryRow[]> {
  const result = await db
    .prepare(
      "SELECT id, tenant_id, employee_name, kind, content, created_at FROM memory " +
        "WHERE tenant_id = ? AND employee_name = ? ORDER BY id DESC LIMIT ?"
    )
    .bind(tenantId, employeeName, limit)
    .all<{
      id: number;
      tenant_id: string;
      employee_name: string;
      kind: MemoryKind;
      content: string;
      created_at: number;
    }>();

  return result.results.map((databaseRow) => ({
    id: databaseRow.id,
    tenantId: databaseRow.tenant_id,
    employeeName: databaseRow.employee_name,
    kind: databaseRow.kind,
    content: databaseRow.content,
    createdAt: databaseRow.created_at,
  }));
}
