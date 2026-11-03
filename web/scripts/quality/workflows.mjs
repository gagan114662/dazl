import yaml from 'js-yaml';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function validateWorkflow(text) {
  const doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  if (!doc || typeof doc !== 'object' || !doc.on || !doc.jobs || typeof doc.jobs !== 'object' || !Object.keys(doc.jobs).length) throw new Error('workflow needs triggers and nonempty jobs');
  for (const [id, job] of Object.entries(doc.jobs)) {
    if (!job || typeof job !== 'object') throw new Error(`invalid job ${id}`);
    if (job.uses) continue; // Reusable workflow job, validated by GitHub on execution.
    if (!job['runs-on'] || !Array.isArray(job.steps) || !job.steps.length) throw new Error(`job ${id} needs runner and steps`);
    for (const step of job.steps) {
      if (!step || typeof step !== 'object' || (typeof step.run !== 'string' && typeof step.uses !== 'string')) throw new Error(`invalid step in ${id}`);
      if ('name' in step && typeof step.name !== 'string') throw new Error(`non-string step name in ${id}`);
    }
  }
  return Object.keys(doc.jobs);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dir = path.join(root, '.github/workflows');
  const files = (await readdir(dir)).filter(p => /\.ya?ml$/.test(p));
  if (!files.length) throw new Error('no workflows to validate');
  for (const file of files) console.log(`${file}: ${validateWorkflow(await readFile(path.join(dir, file), 'utf8')).join(', ')}`);
  console.log('Workflow syntax and basic job shape valid. This is not GitHub expression validation or evidence that jobs executed.');
}
