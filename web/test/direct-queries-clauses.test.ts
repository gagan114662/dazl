import { test } from 'node:test'
import assert from 'node:assert/strict'
import { directQueries, rolePhrases, roleRequestText } from '../lib/search/direct-queries.ts'

// Instruction clauses are not roles. The two live acceptance requests (#204, 2026-10-26) are reconstructed from their
// description in that issue (the verbatim saved text is not available to the builder), so these fixtures show the failure
// class, not the exact saved jobs: before this change the applicant-tracking queries searched for instruction fragments.
const NYC = 'Find independent dental practices in NYC hiring a receptionist or office manager in the past 90 days. Exclude chains and dental software companies. I need a dated source and a practice manager contact.'
const LONDON = 'London companies with 10-50 employees that raised seed funding within the past 90 days and are hiring sales staff. Exclude agencies and recruiters. I need founder contacts and dated evidence.'

test('NYC-style request: roles are the hiring roles only, not "exclude chains" / "dated source" / the window', () => {
  assert.deepEqual(rolePhrases(NYC, ['hiring a receptionist'], ['New York City']), ['receptionist', 'office manager'])
  const q = directQueries(NYC, ['hiring a receptionist'], ['New York City'])
  assert.equal(q.length, 2); for (const x of q) { assert.match(x, /\("receptionist" OR "office manager"\) New York City$/); assert.doesNotMatch(x, /exclude|dated|past|practice manager contact/i) }
})

test('London-style request: the funding clause and the instruction clauses are not roles; the hiring role is', () => {
  assert.deepEqual(rolePhrases(LONDON, ['seed funding', 'sales hiring'], ['London']), ['sales'])
  for (const x of directQueries(LONDON, ['seed funding', 'sales hiring'], ['London'])) { assert.match(x, /"sales" London$/); assert.doesNotMatch(x, /exclude|founder|dated|seed|raised|past/i) }
})

test('the cut removes only words: no role, host or place is added, and an all-instruction request yields no queries', () => {
  assert.match(roleRequestText('Exclude chains. I need founder contacts and dated evidence in the last 90 days'), /^(?:\.\s*)+$/, 'only separators remain')
  assert.deepEqual(directQueries('hiring: exclude chains, I need a dated source in the past 30 days', [], ['Ohio']), [])
  const t = roleRequestText(NYC); assert.ok(!/exclude|need|past 90/i.test(t)); assert.match(t, /receptionist or office manager/)
})

test('other languages: exclusion and window clauses are cut in pt, es, fr, de', () => {
  assert.deepEqual(rolePhrases('Empresas em Lisboa que contratam recepcionista nos últimos 90 dias. Exclua redes. Preciso de contactos do gerente.', [], ['Lisboa']), ['recepcionista'])
  assert.deepEqual(rolePhrases('Empresas en Madrid contratando recepcionista en los últimos 60 días, sin cadenas, necesito el contacto del gerente', [], ['Madrid']), ['recepcionista'])
  assert.deepEqual(rolePhrases('Entreprises à Paris qui recrutent un réceptionniste, sans chaînes, besoin du contact du directeur', [], ['Paris']), ['réceptionniste'])
  assert.deepEqual(rolePhrases('Unternehmen in Berlin, die einen Empfangsmitarbeiter suchen, ohne Ketten, brauche den Kontakt der Leitung', [], ['Berlin']), ['empfangsmitarbeiter'])
})

test('controls: requests with no instruction clause and no funding clause extract exactly as before', () => {
  assert.deepEqual(rolePhrases('Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job', [], ['Ohio']), ['payroll', 'hr', 'office manager'])
  assert.deepEqual(rolePhrases('startups hiring a head of sales and a marketing manager in Berlin', [], ['Berlin']), ['head of sales', 'marketing manager'])
  // a funding word inside a hiring part is kept (the part also talks about hiring)
  assert.deepEqual(rolePhrases('companies hiring a venture partner', [], []), ['venture partner'])
})

// Spanish verb forms missed by the hiring-word list ("contratan", "contrata") meant NO hiring-board queries for requests like
// "Empresas en Madrid que contratan recepcionista"; the role phrase also swallowed the verb ("contratan recepcionista").
test('Spanish "contratan"/"contrata" count as hiring words and do not leak into the role phrase', () => {
  for (const r of ['Empresas en Madrid que contratan recepcionista', 'Clínicas en Madrid que contrata recepcionista', 'Empresas de Madrid con contratación de recepcionista']) {
    assert.deepEqual(rolePhrases(r, [], ['Madrid']), ['recepcionista'], r)
    const q = directQueries(r, [], ['Madrid']); assert.equal(q.length, 2, r); assert.match(q[0], /"recepcionista" Madrid$/)
  }
})
