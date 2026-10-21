import { DIRECTORIES } from '@/lib/seo/directories'

const CATEGORIES = ['Launch', 'Software review', 'AI tools', 'Business & local'] as const

// Curated directories, verified live when this list was built (see lib/seo/directories.ts).
// One click opens the directory in a new tab; submitting is always manual - dazl never submits
// on the user's behalf.
export default function DirectoriesPanel() {
  return (
    <div className="card p-6 mb-8">
      <h2 className="font-semibold mb-1">Directories worth a listing</h2>
      <p className="text-[#555] text-sm mb-3">{DIRECTORIES.length} directories, each verified live when this list was built. Click to open, submit by hand - a listing you write yourself always beats an automated blast.</p>
      {CATEGORIES.map(cat => (
        <div key={cat} className="mb-4">
          <h3 className="text-xs font-mono uppercase tracking-wider text-[#888] mb-1">{cat}</h3>
          <ul className="space-y-1">
            {DIRECTORIES.filter(d => d.category === cat).map(d => (
              <li key={d.url} className="text-sm">
                <a href={d.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{d.name}</a>
                <span className="text-[#555] text-xs ml-2">{d.note}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
