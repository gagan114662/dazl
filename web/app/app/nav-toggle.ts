// The phone menu is a CSS-only checkbox in the app layout (app/app/layout.tsx). The layout stays mounted while the user navigates, so a menu opened on one page
// stayed open on the next and pushed that page's content below the fold (#674, seen on a real phone). The nav closes it on every navigation and link tap.
export const NAV_TOGGLE_ID = 'navtoggle'

export function closeMobileMenu(doc: { getElementById(id: string): unknown }): void {
  const el = doc.getElementById(NAV_TOGGLE_ID) as { checked?: boolean } | null
  if (el && el.checked) el.checked = false
}
