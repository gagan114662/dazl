// Copy for the /app error boundary (app/app/error.tsx). The boundary only knows that this page failed to show; it
// cannot see whether an action the user just took (approve, send, scan, draft) already went through. So the copy
// describes the display failure only, never "nothing was sent/changed", and asks the user to check before repeating.
export const BOUNDARY_COPY = {
  chunk: {
    title: 'dazl was updated',
    body: 'This page is from an older version and could not be shown. Reload to get the current version. If you had just done something here, check its result after reloading before doing it again.',
  },
  other: {
    title: 'This page could not be shown',
    body: 'Something went wrong while showing this page. If you had just done something here, it may already have gone through: reload and check its result before doing it again.',
  },
} as const
