import HomeSteps from './home-steps'

export default function AppHome() {
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Welcome to dazl</h1>
      <p className="text-[#555] text-sm mb-8">Three steps to your first verified leads.</p>
      <HomeSteps />
    </div>
  )
}
