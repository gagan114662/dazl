// #1643: the Sign out button in the app is a plain form (app/app/layout.tsx), so the browser itself goes to
// /api/auth/signout and shows whatever comes back. It used to be {"ok":true} on a blank page. A browser form post is
// now answered with a redirect to the home page; a script that calls the route (fetch with a JSON body, as Settings
// does when an account is deleted) still gets {"ok":true}.
export const SIGNED_OUT_PATH = '/'
const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data']
export function signoutRedirects(headers: Headers | null | undefined): boolean {
  if (!headers) return false
  const type = (headers.get('content-type') ?? '').toLowerCase()
  if (FORM_TYPES.some(t => type.startsWith(t))) return true
  // a navigation with no body type at all: the browser says it wants a page
  return !type && (headers.get('accept') ?? '').toLowerCase().includes('text/html')
}
