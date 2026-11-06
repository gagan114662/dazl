// node:test reporter used only by scripts/gate-check.mjs. Emits one JSON line per finished test (not per suite)
// so the gate can count what actually executed: name, pass/fail, and whether it was skipped or todo.
// A file-level failure (import crash, syntax error) is a test:fail with nesting 0, which is counted as a failure.
export default async function* gateReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const d = event.data ?? {}
    if (d.details?.type === 'suite') continue
    yield `${JSON.stringify({
      gate: 1,
      name: typeof d.name === 'string' ? d.name : String(d.name),
      file: d.file ?? null,
      ok: event.type === 'test:pass',
      skip: d.skip !== undefined && d.skip !== false,
      todo: d.todo !== undefined && d.todo !== false,
    })}\n`
  }
}
