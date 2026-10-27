import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

// Version-skew protection: tag each build with its commit (written by `prebuild` into .build-commit) so a tab from
// an older deploy hard-reloads instead of requesting chunks the new build no longer has.
function buildCommit(): string | undefined {
  try { return readFileSync(path.join(process.cwd(), ".build-commit"), "utf8").trim().slice(0, 40) || undefined } catch { return undefined }
}

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    // Next.js needs inline scripts/styles for hydration; tighten with nonces later.
    value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  },
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || buildCommit(),
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
