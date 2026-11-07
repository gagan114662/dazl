// Refs #894: pure rules for "is this test file discovered by a canonical runner" (kept apart from the filesystem walk so they can be pinned
// with synthetic inputs). The canonical runner is package.json "test": the root glob test/*.test.ts, plus any test file the script names
// EXPLICITLY after --test. An explicit entry counts only as an exact, glob-free path to a real test file under test/; it is never a pattern
// and never a blanket exemption for a file type.
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const EXPLICIT = /^test\/[A-Za-z0-9_.\/-]+\.(?:test|spec)\.[cm]?[jt]sx?$/

// Exact explicit test paths in the script's --test argument list: tokens after `--test`, up to the first shell operator. Anything with a glob
// character, a flag, or a path outside test/ is not an explicit registration.
export function explicitlyRegistered(script: string): string[] {
  const tokens = script.split(/\s+/).filter(Boolean)
  const at = tokens.indexOf('--test')
  if (at < 0) return []
  const out: string[] = []
  for (const t of tokens.slice(at + 1)) {
    if (/^(?:&&|\|\||\||;|&)$/.test(t)) break
    if (t.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) continue   // a clean path only: no traversal, no empty segments
    if (EXPLICIT.test(t) && !/^test\/[^/]+\.test\.ts$/.test(t) && !out.includes(t)) out.push(t)
  }
  return out
}

export interface DiscoveryInput { files: string[]; script: string; fixturePrefixes: string[]; ownEntryPoints: ReadonlySet<string> }
export interface DiscoveryResult { stranded: string[]; registeredButMissing: string[] }
export function discovery({ files, script, fixturePrefixes, ownEntryPoints }: DiscoveryInput): DiscoveryResult {
  const registered = explicitlyRegistered(script), present = new Set(files)
  const stranded = files.filter(f => {
    if (/^test\/[^/]+\.test\.ts$/.test(f)) return false      // the canonical glob
    if (fixturePrefixes.some(p => f.startsWith(p))) return false
    if (ownEntryPoints.has(f)) return false
    if (registered.includes(f)) return false                  // named exactly in the canonical invocation
    return true
  })
  // a registration that names no real file protects nothing: say so instead of silently exempting a typo
  return { stranded, registeredButMissing: registered.filter(f => !present.has(f)) }
}
