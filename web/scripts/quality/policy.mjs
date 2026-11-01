// Local analysis only. No models, network, targets or REA runtime are invoked.
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

export const policyVersion = '1';
export const extensions = /\.(?:[cm]?[jt]sx?)$/;
export function analyzer(cwd) {
  return new ESLint({
    cwd,
    // Source comments cannot turn off the gate. Existing debt is still measured at base.
    allowInlineConfig: false,
    overrideConfig: [{
      files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
      rules: {
        'no-eval': 'error',
        'no-new-func': 'error',
        'no-implied-eval': 'error',
        'no-debugger': 'error',
        'no-unreachable': 'error',
        'no-constant-condition': ['error', { checkLoops: false }],
      },
    }, {
      files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: cwd } },
      plugins: { quality: tseslint.plugin },
      rules: {
        'quality/no-floating-promises': 'error',
        'quality/no-misused-promises': ['error', { checksVoidReturn: false }],
        'quality/await-thenable': 'error',
      },
    }],
  });
}
