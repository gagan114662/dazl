// The registry the runtime-worker tests run against (never the app's): synthetic modules from test/fixtures/workers,
// each pinned to the sha256 of its file as it is now, the way lib/workers/registry.ts pins reviewed modules.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { key, type Registry, type RegistryEntry, type WorkerModule } from '../../lib/workers/definition.ts'
import * as echo100 from '../fixtures/workers/echo.v1.0.0.ts'
import * as echo110 from '../fixtures/workers/echo.v1.1.0.ts'
import * as echo200 from '../fixtures/workers/echo.v2.0.0.ts'
import * as hostile from '../fixtures/workers/hostile.v1.0.0.ts'
import * as flaky from '../fixtures/workers/flaky.v1.0.0.ts'
import { reader, sender, spender } from '../fixtures/workers/unrunnable.v1.0.0.ts'

const file = (f: string) => new URL(`../fixtures/workers/${f}`, import.meta.url)
export const sha = (u: URL) => createHash('sha256').update(readFileSync(u)).digest('hex')
const entry = (m: WorkerModule, f: string): [string, RegistryEntry] => [key(m.definition.name, m.definition.version), { module: m, file: file(f), sha256: sha(file(f)) }]

export const TEST_REGISTRY: Registry = new Map([
  entry(echo100, 'echo.v1.0.0.ts'), entry(echo110, 'echo.v1.1.0.ts'), entry(echo200, 'echo.v2.0.0.ts'),
  entry(hostile, 'hostile.v1.0.0.ts'), entry(flaky, 'flaky.v1.0.0.ts'),
  entry(sender as WorkerModule, 'unrunnable.v1.0.0.ts'), entry(spender as WorkerModule, 'unrunnable.v1.0.0.ts'), entry(reader as WorkerModule, 'unrunnable.v1.0.0.ts'),
])
export const pin = (name: string, version: string) => TEST_REGISTRY.get(key(name, version))!.sha256
