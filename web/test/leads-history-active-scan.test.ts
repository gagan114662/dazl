import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const OLDER = 'a'.repeat(24)
const ACTIVE = 'b'.repeat(24)
const source = ts.createSourceFile(
  'leads-client.tsx',
  readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)
const component = source.statements.find((statement): statement is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'LeadsClient',
)
assert.ok(component?.body)
const effects = component.body.statements.filter(statement =>
  ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
  && statement.expression.expression.getText(source) === 'useEffect',
).map(statement => statement.getText(source))

function clientEffect(fragment: string) {
  const effect = effects.find(text => text.includes(fragment))
  assert.ok(effect, `LeadsClient effect containing ${fragment}`)
  return new vm.Script(ts.transpileModule(effect, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText)
}

function renderBanner(otherActiveJobId: string | null): string {
  const find = (node: ts.Node): ts.Expression | undefined => {
    if (ts.isJsxExpression(node) && node.expression?.getText(source).includes('A search is running.')) return node.expression
    return node.forEachChild(find)
  }
  const banner = find(component!)
  assert.ok(banner, 'the component has a running-search banner')
  const output = ts.transpileModule(`export default (${banner.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = { default: null }
  vm.runInNewContext(output, { exports, require: createRequire(import.meta.url), otherActiveJobId })
  return renderToStaticMarkup(exports.default)
}

async function openLeads(query: string) {
  const passiveJob = { current: false }
  const viewedJob = { current: '' }
  const url = new URL(`https://dazl.test/app/leads${query}`)
  let status: string | null = null
  let listedActive: string | null = null
  let respond!: (response: Response) => void
  const jobs = new Promise<Response>(resolve => { respond = resolve })
  const context = vm.createContext({
    URL, URLSearchParams, AbortSignal,
    window: {
      location: url,
      history: { replaceState: (_state: unknown, _title: string, href: string) => { url.href = new URL(href, url).href } },
    },
    fetch: (href: string) => href === '/api/scan/jobs' ? jobs : Promise.resolve(Response.json({ campaigns: [] })),
    useEffect: (effect: () => void) => effect(),
    queueMicrotask,
    passiveJob, viewedJob, jobId: null,
    setJobId: (id: string) => { context.jobId = id; viewedJob.current = id },
    setStatus: (value: string) => { status = value },
    setCurrentRuns: () => {},
    setPastJobs: () => {},
    setOtherActiveJobId: (value: string | null) => { listedActive = value },
  })

  clientEffect("setStatus('loading')").runInContext(context)
  clientEffect("fetch('/api/scan/jobs')").runInContext(context)
  // React's effect has opened the requested job before the jobs request returns.
  await new Promise(resolve => setImmediate(resolve))
  respond(Response.json({ jobs: [
    { id: ACTIVE, csv_domain: null, status: 'running' },
    { id: OLDER, csv_domain: null, status: 'done' },
  ] }))
  await new Promise(resolve => setImmediate(resolve))
  clientEffect('window.history.replaceState').runInContext(context)
  return { jobId: context.jobId, urlJob: url.searchParams.get('job_id'), status, listedActive }
}

test('a delayed running search response leaves the older search selected and its URL intact', async () => {
  const view = await openLeads(`?job_id=${OLDER}`)
  assert.equal(view.jobId, OLDER)
  assert.equal(view.urlJob, OLDER)
  assert.equal(view.status, 'loading')
  assert.equal(view.listedActive, ACTIVE)
  assert.match(renderBanner(view.listedActive), new RegExp(`href="/app/leads\\?job_id=${ACTIVE}">View progress`))
  assert.equal(renderBanner(null), '')
})

for (const query of ['', '?job_id=malformed']) {
  test(`the running search still opens without a valid explicit job (${query || 'bare URL'})`, async () => {
    const view = await openLeads(query)
    assert.equal(view.jobId, ACTIVE)
    assert.equal(view.urlJob, ACTIVE)
    assert.equal(view.status, 'running')
  })
}
