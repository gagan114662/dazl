# dazl Sandbox Brain — Phase 2 (Slice 1), swamp-native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the live dazl employee a real brain: inside a Cloudflare **Sandbox** container, **Claude Code does the capability work** (research/writing via its own tools) on the owner's Claude **subscription** (not a metered API key), and **swamp provides the structure** — the action is a swamp **workflow**, the capability a swamp `command/shell` **model** that invokes `claude -p`, and Claude's output is captured as a swamp **versioned artifact**. All on Cloudflare.

**Division of labor (decided):** *swamp for structure, Claude Code for capability.* swamp has no built-in marketing capability, so Claude Code (in-container, subscription-billed) performs the research/writing; swamp wraps that invocation as a `command/shell` model, versions the output as an immutable artifact, and (in a later slice) gates public actions with its native manual-approval workflow step.

**Architecture:**
- **Durable spine (Cloudflare, already deployed & unchanged):** Worker + `EmployeeState` Durable Object + `EmployeeCycle` Workflow + D1 + cron — the permanent orchestrator, state store, scheduler.
- **swamp brain (Sandbox container, per-cycle, subscription-billed):** a Linux image with `claude` CLI + `swamp` + a seeded swamp repo. Each cycle runs one swamp workflow whose step invokes `claude -p`; swamp versions the result.
- **Bridge:** the `EmployeeCycle` Workflow calls `brain.runResearchCycle()`, which execs into the Sandbox, hydrates `/brain` from **R2**, runs the swamp workflow, reads back the versioned artifact, syncs the repo to R2, and returns the artifact; the spine persists a Claude-reflected lesson to D1.

## Resolved facts (verified against the installed binaries/docs — build to these)

**`@cloudflare/sandbox` (npm v0.12.3):**
- `import { getSandbox } from "@cloudflare/sandbox"`; `getSandbox(binding, id)`; container starts lazily on first op.
- `sandbox.exec(command: string, options?)` — **command is a SINGLE shell string** (NOT `(cmd, args[])`). Options: `{ cwd, env, timeout }`. Returns `{ success, stdout, stderr, exitCode }`. → the command builder must produce a properly **shell-escaped** string.
- Files: `writeFile(path, content, { encoding: "base64" })`, `readFile(path, { encoding: "base64" })` for binary (the R2 tar).
- wrangler: `[[containers]]` (`class_name`, `image`, `instance_type`, `max_instances`), `[[durable_objects.bindings]]`, `[[migrations]] new_sqlite_classes`. Worker entry must `export { Sandbox } from "@cloudflare/sandbox"`.
- Instance sizing: image size = instance disk (2–20 GB; 50 GB account cap) → **a 215 MB swamp binary + Node + Claude Code fits easily; no vendoring needed.** Use an `instance_type` with ≥1 GiB RAM (e.g. `standard-1`) so swamp + Claude have headroom (not `lite`'s 256 MiB). Cold start ~1–3s + CLI init; hourly cron ⇒ fresh cold start (expected, cheap).

**swamp CLI (installed build):**
- Built-in model type (only one): **`command/shell`** — method `execute`, inputs `run`(string, required)/`workingDir`/`timeout`/`env`(object)/`ignoreExitCode`; outputs `result`(resource, structured: `command`/`exitCode`/`stdout`/`stderr`) + **`log`(file, text/plain, versioned)**. A generated model instance is minimal (`type`/`name`/`methods: {}`); `run` + `env` are supplied at call time (workflow `with:`).
- `swamp --no-telemetry workflow run <name> --input key=value --json`; **`--stdin`** reads inputs as piped JSON (`echo '{"task":"…"}' | swamp workflow run <name> --stdin`).
- Read artifacts: `swamp --no-telemetry data get <workflow_or_model> [data_name] --json` / `swamp data list <workflow> --json`.
- Repo dir is set via **`SWAMP_REPO_DIR`** env (the `--repo-dir` flag is not accepted on all subcommands). Model definitions land in `models/command/shell/<uuid>.yaml`.

**Shell-injection: RESOLVED by construction, and proven.** The task is never interpolated into a shell string. Two boundaries, both made inert:
- **Worker → swamp:** inputs pass via **`--stdin`** JSON (`sandbox.exec("swamp … --stdin …", { stdin: JSON.stringify({ task }) })`), so the task is never in the exec command string.
- **swamp → shell:** the `command/shell` step passes the task as an **`env` var** (`env: { AGENT_TASK: "{{ inputs.task }}" }`) and the `run` command references `"$AGENT_TASK"` — a static command. Verified experimentally: a payload `innocent"; touch /tmp/pwned; echo "x` passed via `env` was echoed as **literal text**, the `touch` did **not** run, and no marker file was created (`status: succeeded`, `command` recorded as the static `echo "researching: $AGENT_TASK"`). No escaping is relied upon; shell metacharacters are inert data.

## Global Constraints

- **swamp for structure, Claude for capability** (decided). Capability = `claude -p` inside a swamp `command/shell` model; action = swamp workflow; artifact = swamp versioned `log` output.
- **Cloudflare only** (Sandbox container, not external host). **Subscription billing** via `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), a Worker secret — never committed.
- **Do NOT break Phase 1** (routes, 17 tests, auth guard, durability).
- **Wrangler `^4`**, `compatibility_date = "2025-06-01"`, `compatibility_flags = ["nodejs_compat"]`. Builds via OrbStack (`docker` 29.4.0).
- **Naming:** clarity over concision, no single-char names. **TDD** where the workers pool can test; container/swamp execution proven by documented live verification (Task 5), never faked. Requires a Claude **Max** plan for realistic cadence; think hourly, not continuously.

---

### Task 1: Sandbox container image = Claude Code + swamp + seeded repo

**Files:**
- Create: `worker/Dockerfile`
- Create: `worker/brain-repo/` (seeded swamp repo: `.swamp.yaml`, `AGENTS.md`, `models/`, `workflows/`)
- Modify: `worker/package.json` (+ `@cloudflare/sandbox`)
- Modify: `worker/wrangler.toml` (container + Sandbox DO + R2)
- Modify: `worker/src/index.ts` (re-export `Sandbox`)
- Modify: `worker/src/runtime/env.ts` (+`SANDBOX`, `CLAUDE_CODE_OAUTH_TOKEN`, `BRAIN_REPO`)
- Modify: `worker/vitest.config.ts` (dummy bindings)
- Create: `worker/test/sandbox-binding.test.ts`

**Interfaces:**
- Produces: `Env.SANDBOX: DurableObjectNamespace<Sandbox>`, `Env.CLAUDE_CODE_OAUTH_TOKEN: string`, `Env.BRAIN_REPO: R2Bucket`; a deployable image with `claude` + `swamp` + a seeded swamp repo.

- [ ] **Step 1: Failing binding test**

Create `worker/test/sandbox-binding.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Sandbox + brain bindings", () => {
  it("exposes SANDBOX and BRAIN_REPO", () => {
    expect(env.SANDBOX).toBeDefined();
    expect(typeof env.SANDBOX.idFromName).toBe("function");
    expect(env.BRAIN_REPO).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd worker && npm test sandbox-binding` → FAIL (`env.SANDBOX` undefined).

- [ ] **Step 3: Add dependency** — `cd worker && npm install @cloudflare/sandbox@^0.12.3`.

- [ ] **Step 4: Seed the swamp repo**

In a scratch dir run `swamp init --tool claude`; copy the generated `.swamp.yaml`, `AGENTS.md`, and empty `models/` + `workflows/` dirs into `worker/brain-repo/`. Commit them (deterministic seed; runtime repo hydrates from R2 on top).

- [ ] **Step 5: Dockerfile**

Create `worker/Dockerfile`:

```dockerfile
# Cloudflare Sandbox runtime base (SDK controls the entrypoint).
FROM docker.io/cloudflare/sandbox:0.12.3

# Claude Code CLI — the capability/reasoning agent (subscription-authed at runtime).
RUN npm install -g @anthropic-ai/claude-code

# swamp CLI — deterministic structure: workflows, versioned artifacts, approvals.
RUN curl -fsSL https://swamp-club.com/install.sh | sh \
    && install -m 0755 /root/.local/bin/swamp /usr/local/bin/swamp

# Seed the swamp repo scaffold.
COPY brain-repo/ /brain/
WORKDIR /brain
```

> Match the base image tag to the installed `@cloudflare/sandbox` version. If piping the installer at build time is undesirable, vendor the `swamp` binary into `worker/brain-repo/bin/` and `COPY` it — record which was used.

- [ ] **Step 6: wrangler config**

Append to `worker/wrangler.toml`:

```toml
[[containers]]
class_name = "Sandbox"
image = "./Dockerfile"
instance_type = "standard-1"
max_instances = 1

[[durable_objects.bindings]]
name = "SANDBOX"
class_name = "Sandbox"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["Sandbox"]

[[r2_buckets]]
binding = "BRAIN_REPO"
bucket_name = "dazl-brain-repo"

# CLAUDE_CODE_OAUTH_TOKEN set via: npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
```

> If `standard-1` is not a valid instance type name for the account, run `npx wrangler containers` help / docs to pick the nearest ≥1 GiB-RAM type; record it.

- [ ] **Step 7: Re-export + extend Env**

Top of `worker/src/index.ts`: `export { Sandbox } from "@cloudflare/sandbox";`
In `worker/src/runtime/env.ts` `Env`:

```ts
  SANDBOX: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  BRAIN_REPO: R2Bucket;
```

- [ ] **Step 8: Dummy test bindings** — in `worker/vitest.config.ts` `miniflare` block add `CLAUDE_CODE_OAUTH_TOKEN: "test-token"` and an R2 bucket for `BRAIN_REPO` (per the installed pool's config shape).

- [ ] **Step 9: Green + dry-run**

`cd worker && npm test sandbox-binding` → PASS; `npm test` → 17 prior + new green; `npm run typecheck` → clean; `npx wrangler deploy --dry-run` (OrbStack up) → builds image, reports container + SANDBOX DO + R2, no errors. Do NOT deploy.

- [ ] **Step 10: Commit**

```bash
git add worker/Dockerfile worker/brain-repo worker/package.json worker/package-lock.json worker/wrangler.toml worker/src/index.ts worker/src/runtime/env.ts worker/vitest.config.ts worker/test/sandbox-binding.test.ts
git commit -m "feat(brain): sandbox image with claude code + swamp + R2 repo"
```

---

### Task 2: swamp model wrapping `claude -p` + the research-cycle workflow

The employee's capability = Claude Code; swamp structures + versions it. Author a `command/shell` model whose `execute` method runs `claude -p`, and a workflow that calls it. The `log` output is the versioned artifact.

**Files:**
- Create: `worker/brain-repo/models/claude-agent.yaml`
- Create: `worker/brain-repo/workflows/research-cycle.yaml`
- Modify: `worker/globals.d.ts` (add `*.yaml?raw` ambient decl)
- Create: `worker/test/brain-repo.test.ts` (pure parse/consistency check — runs in the pool, no container)

**Interfaces:**
- Produces: swamp workflow `research-cycle` taking input `task` (string), invoking the `claude-agent` model, yielding a versioned `log` artifact (Claude's research output).

- [ ] **Step 1: Failing static test**

Create `worker/test/brain-repo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import claudeAgentModel from "../brain-repo/models/claude-agent.yaml?raw";
import researchWorkflow from "../brain-repo/workflows/research-cycle.yaml?raw";

describe("swamp brain repo definitions", () => {
  it("claude-agent is a command/shell model", () => {
    expect(claudeAgentModel).toContain("command/shell");
    expect(claudeAgentModel).toContain("claude-agent");
  });
  it("research-cycle passes the task as an env var (injection-safe), not into the command", () => {
    expect(researchWorkflow).toContain("claude-agent");
    expect(researchWorkflow).toContain("AGENT_TASK");            // task flows via env
    expect(researchWorkflow).toContain('"$AGENT_TASK"');          // run references the env var
    expect(researchWorkflow).toContain("{{ inputs.task }}");      // bound to the workflow input
  });
});
```

Add to `worker/globals.d.ts`: `declare module "*.yaml?raw" { const content: string; export default content; }`.

- [ ] **Step 2: Run to verify it fails** — `cd worker && npm test brain-repo` → FAIL (files missing).

- [ ] **Step 3: Create the model** (minimal — `run`/`env` are supplied by the workflow)

Run `SWAMP_REPO_DIR=<repo> swamp --no-telemetry model create command/shell claude-agent`; copy the generated `models/command/shell/<uuid>.yaml` into `worker/brain-repo/models/claude-agent.yaml`. It is minimal by design:

```yaml
type: command/shell
name: claude-agent
version: 1
globalArguments: {}
methods: {}
```

- [ ] **Step 4: Author the workflow (injection-safe env-var pattern)**

Create `worker/brain-repo/workflows/research-cycle.yaml`. The task flows into an **env var**, and the `run` command is static and references `"$AGENT_TASK"` — proven inert against shell metacharacters:

```yaml
# One research pass. Input `task` → passed to Claude via the AGENT_TASK env var
# (NOT interpolated into the command), so shell metacharacters are inert.
# swamp versions Claude's stdout as an immutable `log` + structured `result` artifact.
name: research-cycle
inputs:
  task:
    type: string
steps:
  - name: research
    model: claude-agent
    method: execute
    with:
      run: 'claude -p "$AGENT_TASK" --model claude-sonnet-5 --max-turns 4 --permission-mode bypassPermissions'
      env:
        AGENT_TASK: "{{ inputs.task }}"
```

> Conform to swamp's real schema in Step 6 (`swamp workflow schema`). The env-var pattern is verified (see Resolved facts); keep the task in `env`, never in `run`.

- [ ] **Step 5: Static test + typecheck green** — `npm test brain-repo` → PASS; `npm run typecheck` → clean.

- [ ] **Step 6: Validate against swamp's schema (scratch repo)**

In a scratch swamp repo, copy both YAMLs in; run `swamp --no-telemetry model validate claude-agent` and `swamp --no-telemetry workflow validate research-cycle`. Expected: valid. Fix schema mismatches, copy corrected files back, record the validation output.

- [ ] **Step 7: Commit**

```bash
git add worker/brain-repo/models worker/brain-repo/workflows worker/globals.d.ts worker/test/brain-repo.test.ts
git commit -m "feat(brain): swamp claude-agent model + research-cycle workflow"
```

---

### Task 3: The `brain` bridge — run swamp in the sandbox, R2-persist the repo

**Files:**
- Create: `worker/src/runtime/brain.ts`
- Create: `worker/test/brain.test.ts`

**Interfaces:**
- Produces:
  - `RESEARCH_COMMAND: string` — the **static** command `swamp --no-telemetry workflow run research-cycle --stdin --json` (no task embedded).
  - `buildResearchStdin(task): string` (pure) → the JSON piped to swamp's stdin (`{"task":"…"}`). The task rides stdin, never the command string.
  - `runResearchCycle(env, task): Promise<{ artifact: string }>` — hydrate `/brain` from R2, run the workflow (task via stdin), read back the artifact via `swamp data`, sync repo to R2.
  - `reflectWithClaude(env, artifact): Promise<string>` — `claude -p` (subscription) summarizes the artifact; the artifact is passed via an **env var** (`REFLECT_INPUT`), not interpolated into the command.

- [ ] **Step 1: Failing test — the task never enters the command string (injection-safe)**

Create `worker/test/brain.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RESEARCH_COMMAND, buildResearchStdin } from "../src/runtime/brain";

describe("research command is injection-safe by construction", () => {
  it("the exec command is static and runs the workflow via --stdin", () => {
    expect(RESEARCH_COMMAND).toContain("swamp --no-telemetry workflow run research-cycle");
    expect(RESEARCH_COMMAND).toContain("--stdin");
  });
  it("a malicious task appears ONLY in the stdin JSON, never in the command", () => {
    const evil = `x"; rm -rf / #`;
    const stdin = buildResearchStdin(evil);
    expect(JSON.parse(stdin).task).toBe(evil);   // preserved verbatim as data
    expect(RESEARCH_COMMAND).not.toContain("rm -rf");  // never in the shell command
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd worker && npm test brain` → FAIL (module missing).

- [ ] **Step 3: Write `brain.ts`**

Create `worker/src/runtime/brain.ts`:

```ts
import type { Env } from "./env";
import { getSandbox } from "@cloudflare/sandbox";

// Static command — the task is NOT here; it rides swamp's stdin as JSON.
export const RESEARCH_COMMAND = "swamp --no-telemetry workflow run research-cycle --stdin --json";

// The JSON piped to swamp's stdin. The task is data, never shell.
export function buildResearchStdin(task: string): string {
  return JSON.stringify({ task });
}

const claudeEnv = (env: Env) => ({ CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN });

// Run one research cycle in the sandbox: hydrate repo from R2, run the swamp
// workflow with the task piped via stdin (injection-safe), read the versioned
// artifact back, sync the repo to R2. Returns the artifact text.
export async function runResearchCycle(env: Env, task: string): Promise<{ artifact: string }> {
  const sandbox = getSandbox(env.SANDBOX, "dazl-brain");
  await hydrateRepo(env, sandbox);

  const runResult = await sandbox.exec(RESEARCH_COMMAND, {
    cwd: "/brain",
    env: claudeEnv(env),
    stdin: buildResearchStdin(task),
  });
  if (!runResult.success) {
    throw new Error(`swamp research-cycle failed (exit ${runResult.exitCode}): ${runResult.stderr.slice(0, 500)}`);
  }

  const dataResult = await sandbox.exec("swamp --no-telemetry data get research-cycle --json", { cwd: "/brain" });
  await persistRepo(env, sandbox);
  return { artifact: (dataResult.stdout || runResult.stdout).trim() };
}

// Reflect on the artifact using Claude on the subscription. The artifact rides an
// env var (REFLECT_INPUT); the command is static — no interpolation, no escaping.
export async function reflectWithClaude(env: Env, artifact: string): Promise<string> {
  const sandbox = getSandbox(env.SANDBOX, "dazl-brain");
  const command =
    `claude -p "Summarize the single most useful marketing lesson in one sentence from: $REFLECT_INPUT" ` +
    `--model claude-sonnet-5 --max-turns 1 --permission-mode bypassPermissions`;
  const out = await sandbox.exec(command, {
    cwd: "/brain",
    env: { ...claudeEnv(env), REFLECT_INPUT: artifact.slice(0, 4000) },
  });
  return out.stdout.trim();
}

// R2 <-> container repo sync via a base64 tar (readFile/writeFile take base64).
// A missing snapshot just means the baked-in seed is used (non-fatal).
async function hydrateRepo(env: Env, sandbox: ReturnType<typeof getSandbox>): Promise<void> {
  const snapshot = await env.BRAIN_REPO.get("brain-repo.tar.b64");
  if (!snapshot) return;
  await sandbox.writeFile("/tmp/brain-repo.tar", await snapshot.text(), { encoding: "base64" });
  await sandbox.exec("tar -xf /tmp/brain-repo.tar -C /", { cwd: "/" });
}

async function persistRepo(env: Env, sandbox: ReturnType<typeof getSandbox>): Promise<void> {
  await sandbox.exec("tar -cf /tmp/brain-repo.tar -C / brain", { cwd: "/" });
  const tarBase64 = await sandbox.readFile("/tmp/brain-repo.tar", { encoding: "base64" });
  await env.BRAIN_REPO.put("brain-repo.tar.b64", tarBase64.content ?? tarBase64);
}
```

> Adapt `writeFile`/`readFile` return/param shapes + the `exec` `stdin` option to the installed `@cloudflare/sandbox` (the research file notes `readFile` returns `{ content }` for base64; confirm `exec` accepts `stdin`). The stdin JSON key (`task`) must match the workflow's declared input name (Task 2). If `exec` does not support `stdin` in the installed version, fall back to writing the JSON to a temp file with `writeFile` and using `swamp … --input-file /tmp/in.json` — still no task in the command string. Record deviations.

- [ ] **Step 4: Builder test + typecheck + full suite** — `npm test brain` → PASS; `npm run typecheck` → clean; `npm test` → all green. (`runResearchCycle`/`reflectWithClaude` proven live in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add worker/src/runtime/brain.ts worker/test/brain.test.ts
git commit -m "feat(brain): run swamp research-cycle in sandbox, R2-persist repo"
```

---

### Task 4: Wire the employee cycle to the swamp brain

**Files:**
- Modify: `worker/src/runtime/cycle.ts`
- Modify: `worker/src/runtime/employee-cycle-workflow.ts`
- Modify: `worker/test/cycle.test.ts`

**Interfaces:**
- Produces: `runEmployeeCycleWithBrain(env, employeeName, brain?)` — read goal → run swamp research-cycle (versioned artifact) → Claude reflect → persist lesson to D1. Injectable `brain` keeps tests deterministic.

- [ ] **Step 1: Failing test (fake brain)**

Add to `worker/test/cycle.test.ts`:

```ts
import { runEmployeeCycleWithBrain } from "../src/runtime/cycle";
import { recallRecentMemories } from "../src/runtime/memory";

it("runs a swamp-brain cycle and stores the Claude-reflected lesson", async () => {
  const fakeBrain = {
    runResearchCycle: async (_e: any, task: string) => {
      expect(task.length).toBeGreaterThan(0);
      return { artifact: "raw research about AI marketing tools" };
    },
    reflectWithClaude: async () => "Lesson: launch on dev communities first.",
  };
  await runEmployeeCycleWithBrain(env as any, "swamp-tester", fakeBrain);
  const memories = await recallRecentMemories(env.DB, "swamp-tester", 5);
  expect(memories[0].kind).toBe("lesson");
  expect(memories[0].content).toContain("dev communities");
});
```

- [ ] **Step 2: Run to verify it fails** — `cd worker && npm test cycle` → FAIL (`runEmployeeCycleWithBrain` missing).

- [ ] **Step 3: Update `cycle.ts`**

```ts
import { runResearchCycle as defaultRun, reflectWithClaude as defaultReflect } from "./brain";
import { rememberFact } from "./memory";
import type { Env } from "./env";

export interface Brain {
  runResearchCycle: (env: Env, task: string) => Promise<{ artifact: string }>;
  reflectWithClaude: (env: Env, artifact: string) => Promise<string>;
}
const defaultBrain: Brain = { runResearchCycle: defaultRun, reflectWithClaude: defaultReflect };

// One full cycle via the swamp brain: goal → swamp research-cycle (versioned
// artifact) → Claude reflect → persist lesson.
export async function runEmployeeCycleWithBrain(
  env: Env, employeeName: string, brain: Brain = defaultBrain
): Promise<void> {
  const goal = await env.EMPLOYEE.get(env.EMPLOYEE.idFromName(employeeName)).getGoal();
  const task = `Research this for dazl marketing and report key findings: ${goal ?? "grow dazl.ai"}`;
  const { artifact } = await brain.runResearchCycle(env, task);
  const lesson = await brain.reflectWithClaude(env, artifact);
  await rememberFact(env.DB, employeeName, "lesson", lesson || artifact.slice(0, 200));
}
```

(Leave Phase-1 `planNextAction`/`act`/`reflect` in place or remove if now unreferenced — implementer decides, keep it minimal, note it.)

- [ ] **Step 4: Update the Workflow** — in `worker/src/runtime/employee-cycle-workflow.ts`, replace the inline plan→act→reflect with `await step.do("swamp-brain cycle", () => runEmployeeCycleWithBrain(this.env, employeeName))`.

- [ ] **Step 5: Green** — `npm test cycle` → PASS (adjust old stub tests); `npm test` → all green; `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add worker/src/runtime/cycle.ts worker/src/runtime/employee-cycle-workflow.ts worker/test/cycle.test.ts
git commit -m "feat(brain): drive employee cycle through the swamp brain"
```

---

### Task 5: Live verification — swamp + Claude, subscription-billed, on Cloudflare

**Files:** Create: `worker/BRAIN_VERIFY.md`

- [ ] **Step 1: Token (operator)** — `claude setup-token`; approve in browser; copy `sk-ant-oat…`.
- [ ] **Step 2: Secret + R2** — `cd worker && npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN` (paste); `npx wrangler r2 bucket create dazl-brain-repo`.
- [ ] **Step 3: Deploy** — `cd worker && npx wrangler deploy` (OrbStack up) → builds image, binds Sandbox + R2. Note URL.
- [ ] **Step 4: Spawn + trigger**

```bash
URL="https://<your-worker-url>"; SECRET="<DAZL_API_SECRET>"
curl -s -X POST "$URL/employees" -H "Authorization: Bearer $SECRET" \
  -d '{"employeeName":"strategist","role":"Strategist","goal":"position dazl.ai vs other AI marketing tools"}'
```

- [ ] **Step 5: Inspect** — wait ~60–120s (cold start + swamp + `claude -p`), then `curl -s "$URL/employees/strategist" -H "Authorization: Bearer $SECRET"`. Expected: `memories[0].content` = a coherent Claude-written one-sentence lesson derived from the swamp-versioned research artifact.
- [ ] **Step 6: Confirm swamp artifact + subscription billing (operator)** — the research-cycle produced a versioned `log` artifact (in the R2 `dazl-brain-repo` snapshot / via a local hydrate + `swamp data list research-cycle`). The Claude usage dashboard shows the call under **subscription usage**, no new pay-as-you-go charge.
- [ ] **Step 7: Record + commit**

```bash
git add worker/BRAIN_VERIFY.md
git commit -m "test(brain): document live swamp+claude cycle, subscription-billed on Cloudflare"
```

---

## Self-Review

**Coverage:** works like swamp (models/workflows/versioned artifacts + Claude capability) → Tasks 1–4 ✅; Cloudflare-only (Sandbox) → Tasks 1,3,5 ✅; subscription billing → Tasks 1,3,5 ✅; Phase-1 spine unchanged/durable → constraints + Task 1 ✅.

**Deferred (logged):** Observe/metrics; more capability models (content/creative/X) each a swamp workflow whose publish step uses a swamp **manual-approval** step = the approval gate; the anti-slop taste gate (a swamp reflect/critique step); the on-screen blobs.

**Placeholders:** only operator secrets/URLs in Task 5 — real values. Task 2 YAML is validated against swamp's real schema (Task 2 Step 6) before use.

**Type consistency:** `Brain = { runResearchCycle, reflectWithClaude }` consistent across Tasks 3–4; `buildResearchCommand(task): string` (escaped); `runResearchCycle(env, task): Promise<{ artifact }>` stable; swamp workflow input key (`run` vs `task`) is reconciled between Task 2's YAML and Task 3's `--input` (Task 3 note).

**Remaining genuine risks (all bounded):**
1. **Shell injection — RESOLVED (proven).** The task never enters a shell string: it rides `--stdin` (Worker→swamp) and an `env` var (swamp→shell, `"$AGENT_TASK"`); the reflect artifact rides the `REFLECT_INPUT` env var. Verified experimentally that a `"; touch … ; echo "` payload is inert. Tests assert the command contains no task. No escaping is relied upon. Falls back to `--input-file` if `exec` lacks `stdin`.
2. **`@cloudflare/sandbox` file/stdin API shape** (base64 `{ content }`, `exec` `stdin`) — adapt in `brain.ts`; builder tests + Task 5 catch mismatches.
3. **swamp CEL/`spec` schema** for the model/workflow YAML — validated live in Task 2 Step 6 before use.
4. **Container cold start** (~image pull + swamp/claude init) — Task 5 allows generous wait; hourly cadence tolerates it.
5. **Token expiry (~1yr, no auto-refresh)** — deferred; note in `BRAIN_VERIFY.md`; later task adds re-issue.
6. **Instance type name** (`standard-1`) — confirm valid for the account (Task 1 Step 6 note).
