import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('#1935 public pages share the deployed trial rule without a second allowance promise', () => {
  const home = source('../app/page.tsx')
  const signup = source('../app/sign-up/page.tsx')
  const form = source('../app/sign-up/sign-up-form.tsx')
  const signin = source('../app/sign-in/page.tsx')
  assert.doesNotMatch(home, /first searches run free/)
  assert.match(home, /<PublicTrialAllowance/)
  assert.match(signin, /<PublicTrialAllowance/)
  assert.match(signup, /trialRule=\{readPublicTrialAllowance\(\)\}/)
  assert.doesNotMatch(form, /signUpPlanLine\(trialFunded, emailTrial\)/)
})
