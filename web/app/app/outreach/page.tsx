export default function Outreach() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-1">Outreach</h1>
      <p className="text-gray-400 text-sm mb-8">Emails and LinkedIn messages queued, sent, and replied.</p>

      <div className="grid grid-cols-3 gap-4 mb-8">
        {['Queued', 'Sent today', 'Replied'].map(s => (
          <div key={s} className="bg-white/5 border border-white/10 rounded-2xl p-5">
            <div className="text-3xl font-bold">—</div>
            <div className="text-gray-400 text-sm mt-1">{s}</div>
          </div>
        ))}
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 text-center text-gray-500 text-sm py-16">
        <p className="text-lg font-medium text-gray-400 mb-2">No outreach yet</p>
        <p>Connect your Gmail in Settings, then run a scan to start outreach.</p>
      </div>
    </div>
  )
}
