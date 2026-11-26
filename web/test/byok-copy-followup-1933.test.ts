import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const paths = [
  "app/app/first-run.tsx",
  "app/app/manual-native-target-review.tsx",
  "app/app/social/social-client.tsx",
  "app/app/social/thread-metrics.tsx",
  "app/api/replies/[id]/route.ts",
  "app/app/seo/brief-panel.tsx",
  "app/app/seo/newsjack-panel.tsx",
  "app/api/seo/brief/route.ts",
  "app/api/seo/newsjack/route.ts",
  "app/api/scan/route.ts",
  "app/api/scan/icp/route.ts",
  "app/api/scan/icp-from-url/route.ts",
  "lib/error-copy.ts",
  "lib/readiness.ts",
  "lib/scan/scan-outcome.ts",
  "lib/scan/qa-provider-policy.ts",
  "lib/scan/price-estimate.ts",
  "lib/scan/site-read-copy.ts"
]

const customerKey = /\b(?:AI|Anthropic(?: \(Claude\))?|Claude|model provider) keys?\b|\b(?:your|workspace.s own|free-search) (?:own |stored |active )?keys?\b|\bwithout a key\b/i

for (const path of paths) {
  test(`#1933 ${path} has no customer AI-key copy`, () => {
    const source = ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    const violations: string[] = []
    function visit(node: ts.Node) {
      if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) && customerKey.test(node.text)) {
        violations.push(node.text.trim())
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.deepEqual(violations, [])
  })
}
