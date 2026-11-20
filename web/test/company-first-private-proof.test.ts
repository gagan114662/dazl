import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluatePrivateCandidateProof, proofBinding, STRICT_GATE_STAGE, type ProofSnapshot, type StageAttestation } from '../lib/company-first/company-first-private-proof.ts'

const now = 1_000_000
const claim = { tenant: 'example-tenant', job: 'example-job', attempt: 2, actor: 'example-worker' }
const key = { id: 'candidate-1', revision: 'revision-4' }
const evidence = {
  companyKey: 'example-co', website: 'https://company.example', identitySource: 'https://company.example/about',
  event: 'hiring_posting', eventSource: 'https://company.example/posting', eventDate: '2026-11-10',
  literalQuote: 'This posting describes the role.', buyer: 'Ana Exemple', title: 'Director',
  buyerBio: 'https://company.example/bio', linkedin: 'https://www.linkedin.com/in/example',
  email: 'ana.exemple@company.example', emailSource: 'https://company.example/bio',
}
const policy = 'reviewed-policy-1'
const binding = proofBinding(claim, key, policy, evidence)
const gates = Object.keys(STRICT_GATE_STAGE) as (keyof typeof STRICT_GATE_STAGE)[]
const attestations = gates.map(gate => ({
  gate, stage: STRICT_GATE_STAGE[gate], binding, inputRevision: `${gate}:r1`,
  checkedAt: now - 1, expiresAt: now + 1, decision: 'passed',
})) as StageAttestation[]
const currentInputs = Object.fromEntries(gates.map(g => [g, `${g}:r1`])) as ProofSnapshot['currentInputs']
function actual(patch: Partial<ProofSnapshot> = {}): ProofSnapshot {
  return { claim, authorization: 'current', phase: 'finalized',
    settlement: { attempt: claim.attempt, state: 'all_charges_resolved', revision: 'settled-6' }, policyRevision: policy,
    candidate: { key, evidence }, currentInputs, attestations, ...patch }
}
const run = (row: ProofSnapshot | null, clock = () => now) =>
  evaluatePrivateCandidateProof({ async readCurrentSnapshot(c, id) { assert.deepEqual(c, claim); assert.equal(id, key.id); return row } }, claim, key, evidence, clock)

test('complete private fixture accepts bound identity and emits no contact or public verdict', async () => {
  assert.deepEqual(await run(actual()), { candidateId: key.id, candidateRevision: key.revision, binding, settlementRevision: 'settled-6', checkedAt: now })
})
test('each missing or held canonical stage, duplicate, or wrong stage source refuses', async () => {
  for (const a of attestations) {
    assert.equal(await run(actual({ attestations: attestations.filter(x => x !== a) })), null, a.gate)
    const refused = attestations.map(x => x === a ? { ...x, decision: 'held' as const } : x)
    assert.equal(await run(actual({ attestations: refused })), null, a.gate)
  }
  assert.equal(await run(actual({ attestations: [...attestations.slice(1), attestations[1]] })), null)
  assert.equal(await run(actual({ attestations: [{ ...attestations[0], stage: attestations[1].stage } as StageAttestation, ...attestations.slice(1)] })), null)
})
test('wrong actor, foreign tenant, stale attempt and interrupted state refuse', async () => {
  for (const candidate of [{ ...claim, actor: 'other-worker' }, { ...claim, tenant: 'foreign' }, { ...claim, attempt: 1 }, { ...claim, job: 'other-job' }]) {
    assert.equal(await run(actual({ claim: candidate })), null)
  }
  assert.equal(await run(actual({ authorization: 'not_current' })), null)
  assert.equal(await run(actual({ phase: 'interrupted' })), null)
})
test('stored quote, date, source and named identity/contact cannot be transplanted', async () => {
  for (const k of ['literalQuote', 'eventDate', 'eventSource', 'identitySource', 'buyer', 'title', 'buyerBio', 'linkedin', 'email', 'emailSource'] as const)
    assert.equal(await run(actual({ candidate: { key, evidence: { ...evidence, [k]: 'different' } } })), null, k)
  assert.equal(await run(actual({ candidate: { key: { ...key, revision: 'old-copy' }, evidence } })), null)
  assert.equal(await run(actual({ policyRevision: 'changed-policy' })), null)
})
test('changed current rule inputs, expiry and mismatched accounting refuse', async () => {
  for (const g of gates) assert.equal(await run(actual({ currentInputs: { ...currentInputs, [g]: 'newer-input' } })), null, g)
  assert.equal(await run(actual(), () => now + 1), null)
  assert.equal(await run(actual(), () => now - 2), null)
  assert.equal(await run(actual({ settlement: { attempt: 1, revision: 's1', state: 'all_charges_resolved' } })), null)
  assert.equal(await run(actual({ settlement: { attempt: 2, revision: 's2', state: 'unresolved' } })), null)
  assert.equal(await run(null), null)
  assert.equal(await evaluatePrivateCandidateProof({ async readCurrentSnapshot() { throw new Error('offline') } }, claim, key, evidence, () => now), null)
})
