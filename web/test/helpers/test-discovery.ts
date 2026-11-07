// Refs #894: pure rules for "is this test file discovered by a canonical runner" (kept apart from the filesystem walk so they can be pinned
// with synthetic inputs). The canonical runner is package.json "test": the root glob test/*.test.ts, plus any test file the script names
// EXPLICITLY after --test. An explicit entry counts only as an exact, glob-free path to a real test file under test/; it is never a pattern
// and never a blanket exemption for a file type.
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const EXPLICIT = /^test\/[A-Za-z0-9_.\/-]+\.(?:test|spec)\.[cm]?[jt]sx?$/

// Shell syntax this parser does NOT interpret. The first such character ends the command it will read: operators need no surrounding whitespace
// (`a;b`, `a&&b`, `a|b`), `#` starts a comment, quotes/backslashes/`$`/backticks/parentheses/braces can hide or build arguments, and redirections or
// newlines start something else. Everything after the first one is ignored, so it can never register a test. Unsupported syntax is rejected, not guessed at.
const SHELL_SYNTAX = /[;&|#<>`$(){}\\'"\n\r]/

// Exact explicit test paths named after `--test` in the FIRST simple command of the script. Rules, all conservative:
//  - `--test` must be its own token in that command (the command ends at the first shell-syntax character);
//  - paths count only up to the first option token (anything starting with `-`): an option's value can be path-shaped (`--import test/x.test.mjs`,
//    `--test-reporter tap test/x.test.mjs`) and is not a test entry, and which options take a value is not guessed, so nothing after an option registers;
//  - a path counts only as an exact, glob-free, clean file path under test/ naming a test file (not the root .test.ts glob).
export function explicitlyRegistered(script: string): string[] {
  // The word that CONTAINS the first shell-syntax character is dropped whole, not cut at that character: `test/x.test.mjs"suffix"` is the argument
  // test/x.test.mjssuffix to the shell, `test/x.test.mjs\\y` and `test/x.test.mjs$V` are not test/x.test.mjs either. Only complete words before it are read.
  const m = SHELL_SYNTAX.exec(script)
  const command = m ? script.slice(0, Math.max(script.slice(0, m.index).search(/\S+$/), 0)) : script
  const tokens = command.split(/\s+/).filter(Boolean)
  const at = tokens.indexOf('--test')
  if (at < 0) return []
  const out: string[] = []
  for (const t of tokens.slice(at + 1)) {
    if (t.startsWith('-')) break
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
