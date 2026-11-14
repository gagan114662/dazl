// The matrix runner's env-file format. Kept apart from the runner so a test can use it without loading the pipeline.
// the env file: KEY=VALUE per line; # starts a comment (a whole line, or after the value outside quotes); a value may be quoted;
// values are never printed. A variable that is set but empty in the shell counts as unset, so the file's value applies.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    let v = m[2]
    const q = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(v)
    if (q) v = q[2]
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}
