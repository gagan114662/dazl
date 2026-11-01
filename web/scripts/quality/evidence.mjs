// Inspired by REA's EvidenceLedger and CdpCaptureCompleteness: validate before
// committing evidence, deduplicate semantic identity, report unknowns explicitly.
// Independently implemented for lint output; no REA runtime or copied source.
import { createHash } from 'node:crypto';
export const digest = text => createHash('sha256').update(text).digest('hex');

export function sourceSpan(source, m) {
  const lines = source.split('\n');
  const start = m.line - 1;
  if (!Number.isInteger(start) || start < 0 || start >= lines.length) throw new Error('invalid finding location');
  const end = (m.endLine ?? m.line) - 1;
  if (end < start || end >= lines.length) throw new Error('invalid finding end');
  // Include complete affected lines: ESLint's eval span can cover only the
  // callee, which would hide a changed argument under a count-only identity.
  return lines.slice(start, end + 1).map(line => line.trim()).join('\n');
}

export function evidenceFor(path, source, messages) {
  // Stage the whole batch. Fatal parse/config errors never become accepted debt.
  const staged = messages.map(m => {
    if (m.fatal || !m.ruleId || ![1, 2].includes(m.severity)) throw new Error(`unavailable analysis: ${path}:${m.line ?? 0} (${m.ruleId ?? 'parse/config'})`);
    const identity = digest(JSON.stringify([path, m.ruleId, m.severity, m.messageId ?? m.message.split('\n\n')[0], sourceSpan(source, m)]));
    return Object.freeze({ identity, path, rule: m.ruleId, severity: m.severity, line: m.line, column: m.column });
  });
  return Object.freeze(staged);
}

export function newEvidence(base, head) {
  const remaining = new Map();
  for (const f of base) remaining.set(f.identity, (remaining.get(f.identity) ?? 0) + 1);
  return head.filter(f => {
    const count = remaining.get(f.identity) ?? 0;
    if (!count) return true;
    remaining.set(f.identity, count - 1);
    return false;
  });
}
