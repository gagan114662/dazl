# dazl Runtime Spine — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the durable runtime spine — a single AI "employee" that persists memory, runs one real Plan→Act→Reflect cycle with durable execution, and can be spawned via HTTP and woken by cron — proving months-long autonomy on Cloudflare before any team/UI is built.

**Architecture:** Extend the existing `clicky-proxy` Cloudflare Worker. An `EmployeeState` **Durable Object** (SQLite-backed) holds each employee's persistent goal. A **D1** database stores durable memory/audit rows. The **cycle logic** (plan/act/reflect) lives in plain, unit-testable functions; an `EmployeeCycle` **Workflow** wraps them in `step.do()` calls for durable, resumable execution. HTTP routes spawn/inspect employees; a **cron trigger** wakes them. Cycle logic is deliberately separated from the Workflow wrapper so it is testable without the Workflows runtime.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects (SQLite storage), Cloudflare Workflows, D1 (SQLite), Wrangler v4, Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- **Runtime platform:** Cloudflare only (Workers/DO/Workflows/D1). No other backend.
- **Wrangler:** `^4.0.0` (Workflows + DO-SQLite require v4).
- **`compatibility_date`:** `"2025-06-01"`; **`compatibility_flags`:** `["nodejs_compat"]`.
- **Durable Objects use SQLite storage** (`new_sqlite_classes`), not the legacy KV backend.
- **Do not break existing proxy routes** `/chat`, `/tts`, `/transcribe-token` — they must keep working.
- **Naming:** optimize for clarity over concision (project convention). No single-char names; full words (e.g. `employeeName`, not `name`). Comments explain *why*.
- **Every task is TDD:** failing test first, minimal code, passing test, commit.
- **Employee identity:** an employee is addressed by a lowercase-kebab `employeeName` string (e.g. `"writer"`), used as the Durable Object name and the D1 `employee_name` key.

---

### Task 1: Project setup — TypeScript, Wrangler v4, Vitest workers pool

**Files:**
- Modify: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/vitest.config.ts`
- Create: `worker/env.d.ts`
- Modify: `worker/wrangler.toml`
- Create: `worker/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces: the `Env` type (in `env.d.ts`) that every later task imports; a working `npm test` command running in the Workers pool.

- [ ] **Step 1: Write the failing smoke test**

Create `worker/test/smoke.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("workers test pool", () => {
  it("boots and exposes bindings", () => {
    expect(env).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `vitest`/`@cloudflare/vitest-pool-workers` not installed (command or import error).

- [ ] **Step 3: Install deps and add the test script**

Replace `worker/package.json` with:

```json
{
  "name": "clicky-proxy",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.9.0",
    "@cloudflare/workers-types": "^4.20250601.0",
    "typescript": "^5.5.0",
    "vitest": "~3.2.0",
    "wrangler": "^4.0.0"
  }
}
```

Then run: `cd worker && npm install`

- [ ] **Step 4: Add TypeScript + Vitest + env config**

Create `worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "env.d.ts"]
}
```

Create `worker/vitest.config.ts`:

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

Create `worker/env.d.ts` (the shared binding types every task imports):

```ts
// Shared environment bindings for the dazl runtime spine.
// Extends the existing proxy secrets with the new runtime bindings.
export interface Env {
  // Existing proxy secrets/vars
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ASSEMBLYAI_API_KEY: string;

  // Runtime spine bindings (added in later tasks' wrangler.toml)
  DB: D1Database;
  EMPLOYEE: DurableObjectNamespace;
  EMPLOYEE_CYCLE: Workflow;
}

// Make `env` from "cloudflare:test" carry our Env type in tests.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
```

- [ ] **Step 5: Point wrangler at the new compatibility settings**

Replace `worker/wrangler.toml` with (bindings are added by later tasks; this sets the floor):

```toml
name = "clicky-proxy"
main = "src/index.ts"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[vars]
ELEVENLABS_VOICE_ID = "kPzsL2i3teMYv0FxEYQ6"
```

- [ ] **Step 6: Run the smoke test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 1 test, `env` defined.

- [ ] **Step 7: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/tsconfig.json worker/vitest.config.ts worker/env.d.ts worker/wrangler.toml worker/test/smoke.test.ts
git commit -m "chore(runtime): set up TypeScript + Vitest workers pool for dazl spine"
```

---

### Task 2: D1 schema + migration for durable memory

**Files:**
- Create: `worker/migrations/0001_init.sql`
- Create: `worker/test/helpers/apply-migrations.ts`
- Create: `worker/test/schema.test.ts`
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Consumes: `Env.DB` from Task 1.
- Produces: the `memory` and `employees` tables; `applyMigrations(db: D1Database): Promise<void>` test helper reused by all later DB tests.

- [ ] **Step 1: Write the failing schema test**

Create `worker/test/schema.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";

describe("D1 schema", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("has a memory table that stores a fact for an employee", async () => {
    await env.DB.prepare(
      "INSERT INTO memory (employee_name, kind, content) VALUES (?, ?, ?)"
    ).bind("writer", "lesson", "threads at 9am beat memes").run();

    const row = await env.DB.prepare(
      "SELECT employee_name, kind, content FROM memory WHERE employee_name = ?"
    ).bind("writer").first<{ employee_name: string; kind: string; content: string }>();

    expect(row?.content).toBe("threads at 9am beat memes");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npm test schema`
Expected: FAIL — `applyMigrations` module not found.

- [ ] **Step 3: Write the migration SQL**

Create `worker/migrations/0001_init.sql`:

```sql
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
```

- [ ] **Step 4: Write the test migration helper**

Create `worker/test/helpers/apply-migrations.ts` (executes the migration SQL statement-by-statement against the test D1):

```ts
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
```

- [ ] **Step 5: Register the D1 binding + migrations dir in wrangler**

Append to `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "dazl"
database_id = "PLACEHOLDER_RUN_WRANGLER_D1_CREATE"
migrations_dir = "migrations"
```

> Note for the operator (not a code placeholder): before `wrangler dev`/`deploy`, run `npx wrangler d1 create dazl` and paste the returned `database_id`. Tests do **not** need a real id — the workers pool provisions an in-memory D1.

- [ ] **Step 6: Run the schema test to verify it passes**

Run: `cd worker && npm test schema`
Expected: PASS — inserts and reads back the memory row.

- [ ] **Step 7: Commit**

```bash
git add worker/migrations/0001_init.sql worker/test/helpers/apply-migrations.ts worker/test/schema.test.ts worker/wrangler.toml
git commit -m "feat(runtime): add D1 schema for employees + durable memory"
```

---

### Task 3: Memory data-access layer

**Files:**
- Create: `worker/src/runtime/memory.ts`
- Create: `worker/test/memory.test.ts`

**Interfaces:**
- Consumes: `Env.DB`; `applyMigrations` (Task 2).
- Produces:
  - `rememberFact(db: D1Database, employeeName: string, kind: MemoryKind, content: string): Promise<void>`
  - `recallRecentMemories(db: D1Database, employeeName: string, limit: number): Promise<MemoryRow[]>`
  - types `MemoryKind = "fact" | "lesson" | "preference"` and `MemoryRow = { id: number; employeeName: string; kind: MemoryKind; content: string; createdAt: number }`

- [ ] **Step 1: Write the failing test**

Create `worker/test/memory.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import { rememberFact, recallRecentMemories } from "../src/runtime/memory";

describe("memory DAL", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("stores and recalls newest-first", async () => {
    await rememberFact(env.DB, "analyst", "fact", "site has 12 blog posts");
    await rememberFact(env.DB, "analyst", "lesson", "long posts rank better");

    const memories = await recallRecentMemories(env.DB, "analyst", 10);

    expect(memories.length).toBe(2);
    expect(memories[0].content).toBe("long posts rank better"); // newest first
    expect(memories[0].kind).toBe("lesson");
    expect(memories[0].employeeName).toBe("analyst");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npm test memory`
Expected: FAIL — `../src/runtime/memory` not found.

- [ ] **Step 3: Write the DAL**

Create `worker/src/runtime/memory.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd worker && npm test memory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/runtime/memory.ts worker/test/memory.test.ts
git commit -m "feat(runtime): add memory data-access layer"
```

---

### Task 4: EmployeeState Durable Object (persistent goal)

**Files:**
- Create: `worker/src/runtime/employee-state.ts`
- Create: `worker/test/employee-state.test.ts`
- Modify: `worker/wrangler.toml`
- Modify: `worker/src/index.ts` (re-export the DO class)

**Interfaces:**
- Consumes: `Env.EMPLOYEE` (Durable Object namespace).
- Produces: the `EmployeeState` DO with RPC methods `setGoal(goal: string): Promise<void>` and `getGoal(): Promise<string | null>`. Addressed via `env.EMPLOYEE.idFromName(employeeName)`.

- [ ] **Step 1: Write the failing test**

Create `worker/test/employee-state.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("EmployeeState DO", () => {
  it("persists a goal per employee via RPC", async () => {
    const id = env.EMPLOYEE.idFromName("writer");
    const stub = env.EMPLOYEE.get(id);

    await stub.setGoal("write a launch post");
    const goal = await stub.getGoal();

    expect(goal).toBe("write a launch post");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npm test employee-state`
Expected: FAIL — DO class not exported / `EMPLOYEE` binding missing.

- [ ] **Step 3: Write the Durable Object**

Create `worker/src/runtime/employee-state.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";

// One instance per employee. Holds the employee's live goal in durable
// storage so it survives restarts, evictions, and multi-day sleeps.
export class EmployeeState extends DurableObject<Env> {
  async setGoal(goal: string): Promise<void> {
    await this.ctx.storage.put("goal", goal);
  }

  async getGoal(): Promise<string | null> {
    const goal = await this.ctx.storage.get<string>("goal");
    return goal ?? null;
  }
}
```

> Note: `import type { Env } from "../../env"` — create a re-export shim so the path resolves. In Step 4 also add `export type { Env } from "../env";` handling. (Simplest: change the import to `import type { Env } from "../../env.d";` is invalid; instead move `Env` into a real module — see Step 4.)

- [ ] **Step 4: Make `Env` importable from a real module**

Create `worker/src/runtime/env.ts`:

```ts
// Re-export the ambient Env as a real, importable type module.
export interface Env {
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ASSEMBLYAI_API_KEY: string;
  DB: D1Database;
  EMPLOYEE: DurableObjectNamespace<import("./employee-state").EmployeeState>;
  EMPLOYEE_CYCLE: Workflow;
}
```

Then fix the import in `worker/src/runtime/employee-state.ts` to:

```ts
import type { Env } from "./env";
```

And update `worker/env.d.ts` to re-use it so tests and runtime agree — replace its `Env` interface body with:

```ts
export type { Env } from "./src/runtime/env";
```

(Keep the `declare module "cloudflare:test"` block, importing `Env` from `./src/runtime/env`.)

- [ ] **Step 5: Register the DO binding + migration in wrangler**

Append to `worker/wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "EMPLOYEE"
class_name = "EmployeeState"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["EmployeeState"]
```

- [ ] **Step 6: Re-export the DO from the Worker entrypoint**

Add to the TOP of `worker/src/index.ts` (Durable Object classes must be exported from the main module):

```ts
export { EmployeeState } from "./runtime/employee-state";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd worker && npm test employee-state`
Expected: PASS — goal persisted and read back via RPC.

- [ ] **Step 8: Commit**

```bash
git add worker/src/runtime/employee-state.ts worker/src/runtime/env.ts worker/env.d.ts worker/wrangler.toml worker/src/index.ts worker/test/employee-state.test.ts
git commit -m "feat(runtime): add EmployeeState durable object with persistent goal"
```

---

### Task 5: The cycle logic (Plan → Act → Reflect), unit-testable

**Files:**
- Create: `worker/src/runtime/cycle.ts`
- Create: `worker/test/cycle.test.ts`

**Interfaces:**
- Consumes: `rememberFact` (Task 3); `Env` (Task 4).
- Produces:
  - `planNextAction(goal: string | null): { action: "research"; query: string }`
  - `act(action: { action: "research"; query: string }, fetchImpl?: typeof fetch): Promise<string>` — performs a REAL HTTP GET and returns an observation string.
  - `reflect(env: Env, employeeName: string, observation: string): Promise<void>` — persists a lesson to D1.
  - `runEmployeeCycle(env: Env, employeeName: string, fetchImpl?: typeof fetch): Promise<string>` — orchestrates the three, returns the observation. (The Workflow in Task 6 calls these individually inside `step.do`.)

- [ ] **Step 1: Write the failing test**

Create `worker/test/cycle.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import { planNextAction, runEmployeeCycle } from "../src/runtime/cycle";
import { recallRecentMemories } from "../src/runtime/memory";

describe("employee cycle", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("plans a research action from a goal", () => {
    const action = planNextAction("grow dazl.ai on X");
    expect(action.action).toBe("research");
    expect(action.query.length).toBeGreaterThan(0);
  });

  it("runs a full cycle and persists a lesson from a real fetch", async () => {
    // Inject a fake fetch so the test is deterministic (real signature).
    const fakeFetch = (async () =>
      new Response("Example Domain — reference content")) as typeof fetch;

    const observation = await runEmployeeCycle(env, "researcher", fakeFetch);

    expect(observation).toContain("Example Domain");

    const memories = await recallRecentMemories(env.DB, "researcher", 5);
    expect(memories.length).toBe(1);
    expect(memories[0].kind).toBe("lesson");
    expect(memories[0].content).toContain("Example Domain");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npm test cycle`
Expected: FAIL — `../src/runtime/cycle` not found.

- [ ] **Step 3: Write the cycle logic**

Create `worker/src/runtime/cycle.ts`:

```ts
import type { Env } from "./env";
import { rememberFact } from "./memory";

export type PlannedAction = { action: "research"; query: string };

// PLAN: decide the next action from the current goal.
// Phase 1 always researches; later phases add real Claude-driven planning.
export function planNextAction(goal: string | null): PlannedAction {
  const query = goal ?? "what should dazl.ai talk about";
  return { action: "research", query };
}

// ACT: perform a REAL http request and return an observation string.
// fetchImpl is injectable so tests stay deterministic; defaults to global fetch.
export async function act(
  action: PlannedAction,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl("https://example.com/");
  const body = await response.text();
  return body.slice(0, 500);
}

// REFLECT: turn the observation into a durable lesson in D1.
export async function reflect(
  env: Env,
  employeeName: string,
  observation: string
): Promise<void> {
  const lesson = `Observed while researching: ${observation.slice(0, 200)}`;
  await rememberFact(env.DB, employeeName, "lesson", lesson);
}

// Orchestrate one full cycle. The Workflow (Task 6) calls the three
// functions individually inside step.do() for durability; this helper
// keeps the logic testable outside the Workflows runtime.
export async function runEmployeeCycle(
  env: Env,
  employeeName: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const stubId = env.EMPLOYEE.idFromName(employeeName);
  const goal = await env.EMPLOYEE.get(stubId).getGoal();

  const action = planNextAction(goal);
  const observation = await act(action, fetchImpl);
  await reflect(env, employeeName, observation);
  return observation;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd worker && npm test cycle`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/runtime/cycle.ts worker/test/cycle.test.ts
git commit -m "feat(runtime): add plan/act/reflect cycle logic"
```

---

### Task 6: EmployeeCycle Workflow (durable execution wrapper)

**Files:**
- Create: `worker/src/runtime/employee-cycle-workflow.ts`
- Modify: `worker/src/index.ts` (re-export Workflow)
- Modify: `worker/wrangler.toml`
- Create: `worker/test/workflow-wiring.test.ts`

**Interfaces:**
- Consumes: `planNextAction`, `act`, `reflect` (Task 5); `Env.EMPLOYEE_CYCLE`.
- Produces: the `EmployeeCycle` Workflow class; params shape `{ employeeName: string }`. Started via `env.EMPLOYEE_CYCLE.create({ params: { employeeName } })`.

- [ ] **Step 1: Write the failing wiring test**

Create `worker/test/workflow-wiring.test.ts` (verifies the binding exists and accepts a create call; the durable run itself is exercised via the cycle unit tests + the manual verification in Task 8):

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("EmployeeCycle workflow binding", () => {
  it("exposes a create() method on the workflow binding", () => {
    expect(typeof env.EMPLOYEE_CYCLE.create).toBe("function");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npm test workflow-wiring`
Expected: FAIL — `EMPLOYEE_CYCLE` binding undefined.

- [ ] **Step 3: Write the Workflow**

Create `worker/src/runtime/employee-cycle-workflow.ts`:

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { planNextAction, act, reflect } from "./cycle";

export interface EmployeeCycleParams {
  employeeName: string;
}

// Durable wrapper around the cycle logic. Each step.do() checkpoints, so a
// crash resumes mid-cycle instead of restarting. step.sleep lets an employee
// idle for days between cycles without holding any compute.
export class EmployeeCycle extends WorkflowEntrypoint<Env, EmployeeCycleParams> {
  async run(event: WorkflowEvent<EmployeeCycleParams>, step: WorkflowStep): Promise<void> {
    const { employeeName } = event.payload;

    const goal = await step.do("plan: read goal", async () => {
      const stubId = this.env.EMPLOYEE.idFromName(employeeName);
      return await this.env.EMPLOYEE.get(stubId).getGoal();
    });

    const observation = await step.do("act: research", async () => {
      const action = planNextAction(goal);
      return await act(action);
    });

    await step.do("reflect: persist lesson", async () => {
      await reflect(this.env, employeeName, observation);
    });
  }
}
```

- [ ] **Step 4: Register the Workflow binding in wrangler**

Append to `worker/wrangler.toml`:

```toml
[[workflows]]
name = "employee-cycle"
binding = "EMPLOYEE_CYCLE"
class_name = "EmployeeCycle"
```

- [ ] **Step 5: Re-export the Workflow from the entrypoint**

Add near the top of `worker/src/index.ts` (below the DO export):

```ts
export { EmployeeCycle } from "./runtime/employee-cycle-workflow";
```

- [ ] **Step 6: Run the wiring test to verify it passes**

Run: `cd worker && npm test workflow-wiring`
Expected: PASS — `create` is a function.

- [ ] **Step 7: Commit**

```bash
git add worker/src/runtime/employee-cycle-workflow.ts worker/src/index.ts worker/wrangler.toml worker/test/workflow-wiring.test.ts
git commit -m "feat(runtime): add EmployeeCycle durable workflow"
```

---

### Task 7: HTTP spawn/inspect routes + cron wake

**Files:**
- Modify: `worker/src/index.ts`
- Create: `worker/src/runtime/routes.ts`
- Create: `worker/test/routes.test.ts`

**Interfaces:**
- Consumes: everything above (`EMPLOYEE`, `EMPLOYEE_CYCLE`, `recallRecentMemories`).
- Produces:
  - `POST /employees` body `{ employeeName, role, goal }` → sets DO goal, upserts `employees` row, starts a cycle workflow. Returns `{ started: true }`.
  - `GET /employees/:employeeName` → `{ employeeName, goal, memories }`.
  - `scheduled` handler that wakes every known employee by starting a cycle.

- [ ] **Step 1: Write the failing routes test**

Create `worker/test/routes.test.ts`:

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import worker from "../src/index";

describe("employee routes", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("spawns an employee and reads it back", async () => {
    const spawn = new Request("https://x/employees", {
      method: "POST",
      body: JSON.stringify({ employeeName: "writer", role: "Writer", goal: "write launch post" }),
    });
    const ctx = createExecutionContext();
    const spawnResponse = await worker.fetch(spawn, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(spawnResponse.status).toBe(200);

    const inspect = new Request("https://x/employees/writer", { method: "GET" });
    const ctx2 = createExecutionContext();
    const inspectResponse = await worker.fetch(inspect, env, ctx2);
    await waitOnExecutionContext(ctx2);
    const data = await inspectResponse.json<{ goal: string; employeeName: string }>();

    expect(data.employeeName).toBe("writer");
    expect(data.goal).toBe("write launch post");
  });

  it("keeps the existing proxy 404 for unknown routes", async () => {
    const req = new Request("https://x/nope", { method: "GET" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd worker && npm test routes`
Expected: FAIL — `/employees` route not handled (404 on spawn).

- [ ] **Step 3: Write the route handlers**

Create `worker/src/runtime/routes.ts`:

```ts
import type { Env } from "./env";
import { recallRecentMemories } from "./memory";

// POST /employees — hire/assign an employee and start its first cycle.
export async function handleSpawnEmployee(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ employeeName: string; role: string; goal: string }>();

  const stubId = env.EMPLOYEE.idFromName(body.employeeName);
  await env.EMPLOYEE.get(stubId).setGoal(body.goal);

  await env.DB.prepare(
    "INSERT INTO employees (employee_name, role, goal) VALUES (?, ?, ?) " +
      "ON CONFLICT(employee_name) DO UPDATE SET role = excluded.role, goal = excluded.goal"
  ).bind(body.employeeName, body.role, body.goal).run();

  await env.EMPLOYEE_CYCLE.create({ params: { employeeName: body.employeeName } });

  return Response.json({ started: true });
}

// GET /employees/:employeeName — inspect goal + recent memories.
export async function handleInspectEmployee(employeeName: string, env: Env): Promise<Response> {
  const stubId = env.EMPLOYEE.idFromName(employeeName);
  const goal = await env.EMPLOYEE.get(stubId).getGoal();
  const memories = await recallRecentMemories(env.DB, employeeName, 20);
  return Response.json({ employeeName, goal, memories });
}

// Cron wake: start a cycle for every known employee.
export async function wakeAllEmployees(env: Env): Promise<void> {
  const result = await env.DB.prepare("SELECT employee_name FROM employees").all<{
    employee_name: string;
  }>();
  for (const row of result.results) {
    await env.EMPLOYEE_CYCLE.create({ params: { employeeName: row.employee_name } });
  }
}
```

- [ ] **Step 4: Wire routes + scheduled into the entrypoint**

Modify `worker/src/index.ts` — change the exported default object to add the new routes BEFORE the final 404, and add a `scheduled` handler. The full new default export:

```ts
import type { Env } from "./runtime/env";
import { handleSpawnEmployee, handleInspectEmployee, wakeAllEmployees } from "./runtime/routes";

// (existing `export { EmployeeState } ...` and `export { EmployeeCycle } ...` stay at top)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- dazl runtime routes ---
    if (url.pathname === "/employees" && request.method === "POST") {
      return await handleSpawnEmployee(request, env);
    }
    const inspectMatch = url.pathname.match(/^\/employees\/([a-z0-9-]+)$/);
    if (inspectMatch && request.method === "GET") {
      return await handleInspectEmployee(inspectMatch[1], env);
    }

    // --- existing proxy routes (POST only) ---
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    try {
      if (url.pathname === "/chat") return await handleChat(request, env);
      if (url.pathname === "/tts") return await handleTTS(request, env);
      if (url.pathname === "/transcribe-token") return await handleTranscribeToken(env);
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await wakeAllEmployees(env);
  },
};
```

Keep the existing `handleChat`, `handleTTS`, `handleTranscribeToken` functions and the `Env` import consistent (they now use `Env` from `./runtime/env`). Remove the old inline `interface Env {...}` from `index.ts` if present.

- [ ] **Step 5: Register the cron trigger in wrangler**

Append to `worker/wrangler.toml`:

```toml
[triggers]
crons = ["0 * * * *"]
```

- [ ] **Step 6: Run the routes test to verify it passes**

Run: `cd worker && npm test routes`
Expected: PASS — spawn returns 200, inspect returns the goal, unknown route still 404.

- [ ] **Step 7: Run the FULL suite (no regressions)**

Run: `cd worker && npm test`
Expected: PASS — all tests from Tasks 1–7 green.

- [ ] **Step 8: Commit**

```bash
git add worker/src/index.ts worker/src/runtime/routes.ts worker/wrangler.toml worker/test/routes.test.ts
git commit -m "feat(runtime): add employee spawn/inspect routes + cron wake"
```

---

### Task 8: Manual durability verification (proof of life)

**Files:**
- Create: `worker/RUNTIME_VERIFY.md` (records the manual proof)

**Interfaces:**
- Consumes: the deployed/dev Worker.
- Produces: written evidence that memory persists across restarts and the cron path works — the Phase-1 success criterion.

- [ ] **Step 1: Create the D1 database (operator action)**

Run: `cd worker && npx wrangler d1 create dazl`
Paste the returned `database_id` into `worker/wrangler.toml`'s `[[d1_databases]]` block (replacing the placeholder), then apply migrations locally:
Run: `npx wrangler d1 migrations apply dazl --local`

- [ ] **Step 2: Run the Worker locally**

Run: `cd worker && npx wrangler dev`
Expected: starts on `http://localhost:8787` with no binding errors.

- [ ] **Step 3: Spawn an employee**

Run: `curl -s -X POST localhost:8787/employees -d '{"employeeName":"researcher","role":"Analyst","goal":"study dazl.ai market"}'`
Expected: `{"started":true}`

- [ ] **Step 4: Confirm a memory was persisted by the cycle**

Wait ~5s, then run: `curl -s localhost:8787/employees/researcher`
Expected: JSON with `"goal":"study dazl.ai market"` and a non-empty `memories` array whose newest entry is a `lesson`.

- [ ] **Step 5: Prove persistence across restart**

Stop `wrangler dev` (Ctrl-C), restart it (`npx wrangler dev`), then re-run:
`curl -s localhost:8787/employees/researcher`
Expected: the goal and memories are STILL there (DO + D1 persisted to local storage) — this is the durability proof.

- [ ] **Step 6: Record the evidence**

Create `worker/RUNTIME_VERIFY.md` documenting the three curl outputs (spawn, inspect, inspect-after-restart) with timestamps, confirming memory survived a restart.

- [ ] **Step 7: Commit**

```bash
git add worker/RUNTIME_VERIFY.md worker/wrangler.toml
git commit -m "test(runtime): document Phase 1 durability verification"
```

---

## Self-Review

**Spec coverage (against §6, §7.1, §13-Phase-1):**
- Durable Objects (per-employee state) → Task 4 ✅
- Cloudflare Workflows (durable Plan→Act→Reflect) → Tasks 5–6 ✅
- Cron Triggers (wake employees) → Task 7 ✅
- D1 (structured memory) → Tasks 2–3 ✅
- Plan→Act→Observe→Reflect loop → Task 5 (Observe folded into Act's return; explicit Observe/metrics is Phase 2) ✅
- "One trivial durable employee that survives restarts + does a real research step + persists memory" → Tasks 5–8 ✅
- KV / R2 / Queues → **deliberately deferred**: not needed for the Phase-1 proof (memory fits D1+DO; no creatives yet; single-employee needs no queue). Logged here so the omission is intentional, not forgotten.
- Taste gate, Brand Brain, browser superpower, sales/intent, the blob UI → later phases, out of scope for the spine.

**Placeholder scan:** The only `PLACEHOLDER` is the D1 `database_id`, which is an operator secret filled by `wrangler d1 create` (Task 8, Step 1) — not a code gap. Tests don't need it.

**Type consistency:** `employeeName: string` used everywhere; `getGoal(): Promise<string | null>`; `rememberFact(db, employeeName, kind, content)` and `recallRecentMemories(db, employeeName, limit)` match across Tasks 3, 5, 7; `EmployeeCycleParams = { employeeName }` matches the `.create({ params })` calls in Tasks 6–7. `Env` is defined once in `src/runtime/env.ts` and imported everywhere.

**Known execution risks (flag for the implementer):** exact API surfaces for `@cloudflare/vitest-pool-workers`, DO RPC, and Workflows evolve across versions — if an import path or method name mismatches the installed version, consult the version's docs and adjust; the test-first structure will surface any mismatch immediately at Step 2 of each task.
