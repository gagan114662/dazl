// Use after a tenant-scoped lookup, for both missing and inaccessible resources.
export function tenantReadDenied(error = 'not_found'): Response {
  return Response.json({ error }, { status: 404 })
}
