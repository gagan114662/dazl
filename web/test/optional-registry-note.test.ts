import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OptionalRegistryNote } from '../app/app/optional-registry-note.ts'

test('permit/licence availability is supplemental copy, not an activation nor search prerequisite', () => {
  const html = renderToStaticMarkup(OptionalRegistryNote())
  assert.match(html, /Public permits and business licences can be bonus evidence where available\. They’re not checked by default or required to run a search\./)
  assert.doesNotMatch(html, /<(button|select|input|a|form)\b/)
})
