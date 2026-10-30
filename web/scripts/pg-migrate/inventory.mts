// Writes docs/PG_INVENTORY.md: what still assumes SQLite (lib/db/pg-inventory.ts). Static, needs no database.
//   node --experimental-strip-types scripts/pg-migrate/inventory.mts [--write]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildInventory, renderInventory } from '../../lib/db/pg-inventory.ts'

const root = join(import.meta.dirname, '..', '..')
const md = renderInventory(buildInventory(root))
if (process.argv.includes('--write')) { writeFileSync(join(root, '..', 'docs', 'PG_INVENTORY.md'), md); console.log('wrote docs/PG_INVENTORY.md') }
else process.stdout.write(md)
