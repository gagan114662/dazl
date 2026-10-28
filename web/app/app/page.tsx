import Readiness from './readiness'
import FeatureDiscovery from './feature-discovery'
import FirstRun from './first-run'

export default function AppHome() {
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Welcome to dazl</h1>
      <p className="text-[#555] text-sm mb-8">Find businesses that need what you sell, each with a public source, then email them from your own Gmail after you approve every word.</p>
      {/* The checklist is at the top for every account, new ones included (above the setup steps); it hides when done. */}
      <Readiness />
      <FirstRun>
        <FeatureDiscovery />
      </FirstRun>
    </div>
  )
}
