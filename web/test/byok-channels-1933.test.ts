import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHANNELS } from '../lib/channels.ts'

// #1933 / #1703: the Settings connector list must not send the customer to their own model provider or key.
const ownProvider = /\b(?:your|their) own (?:model |AI |API )?(?:provider|key)|\bmodel provider\b|\bAI key\b/i

test('#1933 no channel note refers to the customer\'s own model provider or key', () => {
  assert.deepEqual(CHANNELS.filter(c => ownProvider.test(c.note ?? '')).map(c => c.id), [])
})

test('#1933 control: other channel notes keep their wording, including the plain "No key." lines', () => {
  const github = CHANNELS.find(c => c.id === 'github')
  assert.match(github?.note ?? '', /No key\./)
  const search = CHANNELS.find(c => c.id === 'search')
  assert.match(search?.note ?? '', /A paid search service is not used\./)
  assert.equal(ownProvider.test(github?.note ?? ''), false)
})
