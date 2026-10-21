import test from 'node:test'
import assert from 'node:assert/strict'
import { toCsv } from '../lib/scan/csv.ts'

const COLS = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B, with comma' }]

test('toCsv escapes commas, quotes, newlines and nulls', () => {
  const csv = toCsv([
    { a: 'plain', b: null },
    { a: 'has, comma', b: 'has "quote"' },
    { a: 'multi\nline', b: 42 },
  ], COLS)
  const noBom = csv.replace(/^﻿/, '')
  const lines = noBom.split('\r\n')
  assert.equal(lines[0], 'A,"B, with comma"')
  assert.equal(lines[1], 'plain,')
  assert.equal(lines[2], '"has, comma","has ""quote"""')
  assert.equal(lines[3], '"multi\nline",42') // embedded newline stays inside the quoted cell
  assert.ok(csv.startsWith('﻿'))
  assert.ok(csv.endsWith('\r\n'))
})

test('toCsv headers-only on empty rows; dates render ISO', () => {
  assert.equal(toCsv([], COLS).replace(/^﻿/, ''), 'A,"B, with comma"\r\n')
  const csv = toCsv([{ a: new Date('2026-10-21T12:00:00Z'), b: 'x' }], COLS)
  assert.ok(csv.includes('2026-10-21T12:00:00.000Z'))
})
