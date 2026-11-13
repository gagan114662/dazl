// Writes the prod-prebuilt manifest (.github/workflows/prod-prebuilt.yml): commit, the runner's arch and Node ABI, the
// lockfile's sha256, and for each archive its sha256, compressed size and unpacked size (the box's disk check needs the
// unpacked size before it downloads anything: ops/prod/pull-release.sh).
// Usage: node ops/prod/prebuilt-manifest.mjs <dir> <40-hex sha> <package-lock.json>
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const [dir, sha, lock] = process.argv.slice(2)
if (!dir || !/^[0-9a-f]{40}$/.test(sha ?? '') || !lock) { console.error('usage: prebuilt-manifest.mjs <dir> <sha> <package-lock.json>'); process.exit(2) }
const hash = (f) => new Promise((ok, no) => { const h = createHash('sha256'); createReadStream(f).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', no) })
// the sum of the archive's regular-file sizes (`tar -tvzf`: the size is column 3)
const unpacked = (f) => execFileSync('tar', ['-tvzf', f], { maxBuffer: 1 << 30 }).toString().split('\n').filter((l) => l.startsWith('-')).reduce((n, l) => n + Number(l.trim().split(/\s+/)[2] || 0), 0)
const entry = async (file) => { const p = path.join(dir, file); return { file, sha256: await hash(p), bytes: statSync(p).size, unpacked_bytes: unpacked(p) } }
const m = {
  commit: sha,
  arch: process.arch,
  node_abi: process.versions.modules,
  node: process.version,
  lock_sha256: createHash('sha256').update(readFileSync(lock)).digest('hex'),
  next: await entry(`prod-next-${sha}.tgz`),
  modules: await entry(`prod-modules-${sha}.tgz`),
  run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
}
writeFileSync(path.join(dir, `prod-prebuilt-${sha}.json`), JSON.stringify(m, null, 2) + '\n')
console.log(JSON.stringify(m, null, 2))
