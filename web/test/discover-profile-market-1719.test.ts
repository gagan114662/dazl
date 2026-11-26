import assert from 'node:assert/strict'
import { test } from 'node:test'
import { profileMarketLines } from '../lib/discover/profile-market.ts'

for (const [country, language] of [['DE', 'de'], ['BR', 'pt'], ['JP', 'ja'], ['CA', 'fr']]) {
  test(`#1719: country ${country} and language ${language} carry when no place is saved`, () => {
    const [market, sourceLanguage] = profileMarketLines({ where: [], country, language })
    assert.match(market, new RegExp(`\\b${country}\\b`))
    assert.match(market, /only if the request names no place/)
    assert.match(sourceLanguage, new RegExp(`\\b${language}\\b`))
    assert.match(sourceLanguage, /only if the request leaves the language open/)
  })
}

test('#1719: a populated place keeps the existing location path', () => {
  assert.deepEqual(profileMarketLines({ where: ['Oslo'], country: 'NO', language: 'no' }), [])
})

test('#1719: market fields are independent and no defaults are invented', () => {
  assert.deepEqual(profileMarketLines(), [])
  assert.deepEqual(profileMarketLines({ country: 'MX' }), ['Saved country (only if the request names no place): MX'])
  assert.deepEqual(profileMarketLines({ language: 'ar' }), ['Saved source language (only if the request leaves the language open): ar'])
  assert.deepEqual(profileMarketLines({ country: 'not a country', language: 'unknown' }), [])
})
