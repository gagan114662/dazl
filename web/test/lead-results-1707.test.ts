import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const leads = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
const checked = readFileSync(new URL('../app/app/leads/checked/checked-client.tsx', import.meta.url), 'utf8')

test('the result approval hold includes the reason in visible text', () => {
  assert.match(leads, /data-testid="approve-hold"[^>]*>[\s\S]*?<span[^>]*>\{c\.approve\.reason\}<\/span>/)
  assert.match(leads, /data-testid="linkedin-ready"[^>]*>[\s\S]*?<span[^>]*>\{c\.approve\.reason\}<\/span>/)
})

test('an active scan with no results hides its campaign and CSV links', () => {
  assert.match(leads, /\{\(!scanActive \|\| leads\.length > 0\) && <div[^>]*>[\s\S]*?Campaign page[\s\S]*?Download CSV[\s\S]*?<\/div>\}/)
})

test('ready rows can reveal details for their exact lead', () => {
  assert.match(checked, /\{c\.ready && <ReadyLeadDetails jobId=\{c\.job_id\} leadId=\{c\.lead_id\} \/>\}/)
  assert.match(checked, /\.find\(lead => lead\.id === leadId\)/)
  assert.match(checked, /<dt[^>]*>Signal<\/dt>[\s\S]*?<dt[^>]*>Date<\/dt>[\s\S]*?<dt[^>]*>Contact<\/dt>[\s\S]*?<dt[^>]*>Email<\/dt>/)
})
