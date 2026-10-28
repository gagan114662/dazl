import { redirect } from 'next/navigation'

// "Replies" was renamed "Social opportunities" (/app/social). Old links and bookmarks still land on it.
export default function RepliesRedirect() { redirect('/app/social') }
