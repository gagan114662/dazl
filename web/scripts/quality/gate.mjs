import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzer, extensions, policyVersion } from './policy.mjs';
import { evidenceFor, newEvidence, digest } from './evidence.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.dirname(web);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const reportPath = arg('--report') ?? path.join(root, 'quality-report.json');
const report = { schema: 1, policyVersion, status: 'unavailable', coverage: {}, limitations: [
  'Static analysis is not proof of correctness, consent, tenant isolation, atomicity, UI placement or lead quality.',
  'Existing findings are debt, not a clean bill of health. Exact source-span identities prevent count-only swapping; edits to legacy findings may require fixing them.',
  'Typed async rules cover web/app and web/lib TypeScript. Other web JS/TS uses the untyped Next/ESLint policy. Python, shell, SQL, workers and dependencies are not analyzed here.',
  'Existing full engine, browser, migration, negative and live acceptance gates remain required. Quality-policy changes need independent review.',
] };
let scratch;
try {
  const baseInput = arg('--base');
  if (!baseInput || !/^[0-9a-f]{40}$/.test(baseInput)) throw new Error('--base requires a full verified commit SHA');
  const base = git('rev-parse', '--verify', `${baseInput}^{commit}`);
  const head = git('rev-parse', 'HEAD');
  git('merge-base', '--is-ancestor', base, head);
  if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('tracked working tree must be clean');
  Object.assign(report, { base, head });
  scratch = await mkdtemp(path.join(tmpdir(), 'dazl-quality-'));
  // Both revisions use the exact HEAD toolchain/config, not two drifting policies.
  const config = await readFile(path.join(web, 'eslint.config.mjs'));
  const configHash = digest(config);
  report.policy = { configHash, files: {} };
  for (const name of ['policy.mjs', 'evidence.mjs', 'gate.mjs']) report.policy.files[name] = digest(await readFile(path.join(web, 'scripts/quality', name)));
  const findings = {};
  for (const [label, sha] of [['base', base], ['head', head]]) {
    const tree = path.join(scratch, label);
    await mkdir(tree);
    const archive = execFileSync('git', ['archive', sha, 'web'], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', tree], { input: archive });
    const cwd = path.join(tree, 'web');
    // Symlink only the trusted installed dependency directory, never repository links.
    const { symlink } = await import('node:fs/promises');
    await symlink(path.join(web, 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
    await writeFile(path.join(cwd, 'eslint.config.mjs'), config);
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', sha, '--', 'web'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const candidates = tracked.filter(p => extensions.test(p));
    if (!candidates.length) throw new Error(`empty ${label} source inventory`);
    const lint = analyzer(cwd);
    const records = [];
    const excluded = [];
    let analyzed = 0;
    for (const filename of candidates) {
      const relative = filename.slice(4);
      const absolute = path.join(cwd, relative);
      if (!(await lstat(absolute)).isFile()) throw new Error(`non-regular source: ${filename}`);
      if (await lint.isPathIgnored(absolute)) { excluded.push(filename); continue; }
      const source = await readFile(absolute, 'utf8');
      const result = await lint.lintText(source, { filePath: absolute, warnIgnored: false });
      if (result.length !== 1) throw new Error(`missing analysis: ${filename}`);
      records.push(...evidenceFor(filename, source, result[0].messages));
      analyzed++;
    }
    if (!analyzed) throw new Error(`no ${label} files analyzed`);
    report.coverage[label] = { candidates: candidates.length, analyzed, excluded, findings: records.length };
    findings[label] = records;
  }
  report.newFindings = newEvidence(findings.base, findings.head);
  report.existingDebt = findings.head.length - report.newFindings.length;
  report.status = report.newFindings.length ? 'rejected' : 'passed';
} catch (error) {
  report.error = String(error.message);
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(`static-quality ${report.status}; report: ${reportPath}`);
if (report.error) console.error(report.error);
for (const f of report.newFindings ?? []) console.error(`${f.path}:${f.line}:${f.column} ${f.rule} [${f.identity.slice(0, 12)}]`);
process.exitCode = report.status === 'passed' ? 0 : 1;
