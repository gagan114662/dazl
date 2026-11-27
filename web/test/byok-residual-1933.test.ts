import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

// #1933 / #1703: no customer is asked for or told about their own AI key. Residual strings left on main after #1938/#1940.
const customerKey = /\b(?:AI|Anthropic(?: \(Claude\))?|Claude|model provider) keys?\b|\b(?:your|workspace.s own|free-search) (?:own |stored |active )?keys?\b/i

function literals(path: string): string[] {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) out.push(node.text.trim())
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

for (const path of ['app/app/readiness.tsx', 'app/app/plays/plays-client.tsx', 'app/app/first-run.tsx', 'app/app/leads/leads-client.tsx']) {
  test(`#1933 ${path} shows no customer AI-key copy`, () => {
    assert.deepEqual(literals(path).filter(s => customerKey.test(s)), [])
  })
}

test('#1933 control: unrelated reader-service wording about a key is untouched', () => {
  const hit = literals('app/app/leads/leads-client.tsx').filter(s => /rate limits requests without a key/.test(s))
  assert.equal(hit.length, 1)
  assert.equal(customerKey.test(hit[0]), false)
})

test('#1933 control: the scan and settings copy that is not about a key still renders', () => {
  const all = literals('app/app/leads/leads-client.tsx').join('\n')
  assert.match(all, /Discovery sources a scan here can use/)
  assert.match(all, /counts toward your monthly scans|count toward your monthly scans/)
})
