// #1699: /signup, /signin, /login and /register returned 404. Each now permanently redirects (308) to the real
// sign-up or sign-in page. The handlers are called directly: status and Location are the whole behaviour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GET as signup } from '../app/signup/route.ts'
import { GET as register } from '../app/register/route.ts'
import { GET as signin } from '../app/signin/route.ts'
import { GET as login } from '../app/login/route.ts'

const cases: [string, (req: Request) => Response, string][] = [
  ['/signup', signup, '/sign-up'],
  ['/register', register, '/sign-up'],
  ['/signin', signin, '/sign-in'],
  ['/login', login, '/sign-in'],
]

for (const [from, get, to] of cases) {
  test(`#1699 ${from} permanently redirects to ${to}`, () => {
    const res = get(new Request(`https://dazl.ai${from}`))
    assert.equal(res.status, 308, 'a permanent redirect, so the old address is not re-asked')
    assert.equal(new URL(res.headers.get('location') ?? '').pathname, to)
  })
}

test('#1699 the redirect keeps the host of the request', () => {
  const res = login(new Request('https://staging.dazl.ai/login'))
  assert.equal(new URL(res.headers.get('location') ?? '').host, 'staging.dazl.ai')
})
