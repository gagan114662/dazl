#!/usr/bin/env node
// Release identity (issue #362). Two modes:
//   node ops/release-manifest.mjs write <web dir> [out.json]
//     After `npm run build`: what this release is. The commit (.build-commit), Next's BUILD_ID, the sha256 of every file
//     under .next/static (the chunks browsers load) and one sha256 over that list, the lockfile's sha256 and the PG
//     migrations it ships. CI uploads it as the run's release-<sha> artifact (release-gate.yml).
//   node ops/release-manifest.mjs check <manifest.json> <base url>
//     After a deploy: the server at <base url> serves exactly that release and is ready. /api/health/live reports the
//     manifest's commit; every file the manifest lists is fetched from /_next/static/ and its bytes hash to the
//     recorded sha256 (a different build, or the same commit and BUILD_ID with any chunk changed, fails); and
//     /api/ready answers 200 ok. Exit 0 only when all three hold; otherwise exit 1 with the reason. Prints one JSON line
//     (commit, build id, static files matched, readiness) either way. Loopback or https only.
// No secrets are read or written: only build output and file names.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [mode, a, b] = process.argv.slice(2)
const die = (why, code = 1) => { console.error(`release-manifest: ${why}`); process.exit(code) }
const sha256 = buf => createHash('sha256').update(buf).digest('hex')

function files(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...files(full, base)); else out.push(path.relative(base, full))
  }
  return out
}

if (mode === 'write') {
  const web = path.resolve(a ?? die('usage: release-manifest.mjs write <web dir> [out.json]', 2))
  const need = p => { const f = path.join(web, p); if (!existsSync(f)) die(`${p} missing: run npm run build first`); return f }
  const commit = readFileSync(need('.build-commit'), 'utf8').trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) die(`.build-commit is not a full commit sha`)
  const static_ = need('.next/static')
  const tree = createHash('sha256')
  const list = files(static_)
  const hashes = {}
  for (const f of list) { hashes[f] = sha256(readFileSync(path.join(static_, f))); tree.update(f + '\0' + hashes[f] + '\n') }
  const manifest = {
    commit,
    build_id: readFileSync(need('.next/BUILD_ID'), 'utf8').trim(),
    static_files: list.length,
    static_sha256: tree.digest('hex'),
    static: hashes,
    lockfile_sha256: sha256(readFileSync(need('package-lock.json'))),
    pg_migrations: readdirSync(need('lib/db/migrations/pg')).filter(f => f.endsWith('.sql')).sort(),
    node: process.version,
    built_at: new Date().toISOString(),
  }
  const json = JSON.stringify(manifest, null, 2) + '\n'
  if (b) writeFileSync(b, json); else process.stdout.write(json)
  if (b) console.log(`release-manifest: ${commit} build ${manifest.build_id}, ${list.length} static files -> ${b}`)
} else if (mode === 'check') {
  if (!a || !b) die('usage: release-manifest.mjs check <manifest.json> <base url>', 2)
  const m = JSON.parse(readFileSync(a, 'utf8'))
  const base = new URL(b)
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) die('base url must be https or loopback', 2)
  const get = async p => { try { const r = await fetch(new URL(p, base), { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.text() } } catch (e) { return { status: 0, body: String(e?.name ?? e) } } }
  const problems = []
  const live = await get('/api/health/live')
  let served = null; try { served = JSON.parse(live.body).commit ?? null } catch { /* reported below */ }
  if (served !== m.commit) problems.push(`serves commit ${JSON.stringify(served)} (HTTP ${live.status}), expected ${m.commit}`)
  // every recorded static file, its served bytes against its recorded sha256 (8 requests at a time)
  const want = Object.entries(m.static ?? {})
  if (!want.length) problems.push('the manifest lists no static files (written by an older release-manifest.mjs)')
  // the build id is part of the identity: its own build manifest must be one of the files checked
  else if (!(m.static ?? {})[path.join(m.build_id, '_buildManifest.js')]) problems.push(`build ${m.build_id}: its _buildManifest.js is not among the manifest's static files`)
  const bad = []
  for (let i = 0; i < want.length; i += 8) {
    await Promise.all(want.slice(i, i + 8).map(async ([f, h]) => {
      try {
        const r = await fetch(new URL('/_next/static/' + f.split(path.sep).map(encodeURIComponent).join('/'), base), { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15_000) })
        const got = r.status === 200 ? sha256(Buffer.from(await r.arrayBuffer())) : null
        if (got !== h) bad.push(`${f} (${r.status === 200 ? 'different bytes' : `HTTP ${r.status}`})`)
      } catch (e) { bad.push(`${f} (${e?.name ?? 'error'})`) }
    }))
  }
  if (bad.length) problems.push(`${bad.length} of ${want.length} static files differ from the manifest: ${bad.sort().slice(0, 3).join(', ')}`)
  const ready = await get('/api/ready')
  let readyOk = false, failed = []
  try { const r = JSON.parse(ready.body); readyOk = ready.status === 200 && r.ok === true; failed = Object.entries(r.checks ?? {}).filter(([, c]) => c && c.ok === false).map(([k]) => k) } catch { /* not JSON */ }
  if (!readyOk) problems.push(`not ready (HTTP ${ready.status}${failed.length ? `; failed: ${failed.join(', ')}` : ''})`)
  console.log(JSON.stringify({ base: base.origin, commit: served, expected_commit: m.commit, build_id: m.build_id, static_matched: `${want.length - bad.length}/${want.length}`, ready: readyOk, ok: problems.length === 0 }))
  if (problems.length) die(problems.join('; '))
} else {
  die('usage: release-manifest.mjs write <web dir> [out.json] | check <manifest.json> <base url>', 2)
}
