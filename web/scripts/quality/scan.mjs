// One process per revision bounds TypeScript program retention. Infrastructure
// failure exits nonzero; the parent records unavailable, never accepted debt.
import { readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { analyzer } from './policy.mjs';
import { evidenceFor } from './evidence.mjs';
const [cwd, output] = process.argv.slice(2);
const candidates = JSON.parse(await readFile(path.join(cwd, '.quality-inventory.json'), 'utf8'));
const lint = analyzer(cwd);
const records = [], excluded = [];
let analyzed = 0;
for (const filename of candidates) {
  const absolute = path.join(cwd, filename.slice(4));
  if (!(await lstat(absolute)).isFile()) throw new Error(`non-regular source: ${filename}`);
  if (await lint.isPathIgnored(absolute)) { excluded.push(filename); continue; }
  const source = await readFile(absolute, 'utf8');
  const result = await lint.lintText(source, { filePath: absolute, warnIgnored: false });
  if (result.length !== 1) throw new Error(`missing analysis: ${filename}`);
  records.push(...evidenceFor(filename, source, result[0].messages));
  analyzed++;
}
if (!analyzed) throw new Error('no files analyzed');
await writeFile(output, JSON.stringify({ records, coverage: { candidates: candidates.length, analyzed, excluded, findings: records.length } }));
console.log(`Analyzed ${analyzed} files; ${records.length} findings; ${excluded.length} explicit exclusions`);
