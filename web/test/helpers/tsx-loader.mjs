// Compiles .tsx sources for tests with the TypeScript the repo already ships (no new dependency): automatic
// JSX runtime, ES modules. Everything else passes through to the default loader (type stripping handles .ts/.mts).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export async function load(url, context, nextLoad) {
  if (url.endsWith('.tsx')) {
    const source = await readFile(fileURLToPath(url), 'utf8')
    const out = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: url,
    })
    return { format: 'module', source: out.outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}
