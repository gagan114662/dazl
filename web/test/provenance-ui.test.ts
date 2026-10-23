import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (name: string) => readFileSync(new URL(`../app/app/outreach/${name}-client.tsx`, import.meta.url), 'utf8')
test('human and withdrawn provenance notices use dark text and a black border, not color alone', () => {
  for (const name of ['outreach', 'sequences']) {
    const text = read(name)
    const paragraphs = [...text.matchAll(/<p className="([^"]+)">(Lead confirm[^<]+)<\/p>/g)]
    assert.equal(paragraphs.length, 2)
    for (const p of paragraphs) {
      assert.match(p[1], /text-\[#[13]{3}\]/)
      assert.match(p[1], /border-l-2 border-\[#111\] pl-3/)
      assert.doesNotMatch(p[1], /yellow|red|opacity/)
    }
  }
})
test('withdrawn drafts expose neither approval, sending nor sequence creation', () => {
  const text = read('outreach')
  for (const action of ['Approve', 'Send now', 'Create 3-step sequence (templates)']) {
    const line = text.split('\n').find(l => l.includes(`>${action}</button>`))
    assert.ok(line)
    assert.match(line, /m\.evidence_state !== 'unverified' &&/)
  }
})
test('withdrawn sequence does not expose approval while edit and stop remain available', () => {
  const text = read('sequences')
  assert.match(text, /s\.evidence_state!=='unverified'&&s\.status==='draft'&&<button[^\n]+>Approve exact words/)
  assert.match(text, />Edit step /)
  assert.match(text, />Stop sequence</)
})
