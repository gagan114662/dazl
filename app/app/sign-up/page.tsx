export default function SignUp() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="bg-white/5 border border-white/10 rounded-2xl p-10 w-full max-w-sm text-center">
        <a href="/" className="text-xl font-bold tracking-tight">dazl<span className="text-indigo-400">.</span></a>
        <h1 className="text-2xl font-bold mt-6 mb-2">Start your free trial</h1>
        <p className="text-gray-400 text-sm mb-8">14 days free. CA$99/mo after. Cancel anytime.</p>
        <form action="/api/auth/signup" method="POST" className="flex flex-col gap-4">
          <input name="name" type="text" required placeholder="Your name"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
          <input name="email" type="email" required placeholder="you@company.com"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
          <input name="business" type="text" required placeholder="Business name"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
          <button type="submit" className="bg-indigo-500 hover:bg-indigo-400 px-6 py-3 rounded-xl font-semibold transition">
            Start free trial
          </button>
        </form>
        <p className="mt-6 text-sm text-gray-500">
          Already have an account? <a href="/sign-in" className="text-indigo-400 hover:underline">Sign in</a>
        </p>
      </div>
    </main>
  )
}
