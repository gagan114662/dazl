// Fixture for test/gate-check.test.ts only. Never run by npm test or by the real gate (fixtures/ is not scanned).
import { describe, it } from 'node:test'
describe('#4203 only the suite title carries the tag', () => { it('child without tag', () => {}) })
