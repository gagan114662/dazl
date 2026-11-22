// Builds the Chrome Web Store package: extension/store/dist/dazl-connect-<version>.zip
//   node extension/store/build.mjs
// The store build differs from the unpacked (developer) build in two ways, both in the manifest only:
//   - no "key": the Web Store rejects it and assigns its own extension ID
//   - no staging host: the public build talks only to dazl.ai
// Only the files the extension runs are packed; README.md, PRIVACY.md and store/ stay out.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '..')
const dist = path.join(here, 'dist')
const stage = path.join(dist, 'pkg')
const FILES = ['background.js', 'content.js', 'extract.js', 'popup.html', 'popup.js', 'icons/16.png', 'icons/48.png', 'icons/128.png']
const PUBLIC_ONLY = h => !h.includes('staging.')

const manifest = JSON.parse(readFileSync(path.join(src, 'manifest.json'), 'utf8'))
delete manifest.key
manifest.host_permissions = manifest.host_permissions.filter(PUBLIC_ONLY)
manifest.externally_connectable.matches = manifest.externally_connectable.matches.filter(PUBLIC_ONLY)
if (manifest.description.length > 132) throw new Error(`description is ${manifest.description.length} characters; the store allows 132`)

rmSync(dist, { recursive: true, force: true })
mkdirSync(path.join(stage, 'icons'), { recursive: true })
for (const f of FILES) cpSync(path.join(src, f), path.join(stage, f))
writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const zip = path.join(dist, `dazl-connect-${manifest.version}.zip`)
execFileSync('zip', ['-X', '-r', zip, 'manifest.json', ...FILES], { cwd: stage, stdio: 'inherit' })
console.log(`\n${zip}\nversion ${manifest.version}; permissions ${JSON.stringify(manifest.permissions)}; hosts ${JSON.stringify(manifest.host_permissions)}`)
