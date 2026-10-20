export const metadata = { title: 'Privacy Policy - dazl' }

export default function Privacy() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-16 text-[#555] text-sm leading-relaxed">
      <p className="mb-6 rounded-lg border border-black/40 bg-[#f4f4f4] p-3 text-[#111]">
        DRAFT - placeholder text for review by the site owner and a lawyer before launch. Not legal advice.
      </p>
      <h1 className="text-2xl font-semibold text-[#111] mb-4">Privacy Policy</h1>
      <p className="mb-4">Last updated: [DATE]. [COMPANY LEGAL NAME] ("dazl", "we") operates dazl.ai.</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">What we collect</h2>
      <p>Account details (name, email, business name, a salted password hash), usage data, and data about prospects that your agent finds from public sources, with the source link for each.</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">How we use it</h2>
      <p>To run your account, find and score prospects, draft and send outreach you approve, and keep the service secure.</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">Sharing</h2>
      <p>We use service providers (hosting, email delivery, payments) [LIST]. We do not sell personal information.</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">Retention and your rights</h2>
      <p>You can ask us to access, correct or delete your data, and prospects can ask to stop receiving messages at any time. Contact: [PRIVACY EMAIL].</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">Outbound email</h2>
      <p>Messages sent through dazl identify the sender, include a postal address, and include an unsubscribe option. [CONFIRM CASL / CAN-SPAM COMPLIANCE WITH COUNSEL]</p>
    </main>
  )
}
