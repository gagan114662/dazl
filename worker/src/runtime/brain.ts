import type { Env } from "./env";
import { getSandbox } from "@cloudflare/sandbox";

// The installed @cloudflare/sandbox (v0.12.3) `ExecOptions` type has NO `stdin`
// field (confirmed via the shipped .d.ts: `BaseExecOptions` carries only
// `timeout`/`env`/`cwd`/`encoding`; `ExecOptions` adds only streaming/abort/
// origin callbacks — see worker/node_modules/@cloudflare/sandbox/dist/
// sandbox-*.d.ts). `sandbox.exec()` has no way to pipe data onto a process's
// stdin. So the task JSON is first written to a file via `writeFile` (a data
// write, not a shell operation — its byte content is never parsed as shell),
// and the swamp command redirects that file into swamp's stdin reader with
// the shell `<` operator. Because `sandbox.exec` runs its `command` string
// through a real shell (per the resolved API facts: "command is a SINGLE
// shell string"), `<` redirection works, and the command string stays 100%
// static in shape — it names only the stdin file path, never the task.
//
// The stdin file path is generated FRESH per `runResearchCycle` call (see
// `crypto.randomUUID()` below) rather than being a fixed constant. All
// employees run inside the SAME shared sandbox container (`getSandbox(env.SANDBOX,
// "dazl-brain")`), and the hourly cron can wake multiple employees concurrently.
// If every call wrote to the same fixed path, two concurrent
// `runResearchCycle` calls could race: one call's `writeFile` could overwrite
// another's task JSON before that other call's `swamp workflow run` reads it,
// causing a call to silently execute the WRONG employee's task. A per-call
// UUID-based path eliminates that collision. The UUID contains no shell
// metacharacters, so it is safe to interpolate directly into the command
// string — the constraint that must hold is that the TASK itself (untrusted
// input) never appears in the command string, which remains true here.
export function buildResearchCommand(researchStdinFilePath: string): string {
  return `swamp --no-telemetry workflow run research-cycle --stdin --json < ${researchStdinFilePath}`;
}

// The JSON written to the per-call stdin file path and piped to swamp's
// stdin. The task is data, never shell. Key (`task`) matches the
// research-cycle workflow's declared input
// (worker/brain-repo/workflows/*research-cycle*.yaml).
export function buildResearchStdin(task: string): string {
  return JSON.stringify({ task });
}

const claudeEnv = (env: Env) => ({ CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN });

// The installed `@cloudflare/sandbox` (v0.12.3) `BaseExecOptions.timeout` is
// "Maximum execution time in milliseconds" (confirmed via the shipped
// `.d.ts`: worker/node_modules/@cloudflare/sandbox/dist/sandbox-BhIQBik-.d.ts).
// `sandbox.exec()` has no default timeout, so a slow `claude -p --max-turns 4`
// research/reflect call (which can legitimately take minutes) would otherwise
// hang indefinitely rather than failing fast with a clear error. Five minutes
// is generous headroom for a `--max-turns 4` Claude call plus the swamp
// workflow steps around it, while still bounding worst-case sandbox exec time.
const BRAIN_EXEC_TIMEOUT_MS = 300_000;

// Run one research cycle in the sandbox: hydrate repo from R2, run the swamp
// workflow with the task piped via stdin (injection-safe), read the versioned
// artifact back, sync the repo to R2. Returns the artifact text.
export async function runResearchCycle(env: Env, task: string): Promise<{ artifact: string }> {
  const sandbox = getSandbox(env.SANDBOX, "dazl-brain");
  await hydrateRepo(env, sandbox);

  // Unique per-call stdin file path — see the comment on `buildResearchCommand`
  // above for why a fixed shared path is unsafe when multiple employees run
  // concurrently against the same shared sandbox container.
  const researchStdinFilePath = `/tmp/dazl-research-${crypto.randomUUID()}.json`;

  // Write the task as data to the unique path — never interpolated into a
  // shell command. buildResearchCommand then redirects this exact file into
  // swamp's `--stdin` reader.
  await sandbox.writeFile(researchStdinFilePath, buildResearchStdin(task), {
    encoding: "utf-8",
  });

  const runResult = await sandbox.exec(buildResearchCommand(researchStdinFilePath), {
    cwd: "/brain",
    env: claudeEnv(env),
    timeout: BRAIN_EXEC_TIMEOUT_MS,
  });
  if (!runResult.success) {
    throw new Error(`swamp research-cycle failed (exit ${runResult.exitCode}): ${runResult.stderr.slice(0, 500)}`);
  }

  const dataResult = await sandbox.exec("swamp --no-telemetry data get research-cycle --json", {
    cwd: "/brain",
    timeout: BRAIN_EXEC_TIMEOUT_MS,
  });
  // Best-effort cleanup of the per-call stdin file. Failure here (e.g. the
  // sandbox already recycled) is non-fatal — the file is a temp scratch file
  // with a unique name, so a leftover doesn't cause the race this refactor
  // fixes; it's just tidiness.
  await sandbox.deleteFile(researchStdinFilePath).catch(() => {});

  await persistRepo(env, sandbox);

  // `dataResult` (the versioned `swamp data get` read-back) is preferred over
  // `runResult.stdout` because it's the authoritative stored artifact, not
  // just whatever the workflow run happened to print. Unlike `runResult`
  // above, we do NOT throw on `!dataResult.success` — the workflow run itself
  // already succeeded, and `runResult.stdout` is a reasonable fallback for
  // that case. But if BOTH are empty (the data-get failed AND the run
  // produced no usable stdout), silently returning an empty artifact would
  // hide a real failure, so we throw instead of returning an empty string.
  const artifact = (dataResult.success ? dataResult.stdout : "") || runResult.stdout;
  if (!artifact.trim()) {
    throw new Error(
      `swamp data get research-cycle failed (exit ${dataResult.exitCode}) and workflow run produced no stdout: ${dataResult.stderr.slice(0, 500)}`,
    );
  }
  return { artifact: artifact.trim() };
}

// Reflect on the artifact using Claude on the subscription. The artifact rides an
// env var (REFLECT_INPUT); the command is static — no interpolation, no escaping.
export async function reflectWithClaude(env: Env, artifact: string): Promise<string> {
  const sandbox = getSandbox(env.SANDBOX, "dazl-brain");
  const command =
    `claude -p "Summarize the single most useful marketing lesson in one sentence from: $REFLECT_INPUT" ` +
    `--model claude-sonnet-5 --max-turns 3 --dangerously-skip-permissions`;
  const out = await sandbox.exec(command, {
    cwd: "/brain",
    env: { ...claudeEnv(env), REFLECT_INPUT: artifact.slice(0, 4000) },
    timeout: BRAIN_EXEC_TIMEOUT_MS,
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
  // No snapshot yet (first run, or R2 object never written) just means the
  // image's baked-in seed is used as-is — non-fatal.
  if (!snapshot) return;
  await sandbox.writeFile("/tmp/brain-repo.tar", await snapshot.text(), { encoding: "base64" });
  const extractResult = await sandbox.exec("tar -xf /tmp/brain-repo.tar -C /", {
    cwd: "/",
    timeout: BRAIN_EXEC_TIMEOUT_MS,
  });
  // A snapshot DOES exist but failed to extract (corrupt archive, disk
  // issue, etc.) — that's a real failure, not the "no snapshot" case above,
  // so it must throw rather than silently falling back to a stale/partial
  // extraction.
  if (!extractResult.success) {
    throw new Error(
      `tar extract of brain-repo snapshot failed (exit ${extractResult.exitCode}): ${extractResult.stderr.slice(0, 500)}`,
    );
  }
}

async function persistRepo(env: Env, sandbox: ReturnType<typeof getSandbox>): Promise<void> {
  const archiveResult = await sandbox.exec("tar -cf /tmp/brain-repo.tar -C / brain", {
    cwd: "/",
    timeout: BRAIN_EXEC_TIMEOUT_MS,
  });
  if (!archiveResult.success) {
    throw new Error(
      `tar archive of brain-repo failed (exit ${archiveResult.exitCode}): ${archiveResult.stderr.slice(0, 500)}`,
    );
  }
  const tarBase64 = await sandbox.readFile("/tmp/brain-repo.tar", { encoding: "base64" });
  await env.BRAIN_REPO.put("brain-repo.tar.b64", tarBase64.content);
}
