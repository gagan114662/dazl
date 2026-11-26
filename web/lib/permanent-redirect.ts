// #1699: the legacy auth paths (/signup, /signin, /login, /register) 404'd; they permanently redirect to the real
// sign-up and sign-in pages. 308 is the permanent, method-preserving status, so old links and bookmarks land once
// and are then remembered at the right address. A plain Response keeps the handler framework-free.
export function permanentRedirect(req: Request, to: string): Response {
  return new Response(null, { status: 308, headers: { location: new URL(to, req.url).toString() } })
}
