'use client'
import { useId, useState, type ReactNode } from 'react'

// The (i) next to a short line: every caveat and factual limit lives here, word for word. It opens on hover, keyboard
// focus or click (touch), and the text stays in the page for screen readers (aria-describedby). The id is React's
// useId (tree-position based): identical on the server and the client, so hydration never mismatches. A module-level
// counter is NOT safe here - the server shares it across requests, so server markup carries inflated ids and every
// authed page with a tooltip fails hydration (React #418) and re-renders client-side.
export default function InfoTip({ children, label = 'More information' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="infotip ml-1" data-open={open ? 'true' : 'false'} data-testid="infotip" onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-describedby={id} aria-expanded={open} onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>i</button>
      <span role="tooltip" id={id} data-testid="infotip-text">{children}</span>
    </span>
  )
}
