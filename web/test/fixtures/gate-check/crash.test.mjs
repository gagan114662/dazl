// Fixture for test/gate-check.test.ts only. Never run by npm test or by the real gate (fixtures/ is not scanned).
import { test } from 'node:test'
test('#4208 declared but the file crashes first', () => {})
throw new Error('import-time crash')
