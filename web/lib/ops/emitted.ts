// Which stack-frame files are this app's own code (lib/ops/errors.ts, lib/ops/client-errors.ts). A path that merely
// LOOKS like code is not enough: an error can carry any text in its stack, including a path made of a name or a secret
// (/home/AliceSmith/password-river-mint-secret.ts). So a file is kept only when it is one this build actually has:
//   - a Node built-in module (node:fs; node:internal/... is reduced to node:internal)
//   - a file that exists under the app root in .next/server/ or node_modules/, recorded RELATIVE to the root (no host,
//     user or home-directory prefix)
//   - a browser bundle /_next/static/... that exists in this build's .next/static/
// Anything else is dropped. Existence checks are cached (bounded); the root is the server's working directory.
import { statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'

const SAFE = /^[A-Za-z0-9_./@+~-]{1,300}$/
const seen = new Map<string, boolean>()
function exists(root: string, rel: string): boolean {
  const key = `${root}\n${rel}`
  let ok = seen.get(key)
  if (ok === undefined) {
    try { ok = statSync(path.join(root, rel)).isFile() } catch { ok = false }
    if (seen.size > 2000) seen.clear()
    seen.set(key, ok)
  }
  return ok
}

// A server stack frame's file, as an app-relative code path, or null.
export function appCodeFile(file: string, root: string = process.cwd()): string | null {
  if (file.startsWith('node:')) {
    const name = file.slice(5)
    if (name.startsWith('internal/')) return 'node:internal'
    return builtinModules.includes(name) ? file : null
  }
  const p = file.replace(/^file:\/\//, '')
  if (!path.isAbsolute(p)) return null
  const rel = path.relative(root, path.normalize(p)).split(path.sep).join('/')
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !SAFE.test(rel)) return null
  if (!/^(?:\.next\/server\/|node_modules\/)/.test(rel)) return null
  return exists(root, rel) ? rel : null
}

// A browser frame's /_next/static/ path when this build emitted that file, or null.
export function bundleFile(urlPath: string, root: string = process.cwd()): string | null {
  if (!/^\/_next\/static\/[A-Za-z0-9_./~-]{1,200}$/.test(urlPath) || urlPath.split('/').includes('..')) return null
  return exists(root, `.next/static/${urlPath.slice('/_next/static/'.length)}`) ? urlPath : null
}
