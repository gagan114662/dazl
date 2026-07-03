// Shared environment bindings for the dazl runtime spine.
// The real Env interface now lives in ./src/runtime/env.ts so it can be
// imported by runtime code (Durable Objects, workflows, etc). This file
// re-exports it for ambient/global usage and to type `cloudflare:test`.
export type { Env } from "./src/runtime/env";

// Make `env` from "cloudflare:test" carry our Env type in tests.
import type { Env } from "./src/runtime/env";
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
