import type { Env } from "./env";
import { getSandbox } from "@cloudflare/sandbox";

// The installed @cloudflare/sandbox (v0.12.3) `ExecOptions` type has NO `stdin`
// field (confirmed via the shipped .d.ts: `BaseExecOptions` carries only
// `timeout`/`env`/`cwd`/`encoding`; `ExecOptions` adds only streaming/abort/
// origin callbacks — see worker/node_modules/@cloudflare/sandbox/dist/
// sandbox-*.d.ts). `sandbox.exec()` has no way to pipe data onto a process's
// stdin. So the task JSON is first written to a FIXED, non-task-derived path
// via `writeFile` (a data write, not a shell operation — its byte content is
// never parsed as shell), and RESEARCH_COMMAND redirects that fixed file into
// swamp's stdin reader with the shell `<` operator. Because `sandbox.exec`
// runs its `command` string through a real shell (per the resolved API facts:
// "command is a SINGLE shell string"), `<` redirection works, and the command
// string stays 100% static — it names only the fixed file path, never the task.
const RESEARCH_STDIN_FILE_PATH = "/tmp/dazl-research-input.json";

// Static command — the task is NOT here; it rides swamp's stdin (via the file
// redirected below), read as piped JSON by `--stdin`.
export const RESEARCH_COMMAND =
  `swamp --no-telemetry workflow run research-cycle --stdin --json < ${RESEARCH_STDIN_FILE_PATH}`;

// The JSON written to RESEARCH_STDIN_FILE_PATH and piped to swamp's stdin.
// The task is data, never shell. Key (`task`) matches the research-cycle
// workflow's declared input (worker/brain-repo/workflows/*research-cycle*.yaml).
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

  // Write the task as data to a fixed path — never interpolated into a shell
  // command. RESEARCH_COMMAND then redirects this exact file into swamp's
  // `--stdin` reader.
  await sandbox.writeFile(RESEARCH_STDIN_FILE_PATH, buildResearchStdin(task), {
    encoding: "utf-8",
  });

  const runResult = await sandbox.exec(RESEARCH_COMMAND, {
    cwd: "/brain",
    env: claudeEnv(env),
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

// R2 <-> container repo sync via a base64 tar. The installed `readFile`
// returns `{ content: string, encoding, ... }` directly (not nested further)
// for both 'utf-8' and 'base64' encodings — see `ReadFileResult` in
// @cloudflare/sandbox's shipped types. `writeFile` takes the raw string
// content plus `{ encoding }` and returns a status object with no content.
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
  await env.BRAIN_REPO.put("brain-repo.tar.b64", tarBase64.content);
}
