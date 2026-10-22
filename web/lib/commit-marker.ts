// Served-commit marker: lets deploy verification prove WHICH build is actually
// serving, instead of trusting HTTP 200s (the EADDRINUSE incident: an old
// process kept serving while the new build failed to bind).
// Resolution order: explicit env (set by the deploy script) -> .git probe
// (the deployed app dir is a git checkout) -> 'unknown' (never a silent guess).
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export function resolveServedCommit(
  env: Record<string, string | undefined> = process.env,
  root: string = process.cwd(),
): string {
  // Precedence: the build-stamped file wins - it is written by `prebuild`
  // from the checkout actually being built, so a stale process serving an
  // old build cannot report a newer commit. An operator-provided env var
  // (arbitrary, could be set wrong) is only a last resort above 'unknown'.
  let dir = root
  for (let i = 0; i < 4; i++) {
    try {
      const stamp = readFileSync(path.join(dir, '.build-commit'), 'utf8').trim()
      if (/^[0-9a-f]{40}$/.test(stamp)) return stamp
    } catch { /* no stamp at this level */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // The server usually runs from web/, but .git lives at the repo root -
  // walk up so the probe does not silently return 'unknown' in production.
  dir = root
  for (let i = 0; i < 4; i++) {
    const found = probeGitDir(env, dir)
    if (found) return found
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const fromEnv = env.DAZL_COMMIT_SHA?.trim()
  if (fromEnv) return fromEnv
  return 'unknown'
}

function probeGitDir(
  env: Record<string, string | undefined>,
  root: string,
): string | null {
  try {
    const gitDir = path.join(root, '.git')
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const refMatch = head.match(/^ref: (.+)$/)
    if (refMatch) {
      const refFile = path.join(gitDir, refMatch[1])
      if (existsSync(refFile)) return readFileSync(refFile, 'utf8').trim()
      const packed = readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
      for (const line of packed.split('\n')) {
        if (line.startsWith('#') || line.startsWith('^')) continue
        const [sha, ref] = line.split(' ')
        if (ref === refMatch[1] && sha) return sha
      }
      return null
    }
    return /^[0-9a-f]{40}$/.test(head) ? head : null // detached HEAD
  } catch {
    return null
  }
}
