import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countryPlace } from '../lib/sources/jobboards.ts'

// Qodo #1556: recorded board locations (Greenhouse "Remote, United States or Austin, Texas HQ", Ashby "Virtual - California (Bay Area)",
// Lever "Sydney, NSW 2000" / "Melbourne, VIC 3000") are in their country; a non-string location never throws.
test('Qodo #1556: US work-mode and HQ suffixes are read as US', () => {
  const us = countryPlace('US')!
  for (const l of ['Remote, United States or Austin, Texas HQ', 'Virtual - California (Bay Area)', 'Austin, Texas HQ', 'Remote - US'])
    assert.ok(us.ok(l), l)
  assert.ok(!us.ok('Toronto, ON, Canada'))
  assert.ok(!us.ok('Remote'))
})
test('Qodo #1556: Australian states with postcodes are AU', () => {
  const au = countryPlace('AU')!
  for (const l of ['Sydney, NSW 2000', 'Melbourne, VIC 3000']) assert.ok(au.ok(l), l)
  assert.ok(!au.ok('Austin, TX'))
})
test('Qodo #1556: a non-string location is not in the country and never throws', () => {
  const us = countryPlace('US')!
  assert.equal(us.ok({ name: 'US' } as unknown as string), false)
  assert.equal(us.ok(42 as unknown as string), false)
})
