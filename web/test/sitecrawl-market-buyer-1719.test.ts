import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buyerTitle, chooseSiteBuyer, extractPeople, seniority } from '../lib/connectors/sitecrawl.ts'
import { titleMatches } from '../lib/people/rank.ts'

// Name/title snippets recorded from the linked first-party team pages. Tokyo is outside the benchmark cities.
const recordedTeamTitles = [
  { language: 'French', url: 'https://corporate.ovhcloud.com/fr/company/leadership-team/octave-klaba/', name: 'Octave Klaba', title: 'Président et Directeur Général' },
  { language: 'Russian', url: 'https://www.kaspersky.ru/about/team/eugene-kaspersky', name: 'Евгений Касперский', title: 'Генеральный директор' },
  { language: 'Japanese', url: 'https://www.softbank.jp/corp/aboutus/profile/officer/', name: '孫 正義', title: '創業者 取締役' },
  { language: 'Arabic', url: 'https://www.aramco.com/ar/about-us/our-leadership', name: 'أمين حسن الناصر', title: 'الرئيس وكبير الإداريين التنفيذيين' },
]

for (const { language, url, name, title } of recordedTeamTitles) {
  test(`#1719: a recorded ${language} leadership title can qualify and rank without configured roles`, () => {
    assert.ok(buyerTitle(title, ''))
    assert.equal(seniority(title), 4)
    const person = { kind: 'person' as const, value: `${name}, ${title}`, url, label: 'listed on team page' }
    assert.deepEqual(chooseSiteBuyer([person], ''), person)
  })
}

test('#1719: role overlap handles Cyrillic and accent differences without admitting contradictions', () => {
  assert.deepEqual(titleMatches('Директор по маркетингу', 'маркетингу директор'), ['директор', 'маркетингу'])
  assert.deepEqual(titleMatches('Directrice générale', 'Generale directrice'), ['directrice', 'generale'])
  assert.deepEqual(titleMatches('Former HR Manager', 'HR Manager'), [])
})

const listed = (value: string) => ({ kind: 'person' as const, label: 'listed on team page', value, url: 'https://fixture.example/team' })
test('#1719: an empty role list admits a single senior buyer and rejects a junior, a past role, and another employer', () => {
  assert.ok(buyerTitle('Managing Director', '  '))
  const buyer = listed('Ada Mercer, Managing Director')
  const controls = ['Lena Mercer, Sales Assistant', 'Lena Mercer, Former Managing Director', 'Lena Mercer, Director at Another Company'].map(listed)
  for (const candidate of controls) assert.equal(chooseSiteBuyer([candidate], ''), null)
  assert.deepEqual(chooseSiteBuyer([...controls, buyer], ''), buyer)
  assert.equal(chooseSiteBuyer([buyer], 'Head of Sales'), null)
})

test('#1719: an empty role list still refuses to resolve a seniority tie between different people', () => {
  const people = [listed('Ada Mercer, Managing Director'), listed('Lena Crane, Managing Director')]
  assert.ok(people.every(person => chooseSiteBuyer([person], '') === person))
  assert.equal(chooseSiteBuyer(people, ''), null)
})

test('#1719: a team card can extract a senior multilingual title without a role list', () => {
  const html = '<p>this independent business makes reliable equipment for commercial workshops and supplies customers with practical advice on installation maintenance and repairs</p>'
    + '<div><h2>Diana Mercer</h2><p>Diretora Geral</p></div>'
  const people = extractPeople(html, 'https://fixture.example/team')
  assert.equal(people.length, 1)
  assert.equal(chooseSiteBuyer(people, '')?.value, 'Diana Mercer, Diretora Geral')
})

const russianTeamProse = '<p>наша команда создаёт надёжные инструменты для небольших предприятий помогает клиентам выбирать оборудование проводить установку обслуживание ремонт обучение поддержку и регулярно обновляет техническую документацию</p>'

test('#1719: substantive native-script prose supports a team-page buyer', () => {
  const card = '<section><h2>Jane Smith</h2><p>Генеральный директор</p></section>'
  const url = 'https://fixture.example/team'
  assert.deepEqual(extractPeople(card, url), [])
  assert.deepEqual(extractPeople(russianTeamProse + card, url).map(person => person.value), ['Jane Smith, Генеральный директор'])
})

test('#1719: native-script names survive team-page extraction', () => {
  const prose = '<p>this independent business makes reliable equipment for commercial workshops and supplies customers with practical advice on installation maintenance and repairs</p>'
  for (const { name, title, language } of recordedTeamTitles.slice(1)) {
    assert.deepEqual(extractPeople(prose + `<section><h2>${name}</h2><p>${title}</p></section>`, 'https://fixture.example/team')
      .map(person => person.value), [`${name}, ${title}`], language)
  }
})
