import { redirect } from 'next/navigation'

// #534: /plans 404'd; the homepage's #pricing section is the canonical plan content.
export default function Plans() { redirect('/#pricing') }
