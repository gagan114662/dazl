import { redirect } from 'next/navigation'

// #1428: /about used to 404. What dazl is and how it works is the homepage's "How it works" section.
export default function About() { redirect('/#how') }
