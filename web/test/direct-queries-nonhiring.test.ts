import test from 'node:test'
import assert from 'node:assert/strict'
import { directQueries, rolePhrases } from '../lib/search/direct-queries.ts'

test('a request that is not about hiring gets no ATS queries', () => {
  assert.deepEqual(directQueries('Find Ohio companies that just raised a seed round', ['seed round'], ['Ohio']), [])
})
test('no place in the profile: no direct queries (never every state)', () => {
  assert.deepEqual(directQueries('Find companies hiring a payroll specialist', ['payroll job'], []), [])
})
test('role phrases come from the request, minus places, sizes and generic words; quoted so "manager" alone never matches', () => {
  const q = directQueries('Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job', ['payroll job'], ['Ohio'])
  assert.equal(q.length, 2); assert.ok(q.every(x => x.endsWith(' Ohio') && x.includes('("payroll" OR "hr" OR "office manager")')))
  assert.ok(q.every(x => !/\bmanager\b(?!")/.test(x.replace('"office manager"', ''))))
})
test('multi-word roles stay whole, "of" is kept inside a role, places outside the US work', () => {
  assert.deepEqual(rolePhrases('companies hiring a head of sales in Lisbon', [], ['Lisbon']), ['head of sales'])
  assert.deepEqual(rolePhrases('Pune schools hiring Hindi teachers', [], ['Pune']), ['hindi teachers'])
  assert.ok(directQueries('Pune schools hiring Hindi teachers', [], ['Pune'])[0].endsWith('"hindi teachers" Pune'))
})
test('profile signals are used only when the request names no role', () => {
  assert.deepEqual(rolePhrases('Find Ohio companies hiring', ['payroll specialist job'], ['Ohio']), ['payroll specialist'])
  assert.deepEqual(rolePhrases('companies hiring a payroll specialist', ['office manager job'], ['Ohio']), ['payroll specialist'])
})
test('no usable role word: no direct queries', () => {
  assert.deepEqual(directQueries('Find Ohio companies hiring', [], ['Ohio']), [])
})
