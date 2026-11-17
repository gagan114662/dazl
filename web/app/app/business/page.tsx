import BusinessClient from './business-client'

// #1043: one page with what dazl knows about the customer's business (profile, Memory, Competitors), editable in place.
export const metadata = { title: 'Your business' }

export default function BusinessPage() {
  return <BusinessClient />
}
