import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLeads } from '../lib/discover/agent.ts'
import { checkLead, isShown } from '../lib/discover/check.ts'

const company = 'Orchard Workshop'
const evidence_url = 'https://fixture.example/post'

for (const { signal, quote, deferred, shown } of [
  { signal: 'Evaluating scheduling tools', quote: 'stopped evaluating scheduling tools.', deferred: true, shown: false },
  { signal: 'Evaluating scheduling tools', quote: 'is evaluating scheduling tools.', deferred: false, shown: true },
  { signal: 'Evaluating scheduling tools', quote: 'discusses scheduling tools.', deferred: true, shown: false },
  { signal: 'Evalúa herramientas de planificación', quote: 'no evalúa herramientas de planificación.', deferred: true, shown: false },
  { signal: 'Évalue des outils de planification', quote: 'n’évalue pas des outils de planification.', deferred: true, shown: false },
]) {
  test(`#1726 proof decision for “${quote}”`, async () => {
    const statement = `${company} ${quote}`
    const [lead] = parseLeads(JSON.stringify({ leads: [{ company, signal, evidence_url, evidence_quote: statement }] }), 1).leads
    assert.ok(lead)
    let judged = 0
    const fetchPage = async () => new Response(`<p>${statement}</p>`)
    const checked = await checkLead(lead, [], fetchPage, undefined, new Date(), async (_signal, _company, statements) => {
      judged++
      assert.deepEqual(statements, [statement])
      return false
    })
    assert.equal(judged, deferred ? 1 : 0)
    assert.equal(isShown(checked), shown)
  })
}
