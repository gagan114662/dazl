// #391: script-aware text handling. Synthetic names; no model, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scriptOf, fold, tokenize, keywords, nameTokens, entityKey, nameForms, sameName, linkQuote, quoteOnPage, expandMarkets, MAX_MARKETS } from '../lib/text/script.ts'
import { keywordsFor } from '../lib/sources/index.ts'
import { nameTokens as signalNameTokens } from '../lib/signals/index.ts'
import { tokens } from '../lib/scan/lookalike.ts'

test('scripts are identified; any kana makes text Japanese', () => {
  assert.deepEqual(['Harbor Dental', 'شركة النور', 'नूर टेक्नोलॉजीज', '東京の歯科医院', 'トヨタ', '서울 치과', 'Москва', 'Αθήνα', 'กรุงเทพ', 'תל אביב'].map(scriptOf), ['latin', 'arabic', 'devanagari', 'kana', 'kana', 'hangul', 'cyrillic', 'greek', 'thai', 'hebrew'])
  assert.equal(scriptOf('北京公司'), 'han')
})

test('Arabic / Hindi / Japanese company names produce meaningful keywords and tokens (the ASCII tokenizers produced none)', () => {
  assert.deepEqual(['شركة النور للتقنية', 'नूर टेक्नोलॉजीज़ प्राइवेट लिमिटेड', '東京歯科クリニック'].map(n => nameTokens(n).length > 0), [true, true, true])
  assert.deepEqual(nameTokens('شركة النور للتقنية'), ['النور', 'للتقنية'])                  // legal form شركة dropped, name kept
  assert.deepEqual(nameTokens('नूर टेक्नोलॉजीज़ प्राइवेट लिमिटेड'), ['नूर', 'टेक्नोलॉजीज़'])    // Devanagari signs kept; legal words dropped
  assert.ok(nameTokens('トヨタ株式会社').includes('トヨタ')); assert.ok(!nameTokens('トヨタ株式会社').some(t => t.includes('株式会社')))
  assert.ok(keywords('مطاعم تبحث عن مدير مبيعات في الرياض').length >= 3)
  assert.ok(keywords('営業マネージャーを募集している歯科医院').length >= 2)
  assert.ok(keywords('बिक्री प्रबंधक की भर्ती करने वाली कंपनियां').includes('बिक्री'))
  // the three previously ASCII-only call sites now work
  assert.ok(keywordsFor('मुंबई में रेस्तरां').length > 0); assert.ok(signalNameTokens('نور للتقنية').length > 0); assert.ok(tokens('مطعم جديد في دبي يوظف مدير مبيعات').size > 0)
})

test('Latin behaviour is unchanged: keywords keep c++/node.js, stop words and suffixes are dropped, diacritics fold', () => {
  assert.deepEqual(keywordsFor('Find companies hiring node.js and C++ engineers recently'), ['hiring', 'node.js', 'engineers'])
  assert.deepEqual(signalNameTokens('Acme Robotics, Inc.'), ['acme', 'robotics']); assert.deepEqual(signalNameTokens('Acme-Labs AI'), ['acme'])
  assert.equal(fold('Zürich Café'), 'zurich cafe'); assert.equal(fold('ＡＢＣ'), 'abc')
})

test('Hindi vowel signs are not stripped, so different words are not merged; Arabic marks and variants unify', () => {
  assert.notEqual(fold('कमल'), fold('कम')); assert.notEqual(fold('की'), fold('कि'))
  assert.equal(fold('أحمد'), fold('احمد')); assert.equal(fold('الـنُّور'), fold('النور'))
})

test('same-name entities stay separate: domain identifies, otherwise name + country; unknown country is its own bucket', () => {
  assert.notEqual(entityKey({ name: 'Al Noor Trading', country: 'AE' }), entityKey({ name: 'Al Noor Trading', country: 'IN' }))
  assert.notEqual(entityKey({ name: 'Al Noor Trading', country: 'AE' }), entityKey({ name: 'Al Noor Trading' }))
  assert.equal(entityKey({ name: 'Al Noor', domain: 'https://www.alnoor.example/x' }), entityKey({ name: 'Different Name', domain: 'alnoor.example' }))
  assert.equal(entityKey({ name: 'شركة النور', country: 'ae' }), entityKey({ name: 'النور للتقنية'.slice(0, 5), country: 'AE' }))
})

test('original text is kept beside translations / transliterations; matching via a form names the form', () => {
  const ar = nameForms('شركة النور', { translated: 'Al Noor Company', transliterated: 'Sharikat Al Noor' }), en = nameForms('Al Noor')
  assert.equal(ar.original, 'شركة النور'); assert.equal(ar.lang, 'arabic')
  assert.deepEqual(sameName(ar, en), { same: true, via: 'translated' }); assert.deepEqual(sameName(ar, nameForms('Other Co')), { same: false, via: null })
  assert.equal(sameName(nameForms('Al Noor'), nameForms('Al  Noor ')).via, 'original')
})

test('code-mixed names: Latin + Japanese tokens both survive', () => {
  const t = nameTokens('Tokyo Smile 歯科クリニック'); assert.ok(t.includes('tokyo') && t.includes('smile') && t.some(x => /歯科|クリニック/.test(x)))
})

test('a translated quote links to its original: only the original is checked against the page', () => {
  const q = linkQuote('نحن نوظف مدير مبيعات جديد', 'We are hiring a new sales manager', 'https://harbor.example/jobs')
  assert.equal(q.original, 'نحن نوظف مدير مبيعات جديد'); assert.equal(q.lang, 'arabic'); assert.equal(q.source_url, 'https://harbor.example/jobs')
  assert.equal(quoteOnPage(q, 'الوظائف  نحن نوظف  مدير مبيعات جديد في دبي'), true)
  assert.equal(quoteOnPage({ ...q, original: 'We are hiring a new sales manager' }, 'الوظائف نحن نوظف مدير مبيعات جديد'), false, 'the translation alone is not on the page')
})

test('multi-country multilingual geography expands into explicit bounded market tasks; overflow and unknown places are reported', () => {
  const r = expandMarkets(['India', 'UAE', 'Japan', 'Atlantis'])
  assert.deepEqual(r.tasks.filter(t => t.place === 'India').map(t => t.lang), ['en', 'hi']); assert.deepEqual(r.tasks.filter(t => t.place === 'UAE').map(t => t.lang), ['ar', 'en'])
  assert.deepEqual(r.tasks.filter(t => t.place === 'Japan').map(t => `${t.country}:${t.lang}`), ['JP:ja']); assert.equal(r.tasks.find(t => t.place === 'Atlantis')!.resolved, false)
  const many = expandMarkets(Array.from({ length: MAX_MARKETS + 3 }, (_, i) => `Place${i}`)); assert.equal(new Set(many.tasks.map(t => t.place)).size, MAX_MARKETS); assert.equal(many.skipped.length, 3)
})
