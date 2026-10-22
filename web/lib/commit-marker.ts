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
  const fromEnv = env.DAZL_COMMIT_SHA?.trim()
  if (fromEnv) return fromEnv
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
      return 'unknown'
    }
    return /^[0-9a-f]{40}$/.test(head) ? head : 'unknown' // detached HEAD
  } catch {
    return 'unknown'
  }
}
