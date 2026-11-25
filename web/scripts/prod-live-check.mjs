import { parseArgs } from 'node:util'

const pages = ['/', '/pricing', '/privacy', '/terms', '/sign-in', '/sign-up']
const redirects = [
  ['/signup', '/sign-up'],
  ['/register', '/sign-up'],
  ['/signin', '/sign-in'],
  ['/login', '/sign-in'],
  ['/app', '/sign-in'],
]
const redirectStatuses = new Set([301, 302, 303, 307, 308])

function argumentsForCheck() {
  const { positionals } = parseArgs({ allowPositionals: true })
  const [url, expected] = positionals
  if (positionals.length !== 2 || !/^[a-f0-9]{8,40}$/i.test(expected)) {
    throw new Error('usage: node web/scripts/prod-live-check.mjs BASE_URL EXPECTED_SHA (8–40 hex characters)')
  }
  const base = new URL(url)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash) {
    throw new Error('BASE_URL must be an HTTP(S) origin without credentials')
  }
  return { base, expected: expected.toLowerCase() }
}

async function request(base, path) {
  return fetch(new URL(path, base), {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
}

function check(condition, label, detail) {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    console.log(`FAIL ${label} — ${detail}`)
    process.exitCode = 1
  }
}

async function run(label, action) {
  try {
    await action()
  } catch (error) {
    check(false, label, error.name === 'TimeoutError' ? 'request timed out' : 'request or response parsing failed')
  }
}

async function main() {
  let config
  try {
    config = argumentsForCheck()
  } catch {
    check(false, 'arguments', 'usage: node web/scripts/prod-live-check.mjs BASE_URL EXPECTED_SHA (8–40 hex characters)')
    return
  }
  const { base, expected } = config
  await run('/api/health', async () => {
    const response = await request(base, '/api/health')
    if (response.status !== 200) {
      check(false, '/api/health', `expected HTTP 200, received ${response.status}`)
      return
    }
    const health = await response.json()
    const commit = health?.commit
    check(typeof commit === 'string' && /^[a-f0-9]{8,40}$/i.test(commit) && commit.toLowerCase().startsWith(expected),
      '/api/health commit', `expected commit ${expected}`)
  })

  for (const path of pages) {
    await run(path, async () => {
      const response = await request(base, path)
      check(response.status === 200, `${path} HTTP 200`, `received ${response.status}`)
      const html = await response.text()
      check(!html.includes('DRAFT'), `${path} HTML`, 'contains DRAFT')
      if (path === '/') {
        const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1]
        check(heading?.replace(/<!--.*?-->|<[^>]+>/gs, '').trim() === 'Say who you want to reach.',
          '/ h1', 'expected “Say who you want to reach.”')
      }
    })
  }

  for (const [path, destination] of redirects) {
    await run(path, async () => {
      const response = await request(base, path)
      const location = response.headers.get('location')
      const target = location && URL.canParse(location, base) ? new URL(location, base) : null
      check(redirectStatuses.has(response.status) && target?.origin === base.origin && target.pathname === destination,
        `${path} redirects to ${destination}`, `received HTTP ${response.status} or an incorrect Location`)
      const html = await response.text()
      check(!html.includes('DRAFT'), `${path} HTML`, 'contains DRAFT')
    })
  }
}

await main()
