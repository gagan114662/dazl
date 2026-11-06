# Frontend quality baseline (#534)

What is checked automatically for accessibility, mobile layout and public metadata, what was found and fixed, and
what is NOT covered. Check: `test/ui/frontend-baseline.ui.mjs`, run by `npm run test:smoke` (so in the release-gate
`browser` job and the web-preview job, whose `preview` artifact carries the screenshots in `preview/frontend-baseline/`).
Run locally: `cd web && npm run build && npm install --no-save playwright@1.63.0 && npm run test:smoke:frontend`
(axe-core 4.14 is already in the lockfile, via eslint-plugin-jsx-a11y).

## Inventory before this change

- No automated accessibility rule engine ran anywhere (no axe, Lighthouse or pa11y). `eslint-config-next` includes some
  `jsx-a11y` lint rules at source level only.
- Keyboard: individual UI harnesses press Escape on popovers (`caveats.ui.mjs`, `infotip-hydration.ui.mjs`) and assert
  some ARIA state (`aria-expanded`, `aria-describedby`, `aria-pressed`, `aria-current`, `aria-selected` in
  `infotip-hydration`, `landing`, `plays`, `lead-flow`). No test walked the Tab order or checked visible focus.
- Mobile: 14 UI harnesses (e.g. `landing`, `lead-flow`, `followups-held`, `team`, `social`, `audit`) render at a
  320-430px viewport and assert specific content fits. All are viewport resizing in desktop Chromium; none used device
  emulation (touch, DPR, mobile UA) and none ran on a physical device.
- Metadata: `canonical.test.ts` and `indexing.test.ts` check canonical/robots at source level. No test read the served
  HTML for title/description/og/twitter tags or fetched the og image.

## What the check does (per run, on the production build, fenced)

Pages: `/`, `/sign-in`, `/sign-up`, `/privacy`, `/terms`, `/reset`, and the core journeys `/app/leads` (lead cards,
from synthetic stubbed `/api` rows), `/app/inbox` (threads, stubbed), `/app/settings` (real fenced server, empty DB).
Viewports: desktop 1280x900, and Playwright's `iPhone 13` and `Pixel 7` device descriptors run in Chromium.

1. **axe-core 4.14** with tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa` (includes contrast and 2.5.8 target size).
   Results must equal `test/ui/frontend-baseline.json` exactly; new, grown, shrunk or vanished entries fail, so the
   file is always the current open list. Run with `prefers-reduced-motion: reduce` so the homepage demo is measured in
   its finished state rather than a random animation frame.
2. **Keyboard**: from a fresh load, Tab walks the page. First stop must be the skip link; every stop must be visible
   while focused and look different focused vs unfocused (outline/ring/border/background/colour/underline, on the
   control, a wrapper up to two levels, or the visible label of a visually hidden input); every visible tabbable
   control must be reached. Then Enter on the skip link must land on `#main` and the next Tab inside it.
3. **Overflow**: no horizontal page overflow (`html` or `main`) at any viewport.
4. **Metadata** (server HTML, as a non-JS crawler sees it): unique title, description, self canonical, og:title (= the
   title), og:description, og:url (= canonical), og:image + width/height, twitter:card `summary_large_image`,
   twitter:title, twitter:image; each image is fetched and must be a 1200x630 PNG. `/reset` must be noindex without a
   canonical. robots.txt points at the sitemap and disallows `/app` and `/api`; every sitemap URL answers 200;
   `/pricing` and `/plans` answer 307 to `/#pricing`.

## Found by the first run, and fixed in this branch

- Skip link: `/app/*`, `/reset`, `/verify` had no `id="main"`, so "Skip to content" went nowhere.
- `/app/*` desktop: the hidden mobile-menu checkbox was a Tab stop with nothing visible (now `md:hidden`); on phones
  its focus showed nowhere (now a ring on the visible "Menu" label).
- Metadata: sign-in, sign-up and reset reused the homepage title; every public page's og:url and og:title were the
  homepage's (Next merges metadata shallowly); setting per-page openGraph also dropped the og:image. Now
  `lib/site.ts publicMeta()` gives each public page its own title, og/twitter tags and the shared image.
- axe on Settings: unlabelled selects (the model-key provider select and the team role selects; the invite email had
  only a placeholder); workspace label not associated; section links 16px tall on phones (target-size). Inbox:
  `aria-label` on a role-less span (now `role="img"`); `#888` timestamps/notes at 3.5:1 contrast. Settings notes
  `#777`/`#888` likewise. Now `#6b6b6b` (5.3:1).
- Homepage "Live" label `--live: #1f8a5b` at 4.3:1 on white; now `#1b7a51` (5.3:1).

Baseline after the fixes: **no axe violations** on the 9 pages x 3 viewports above (`frontend-baseline.json` is empty).

## Not covered (explicit limits)

- **Physical devices: none.** iPhone 13 / Pixel 7 are Chromium emulation (viewport, DPR, touch events, UA). No real
  Safari/WebKit, no real Android Chrome, no physical touch, no on-screen keyboard behaviour. This is not real-device
  testing.
- **Assistive technology: none.** No screen reader (VoiceOver, TalkBack, NVDA) pass. axe finds only machine-checkable
  issues; a clean axe run is not WCAG conformance.
- **Pages not in the list** (other `/app/*` pages, `/verify`, `/preview/*`) are not axe-checked or keyboard-walked;
  `test:smoke` only proves they load. Leads/Inbox content is synthetic stub data: states not stubbed (errors, empty
  connected inbox, many cards) are not covered.
- **Touch target 44px** (the WCAG 2.5.5 AAA / Apple HIG size) is not enforced; axe's 2.5.8 AA 24px rule is.
- **Social previews**: code level only. The tags and image are verified on the local build; how LinkedIn, X, Slack
  etc. render the live dazl.ai link (and their caches) is not checked here.
