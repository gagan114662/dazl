import HomeSteps from './home-steps'
import FeatureDiscovery from './feature-discovery'
import SellerCard from './seller-card'

export default function AppHome() {
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Welcome to dazl</h1>
      <p className="text-[#555] text-sm mb-8">Tell dazl what you sell, then three steps to your first verified leads.</p>
      <SellerCard />
      <HomeSteps />
      <FeatureDiscovery />
    </div>
  )
}
