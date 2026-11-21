import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTextCandidates } from '../lib/llm/claude-web-search.ts'

test('cf_runner extract_json: the <json> list becomes candidates; posting URLs must be plain https', () => {
  const c = parseTextCandidates('Found these.\n<json>[{"company":"Acme Robotics","website":"acmerobotics.io","job_url":"https://jobs.lever.co/acme/123","date_posted":"2026-11-10"},{"company":"Beta","website":null,"job_url":"http://x.example/1"},{"website":"no-name.io"}]</json>')
  assert.deepEqual(c, [{ company: 'Acme Robotics', website: 'acmerobotics.io', jobUrl: 'https://jobs.lever.co/acme/123' }, { company: 'Beta', website: null, jobUrl: null }])
})
test('a truncated answer still yields its complete objects', () => {
  const c = parseTextCandidates('<json>[{"company":"Acme","website":"acme.io","job_url":null},{"company":"Cut')
  assert.deepEqual(c, [{ company: 'Acme', website: 'acme.io', jobUrl: null }])
})
