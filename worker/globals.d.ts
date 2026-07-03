// Pure ambient/global declarations file (deliberately has no top-level
// import/export statements). A `declare module "*.pattern"` wildcard
// declaration only behaves as a global ambient declaration when the
// containing file is NOT itself a module — as soon as a file has its own
// top-level import/export (as env.d.ts does, to re-export `Env`), TypeScript
// treats `declare module` blocks inside it as "module augmentation", which
// requires the named module to already exist and rejects wildcard patterns.
// That is why this lives in its own file instead of inside env.d.ts.

// Vite's `?raw` import suffix (used by test/helpers/apply-migrations.ts to
// inline migration SQL as a string) has no bundled type declaration; declare
// it ambiently so `tsc --noEmit` can type-check the import.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
