// #1255: the staging banner is in the prerendered shell (cacheComponents), so it must follow the value baked in at
// build (next.config.ts inlines NEXT_PUBLIC_DAZL_STAGING from DAZL_ENV), not a runtime read: a runtime isStaging()
// read let the RSC payload and the built HTML disagree (React #418 hydration mismatch) whenever the server ran with a
// different DAZL_ENV than the build. Kept out of lib/staging.ts, which ships byte-identical in the #988 package.
export type Env = Record<string, string | undefined>
export const stagingBannerOn = (env: Env = { NEXT_PUBLIC_DAZL_STAGING: process.env.NEXT_PUBLIC_DAZL_STAGING }): boolean => env.NEXT_PUBLIC_DAZL_STAGING === '1'
