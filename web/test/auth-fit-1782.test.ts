import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { signUpPlanLine, trialRuleLine } from '../lib/trial-copy.ts'

// #1782: /sign-up scrolled at 1440x900 and the auth pages were taller than a 390x844 phone screen. Both pages render
// <main class="min-h-screen ... py-10">, so the card carried a 100vh floor (taller than a phone's visible area) plus
// 40px of padding top and bottom. The layouts own the fix: they give that <main> the visible height (dvh) with no
// vertical padding or margin of their own, so the page's own items-center centres the card inside the viewport.
const layouts = ['sign-in', 'sign-up'].map((name) => ({
  name,
  src: readFileSync(new URL(`../app/${name}/layout.tsx`, import.meta.url), 'utf8'),
}))

// The element each layout renders around {children}. Later work may put siblings beside the page inside this element
// (the site footer, #1781), so only the opening tag and {children} are matched.
function wrapperTokens(src: string): string[] {
  const m = /<div className="([^"]*)">\s*\{children\}/.exec(src)
  assert.ok(m, 'the layout wraps {children} in a single <div>')
  return m![1].split(/\s+/).filter(Boolean)
}

const VERTICAL_SPACING = /^(?:-)?(?:m[xy]?|p[xy]?|m[tb]|p[tb]|space-y)-/

for (const { name, src } of layouts) {
  test(`#1782 /${name} fits the viewport: visible height, no vertical padding or margin around the card`, () => {
    const tokens = wrapperTokens(src)
    assert.ok(tokens.includes('min-h-[100dvh]'), 'the wrapper is the visible height (dvh, not 100vh which is taller than a phone\'s visible area)')
    assert.ok(!tokens.includes('min-h-screen') && !tokens.includes('h-screen'), 'no 100vh floor on the wrapper')
    assert.ok(!tokens.includes('overflow-hidden'), 'the card is fitted, not clipped')
    const spacing = tokens.filter((t) => VERTICAL_SPACING.test(t) && !t.startsWith('[&>main]'))
    assert.deepEqual(spacing, [], 'no vertical padding or margin of its own: the card is the only height')
  })

  test(`#1782 /${name} hands that height to the page's <main> and keeps the card centred`, () => {
    const tokens = wrapperTokens(src)
    assert.ok(tokens.includes('flex') && tokens.includes('flex-col'), 'a column wrapper so the <main> can take its height')
    assert.ok(tokens.includes('[&>main]:flex-1'), '<main> fills the visible height')
    assert.ok(tokens.includes('[&>main]:min-h-0'), 'the page\'s min-h-screen floor is dropped')
    assert.ok(tokens.includes('[&>main]:py-0'), 'the page\'s 40px top/bottom padding is dropped')
  })
}

test('#1782 the pages keep their own centring and the fix stays in the layouts', () => {
  // sign-in/page.tsx renders SignInForm from sign-up-form.tsx (#1736), so the <main> lives in the form for both pages,
  // and the form renders one per state. Check every <main> those files render rather than one exact class string.
  const sources = ['../app/sign-in/page.tsx', '../app/sign-up/sign-up-form.tsx'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
  const mains = sources.flatMap((src) => [...src.matchAll(/<main\b[^>]*>/g)].map((m) => m[0]))
  assert.ok(mains.length > 0, 'the auth pages render a <main>')
  for (const tag of mains) {
    for (const cls of ['min-h-screen', 'flex', 'items-center', 'justify-center']) {
      assert.match(tag, new RegExp(`\\b${cls}\\b`), `the <main> keeps ${cls}: the layout removes its floor and padding, and it centres the card`)
    }
  }
})


// Reopened (live check, prod e559522c): the layouts fit, but the sign-up CARD itself is 892px tall, so with the
// footer the page is 937px in an 800px desktop window (+137) and 1025px in an 843px phone window (+182):
// 'Already have an account', the Terms line and the footer sit below the fold. /sign-in's shorter card fits.
// The budget below is computed FROM the card's own classes: Tailwind spacing (n = 4n px) and line heights
// (text-xl 28, text-2xl 32, text-sm 20, text-xs 16), .field's 44px min-height (globals.css, #534), the real
// plan and trial-rule strings wrapped at the card's content width, plus the compact footer (45px on desktop;
// on a phone its row wraps, 97px). Characters-per-line is an average-width estimate, so a pass needs room to
// spare; the live check on prod is the final arbiter.
const formSrc = readFileSync(new URL('../app/sign-up/sign-up-form.tsx', import.meta.url), 'utf8')
// the file renders three <main> elements (check-email state, sign-up, sign-in): take the one whose card holds
// the 'Create your account' heading
const headingAt = formSrc.indexOf('>Create your account<')
const mainStart = formSrc.lastIndexOf('<main', headingAt)
const card = formSrc.slice(mainStart, formSrc.indexOf('</main>', headingAt))
const spacing = (cls: string, kind: 'mb' | 'mt' | 'gap' | 'p' | 'py'): number => {
  const m = new RegExp(`(?:^|\\s)${kind}-(\\d+(?:\\.\\d+)?)`).exec(cls)
  return m ? Number(m[1]) * 4 : 0
}
// responsive: on a wide viewport the sm: value wins when the class carries one
const spacingR = (cls: string, kind: 'mb' | 'mt' | 'gap' | 'py', wide: boolean): number => {
  if (wide) { const m = new RegExp(`sm:${kind}-(\\d+(?:\\.\\d+)?)`).exec(cls); if (m) return Number(m[1]) * 4 }
  return spacing(cls, kind)
}
const classOf = (re: RegExp, what: string): string => {
  const m = re.exec(card)
  assert.ok(m, `the sign-up card markup has ${what}`)
  return m![1]
}
const cardCls = classOf(/"card ([^"]*)"/, 'the card')
const lines = (chars: number, width: number, perChar: number) => Math.max(1, Math.ceil(chars / Math.floor(width / perChar)))

function cardHeight(viewportWidth: number): number {
  const wide = viewportWidth >= 640
  const pad = wide ? Number(/sm:p-(\d+(?:\.\d+)?)/.exec(cardCls)?.[1] ?? 0) * 4 : spacing(cardCls, 'p')
  const maxW = cardCls.includes('max-w-md') ? 448 : 384
  const content = Math.min(maxW, viewportWidth - 32) - pad * 2
  const plan = signUpPlanLine(true, true)
  const rule = trialRuleLine({ funded: true, emailPath: true, cap: 3, emailCap: 1 })
  const terms = 'By creating an account you agree to the Terms and Privacy Policy.'
  const rules = 'Use at least 10 characters, including a letter and a number.'
  // the field rows pair up only on wider screens (sm:grid-cols-2); on a phone they stack (grid-cols-1)
  const paired = wide && (card.match(/sm:grid-cols-2/g) ?? []).length >= 2
  const rowCls = classOf(/<div className="(grid [^"]*)">\s*<label/, 'a field row')
  const gridGap = spacingR(rowCls, 'gap', wide)
  const formCls = classOf(/<form[^>]*className="([^"]*)"/, 'the form')
  const submitCls = classOf(/<button type="submit"[\s\S]{0,120}?className="([^"]*)"/, 'the submit button')
  // one field is 68px (label 20 + gap 4 + the 44px input); the password block adds its gap and the rules line,
  // wrapped at the width the field actually gets (a paired column, or the full content width when stacked)
  const pwBlock = (w: number) => 68 + 4 + lines(rules.length, w, 5.6) * 16
  const fields = paired ? 68 + pwBlock((content - gridGap) / 2) : 68 * 3 + pwBlock(content) + 2 * gridGap
  // the submit button's height is its padded height or its min-height, whichever is taller: min-h-11 keeps it
  // a 44px touch target on a phone, where py-2.5 alone makes it 42px (the browser check at 390px)
  const submitH = Math.max(22 + 2 * spacingR(submitCls, 'py', wide), Number(/min-h-(\d+(?:\.\d+)?)/.exec(submitCls)?.[1] ?? 0) * 4)
  const form = fields + 2 * spacingR(formCls, 'gap', wide) + submitH + spacing(submitCls, 'mt')
  return pad * 2
    + 28 + spacingR(classOf(/<Link href="\/" className="([^"]*)"/, 'the logo'), 'mb', wide)
    + 32 + spacing(classOf(/<h1 className="([^"]*)"/, 'the heading'), 'mb')
    + lines(plan.length, content, 6.6) * 20 + spacingR(classOf(/<p className="([^"]*)">\s*\{signUpPlanLine/, 'the plan line'), 'mb', wide)
    + 44
    + spacing(classOf(/<p className="([^"]*)" data-testid="trial-rule"/, 'the trial rule'), 'mt')
    + lines(rule.length, content, 5.6) * 16 + spacingR(classOf(/<p className="([^"]*)" data-testid="trial-rule"/, 'the trial rule'), 'mb', wide)
    + 16 + spacingR(classOf(/<div className="([^"]*)"><span className="h-px/, 'the divider'), 'mb', wide)
    + form
    + spacingR(classOf(/<p className="([^"]*)">\s*Already have an account\?/, 'the sign-in line'), 'mt', wide) + 20
    + spacingR(classOf(/<p className="([^"]*)">\s*By creating an account/, 'the terms line'), 'mt', wide)
    + lines(terms.length, content, 5.6) * 16
}

test('#1782 the sign-up page fits a 1280x800 desktop window, footer included', () => {
  const total = cardHeight(1280) + 45
  assert.ok(total <= 800, `the sign-up page is ${total}px tall in an 800px window (card + compact footer)`)
})

test('#1782 the sign-up page fits a 389x843 phone window, footer included', () => {
  const total = cardHeight(389) + 97
  assert.ok(total <= 843, `the sign-up page is ${total}px tall in an 843px window (card + wrapped footer)`)
})
