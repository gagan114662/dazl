import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'test', 'tests', 'coverage', 'dist', 'out'])
const SOURCE_FILE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/

export function sqliteImporters(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && path !== 'web/lib/db') walk(path)
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        const source = readFileSync(join(root, path), 'utf8')
        const { importedFiles } = ts.preProcessFile(source, true, true)
        if (importedFiles.some(({ fileName }) => fileName === 'better-sqlite3' || fileName.startsWith('better-sqlite3/'))) {
          files.push(path)
        }
      }
    }
  }
  walk('')
  return files.sort()
}
