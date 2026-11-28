import assert from 'node:assert/strict'
import test from 'node:test'
import { businessPlays } from '../lib/business-brain.ts'
import { playSuggestions } from '../lib/play-suggestions.ts'

const audiences = [
  ['Design studios', true], ['Bookshops', true], ['Courier services', true],
  ['Publishers', true], ['Regional companies', true], ['Local businesses', true],
  ['Retail', false], ['Agriculture', false], ['Wellness', false],
  ['Travel', false], ['Construction', false], ['Fitness', false],
] as const

for (const [industry, plural] of audiences) {
  const buyer = { who: [], industries: [industry], where: ['Ottawa'], signals: ['hiring engineers'], sizes: [], exclude: [], summary: '' }
  test(`sells-based suggestions name ${industry} once`, () => {
    const { business } = playSuggestions({ sells: 'Scheduling software', buyer })
    assert.ok(business.length > 0, 'expected a suggestion from the saved profile')
    const audience = plural ? industry : `${industry} businesses`
    for (const query of business) assert.ok(query.startsWith(`${audience} that could use scheduling software in Ottawa - `), query)
  })

  test(`hiring suggestions name ${industry} without a second company qualifier`, () => {
    const plays = businessPlays({ buyer }, [])
    const audience = plural ? industry : `${industry} companies`
    assert.ok(plays.some(play => play.query === `${audience} in Ottawa hiring engineers`), JSON.stringify(plays))
    for (const play of plays) assert.doesNotMatch(play.query, /companies at companies/i)
  })
}
