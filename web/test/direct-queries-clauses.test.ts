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

// Instinct review of #220 (HOLD): a NEGATED hiring clause must not become affirmative job-board searches for the excluded role.
test('negated hiring clauses are not searched: es/pt/en/fr/de, positive clauses and explicit exclusions are unchanged', () => {
  for (const [r, place] of [
    ['Empresas en Madrid que no contratan recepcionista', 'Madrid'],
    ['Empresas en Madrid que no contratan', 'Madrid'],
    ['Empresas em Lisboa que não contratam recepcionista', 'Lisboa'],
    ['Companies in Austin that are not hiring a receptionist', 'Austin'],
    ['Companies in Austin that aren’t hiring a receptionist', 'Austin'],
    ['Entreprises à Paris qui ne recrutent pas de réceptionniste', 'Paris'],
    ['Unternehmen in Berlin, die nicht suchen einen Empfangsmitarbeiter', 'Berlin'],
  ] as const) assert.deepEqual(directQueries(r, [], [place]), [], r)
  assert.deepEqual(directQueries('Empresas en Madrid que no contratan recepcionista', ['no contratan recepcionista'], ['Madrid']), [], 'negated profile signal too')
  // a positive clause beside a negated one still searches only the positive role
  const q = directQueries('Empresas en Madrid que contratan gerente, no contratan recepcionista', [], ['Madrid'])
  assert.equal(q.length, 2); for (const x of q) { assert.match(x, /"gerente" Madrid$/); assert.doesNotMatch(x, /recepcionista/) }
  // positive requirement clause and explicit exclusion probes unchanged
  assert.equal(directQueries('Necesito empresas en Madrid que contratan recepcionista', [], ['Madrid']).length, 2)
  assert.equal(directQueries('Empresas en Madrid que contratan recepcionista. Excluir cadenas', [], ['Madrid']).length, 2)
  assert.equal(directQueries('companies hiring a receptionist in Austin', [], ['Austin']).length, 2)
  // "subcontratación" is not a hiring word
  assert.deepEqual(directQueries('Empresas de subcontratación en Madrid', [], ['Madrid']), [])
})

test('conjunction-joined positive hiring clause survives a negated one, in both orders (#220 re-review)', () => {
  for (const [req, role, off] of [
    ['Empresas en Madrid que no contratan recepcionista y contratan gerente', 'gerente', 'recepcionista'],
    ['Empresas en Madrid que contratan gerente y no contratan recepcionista', 'gerente', 'recepcionista'],
    ['Companies in Madrid that are not hiring a receptionist and are hiring a manager', 'manager', 'receptionist'],
    ['Companies in Madrid hiring a manager and not hiring a receptionist', 'manager', 'receptionist'],
  ]) {
    const q = directQueries(req, [], ['Madrid'])
    assert.ok(q.length > 0, req)
    for (const x of q) { assert.match(x, new RegExp(role)); assert.doesNotMatch(x, new RegExp(off)) }
  }
  // a conjunction before a plain role (no new hiring clause) stays inside the negation
  assert.deepEqual(directQueries('Empresas en Madrid que no contratan recepcionista y cocinero', [], ['Madrid']), [])
})

test('a short negated exclusion after a positive clause is not added as a role (#220 re-review)', () => {
  for (const [req, role, off] of [
    ['Empresas en Madrid que contratan recepcionista, no agencias', 'recepcionista', 'agencias'],
    ['Companies in Madrid hiring a receptionist, not agencies', 'receptionist', 'agencies'],
  ]) {
    const q = directQueries(req, [], ['Madrid'])
    assert.ok(q.length > 0, req)
    for (const x of q) { assert.match(x, new RegExp(role)); assert.doesNotMatch(x, new RegExp(off)) }
  }
})

// Instinct re-review of #220 at fa0490b: the exclusion cut swallowed a POSITIVE hiring clause after it. Clause-level now:
// negative segments are dropped, positive hiring segments around them are kept, in either order, at commas and conjunctions.
const roles = (r: string, where = ['Madrid']) => rolePhrases(r, [], where)
test('reported cases: a positive hiring clause after an exclusion is preserved, the excluded group is not searched', () => {
  assert.deepEqual(roles('Empresas en Madrid, no agencias y que contratan recepcionista'), ['recepcionista'])
  assert.equal(directQueries('Empresas en Madrid, no agencias y que contratan recepcionista', [], ['Madrid']).length, 2)
  assert.deepEqual(roles('contratan recepcionista, no agencias y contratan gerente'), ['recepcionista', 'gerente'])
  assert.deepEqual(roles('not agencies but hiring a manager', ['London']), ['manager'])
  for (const x of directQueries('not agencies but hiring a manager', [], ['London'])) { assert.match(x, /"manager" London$/); assert.doesNotMatch(x, /agenc/i) }
})

test('both clause orders, comma and conjunction boundaries', () => {
  const L = ['London']
  assert.deepEqual(roles('hiring a receptionist, not agencies', L), ['receptionist'])
  assert.deepEqual(roles('not agencies, hiring a receptionist', L), ['receptionist'])
  assert.deepEqual(roles('hiring a receptionist but not agencies', L), ['receptionist'])
  assert.deepEqual(roles('companies hiring a receptionist and not agencies', L), ['receptionist'])
  assert.deepEqual(roles('not agencies and hiring a receptionist', L), ['receptionist'])
  assert.deepEqual(roles('no contratan recepcionista y contratan gerente'), ['gerente'])
  assert.deepEqual(roles('contratan gerente y no contratan recepcionista'), ['gerente'])
  assert.deepEqual(roles('no contratan recepcionista y cocinero'), [], 'a conjunction before a plain role does not end a negated clause')
  assert.deepEqual(roles('don\'t hire a receptionist and hire a manager', L), ['manager'])
  assert.deepEqual(roles('ne recrutent pas de réceptionniste mais recrutent un directeur', ['Paris']), ['directeur'])
  assert.deepEqual(roles('suchen keinen Empfangsmitarbeiter, aber suchen einen Leiter', ['Berlin']), ['leiter'])
  assert.deepEqual(roles('não contratam recepcionista mas contratam gerente', ['Lisboa']), ['gerente'])
})

test('multiple positives and multiple negatives', () => {
  const L = ['London']
  assert.deepEqual(roles('hiring a receptionist, not agencies, not chains, hiring a manager', L), ['receptionist', 'manager'])
  assert.deepEqual(roles('not agencies and not chains but hiring a receptionist or office manager', L), ['receptionist', 'office manager'])
  assert.deepEqual(roles('hiring a receptionist, hiring a manager, hiring a nurse, not agencies', L), ['receptionist', 'manager', 'nurse'])
  // an exclusion list continues after the negation, until a positive hiring clause ends it
  assert.deepEqual(roles('hiring a receptionist, no agencias, cadenas ni franquicias, contratan gerente'), ['receptionist', 'gerente'])
  assert.deepEqual(roles('exclude chains and dental software companies, hiring a receptionist', L), ['receptionist'])
  assert.deepEqual(roles('exclude agencies and recruiters, hiring a receptionist', L), ['receptionist'], '"recruiters" in an exclusion list is not a hiring clause')
  assert.deepEqual(roles('hiring a receptionist. Exclude agencies and recruiters.', L), ['receptionist'])
})

test('safety: excluded words are never searched; "non-profit" and place "en" are not negations or conjunctions', () => {
  const L = ['London']
  for (const r of ['hiring a receptionist, not agencies', 'not agencies but hiring a receptionist', 'no agencias y que contratan recepcionista']) for (const q of directQueries(r, [], ['London'])) assert.doesNotMatch(q, /agenc/i, r)
  assert.deepEqual(roles('non-profit organizations hiring a manager', L), ['manager'])
  assert.deepEqual(roles('Empresas en Madrid que contratan recepcionista'), ['recepcionista'])
  assert.deepEqual(roles('only hiring negations: do not hire a receptionist', L), [])
  assert.deepEqual(directQueries('do not hire a receptionist, no agencies', [], L), [], 'only negated hiring words: no direct queries')
})
