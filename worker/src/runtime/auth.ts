import type { Env } from "./env";
import { findActiveTenantIdByApiKey } from "./tenants";

// Request authentication for the /v1 API.
//
// Two credential kinds, both delivered as `Authorization: Bearer <token>`:
//
//   1. The operator secret (env.DAZL_API_SECRET) — admin. Can provision
//      tenants and keys, and reach the legacy default-tenant routes. It is
//      NOT a tenant credential and never grants a tenant scope.
//   2. A per-tenant API key — scoped to exactly one tenant, derived from the
//      api_keys table lookup, never from a tenantId the request supplies
//      itself (a forged body/header tenantId is therefore inert).
export interface RequestAuth {
  isAdmin: boolean;
  // The tenant this request acts on. Null for admin credentials that have
  // not been bound to a tenant by the route (tenant-scoped routes reject
  // admin-null rather than guessing a default).
  tenantId: string | null;
}

function parseBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.get("Authorization");
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

// Returns null when the request carries no usable credential. Unknown and
// revoked API keys are indistinguishable here (both null) so the 401 leaks
// nothing about which keys exist.
export async function authenticateRequest(request: Request, env: Env): Promise<RequestAuth | null> {
  const bearerToken = parseBearerToken(request);
  if (!bearerToken) return null;

  // Admin secret first. If DAZL_API_SECRET is unset, comparison below is
  // skipped entirely — never compare against an empty/undefined secret (see
  // isAuthorized in routes.ts for the original bypass note this mirrors).
  if (env.DAZL_API_SECRET && bearerToken === env.DAZL_API_SECRET) {
    return { isAdmin: true, tenantId: null };
  }

  const tenantId = await findActiveTenantIdByApiKey(env.DB, bearerToken);
  if (tenantId === null) return null;

  return { isAdmin: false, tenantId };
}
