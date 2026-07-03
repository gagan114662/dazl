-- Employees: the roster. One row per AI employee.
CREATE TABLE IF NOT EXISTS employees (
  employee_name TEXT PRIMARY KEY,
  role          TEXT NOT NULL,
  goal          TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Memory: durable facts/lessons an employee learns. Append-only.
CREATE TABLE IF NOT EXISTS memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_name TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- 'fact' | 'lesson' | 'preference'
  content       TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_memory_employee ON memory (employee_name);
