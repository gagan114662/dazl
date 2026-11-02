import { redirect } from 'next/navigation'

// #534: /pricing 404'd while the only pricing content is the homepage's #pricing section.
// Redirect to the canonical section instead of duplicating pricing copy (one source of truth).
export default function Pricing() { redirect('/#pricing') }
