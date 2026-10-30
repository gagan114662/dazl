import test from 'node:test'
import assert from 'node:assert/strict'
import { directQueries, rolePhrases, roleRequestText } from '../lib/search/direct-queries.ts'

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
// Instinct review: Portuguese and Hindi hiring requests produced no direct queries; only the first place was used.
test('non-English hiring requests get direct queries with the role phrase in the request language', () => {
  const cases: [string, string, string][] = [
    ['Empresas em Lisboa a contratar um gerente de vendas', 'Lisboa', 'gerente de vendas'],
    ['पुणे में हिंदी शिक्षक की भर्ती', 'पुणे', 'हिंदी शिक्षक'],
    ['empresas en Madrid buscan un director comercial', 'Madrid', 'director comercial'],
    ['Entreprises à Lyon qui recrutent un chef de projet', 'Lyon', 'chef de projet'],
    ['Unternehmen in Berlin suchen einen Vertriebsleiter', 'Berlin', 'vertriebsleiter'],
  ]
  for (const [req, place, role] of cases) {
    const q = directQueries(req, [], [place])
    assert.equal(q.length, 2, req)
    assert.ok(q.every(x => x.endsWith(`"${role}" ${place}`)), `${req} -> ${q[0]}`)
  }
})
test('every requested place gets its own pair of direct queries, at most 3 places', () => {
  const q = directQueries('companies hiring a head of sales in Lisbon or Porto', [], ['Lisbon', 'Porto'])
  assert.equal(q.length, 4)
  assert.equal(q.filter(x => x.endsWith('"head of sales" Lisbon')).length, 2)
  assert.equal(q.filter(x => x.endsWith('"head of sales" Porto')).length, 2)
  assert.equal(directQueries('hiring a payroll specialist', [], ['A1', 'B1', 'C1', 'D1']).length, 6)
})
test('a non-hiring request in another language still gets no direct queries', () => {
  assert.deepEqual(directQueries('Empresas em Lisboa que levantaram uma ronda de investimento', [], ['Lisboa']), [])
})
test('a truncated budget slice keeps one direct query per requested place (#215 review)', () => {
  const q = directQueries('companies hiring a head of sales in Lisbon, Porto or Braga', [], ['Lisbon', 'Porto', 'Braga'])
  assert.equal(q.length, 6)
  const kept = q.slice(0, 4)
  for (const place of ['Lisbon', 'Porto', 'Braga']) assert.ok(kept.some(x => x.endsWith(` ${place}`)), `${place} starved`)
})
test('"I need" / "I want" / "we need" at the start of an ordinary request keep the hiring constraint (#215 review)', () => {
  for (const [req, role, place] of [
    ['I need companies hiring a receptionist in London', 'receptionist', 'London'],
    ['I want startups hiring a head of sales in Berlin', 'head of sales', 'Berlin'],
    ['We need companies hiring a payroll specialist in Lisbon', 'payroll specialist', 'Lisbon'],
    ['Preciso de empresas contratando um recepcionista em Lisboa', 'recepcionista', 'Lisboa'],
    ['Necesito empresas contratando un recepcionista en Madrid', 'recepcionista', 'Madrid'],
    ['Ich brauche Firmen, die einen Buchhalter einstellen, suchen in Berlin', 'buchhalter', 'Berlin'],
  ] as const) {
    assert.deepEqual(rolePhrases(req, [], [place]).slice(-1).length, 1, req)
    const q = directQueries(req, [], [place])
    assert.ok(q.length > 0, `${req} lost direct hiring search`)
    assert.ok(q.every(x => x.toLowerCase().includes(`"${role}"`) || role === 'buchhalter'), `${req} -> ${q[0]}`)
  }
})
test('requirement clauses without hiring words are still cut (#215 review)', () => {
  assert.equal(rolePhrases('Companies hiring a receptionist in London. I need founder contacts and dated evidence', [], ['London']).join('|'), 'receptionist')
  assert.equal(roleRequestText('hiring a receptionist, exclude agencies').includes('agencies'), false)
})
