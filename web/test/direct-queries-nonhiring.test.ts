import test from 'node:test'
import assert from 'node:assert/strict'
import { directQueries } from '../lib/search/direct-queries.ts'

test('a request that is not about hiring gets no ATS queries', () => {
  assert.deepEqual(directQueries('Find Ohio companies that just raised a seed round', ['seed round'], ['Ohio']), [])
})
test('no place in the profile: no direct queries (never every state)', () => {
  assert.deepEqual(directQueries('Find companies hiring a payroll specialist', ['payroll job'], []), [])
})
test('role words come from the request and signals, minus places, sizes and generic words', () => {
  const q = directQueries('Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job', ['payroll job'], ['Ohio'])
  assert.equal(q.length, 2); assert.ok(q.every(x => x.endsWith(' Ohio') && x.includes('(payroll OR hr OR office OR manager)')))
})
test('no usable role word: no direct queries', () => {
  assert.deepEqual(directQueries('Find Ohio companies hiring', [], ['Ohio']), [])
})
