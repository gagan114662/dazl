// #1715 (public pages only): the privacy text must not leak internal test jargon, and Privacy and Terms must link back to the site and the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRIVACY, TERMS } from '../lib/legal/policy.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const text = (secs: { paragraphs: string[] }[]) => secs.flatMap(s => s.paragraphs).join('\n')

test('the privacy and terms text has no internal engineering jargon', () => {
  for (const t of [text(PRIVACY), text(TERMS)]) {
    assert.doesNotMatch(t, /tenant scoping/i)
    assert.doesNotMatch(t, /isolation tests/i)
  }
})

test('privacy and terms pages link back to the home page and to the app', () => {
  for (const f of ['app/privacy/page.tsx', 'app/terms/page.tsx']) {
    const src = readFileSync(join(root, f), 'utf8')
    assert.match(src, /href="\/"/, `${f} links home`)
    assert.match(src, /href="\/app"/, `${f} links to the app`)
  }
})
