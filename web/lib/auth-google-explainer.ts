// #1603: dazl's Google app is live but Google has not reviewed it yet, so Google shows "Google hasn't verified this app"
// before the Gmail permission screen. A customer who meets that with no warning stops there. This is the page shown
// first (app/app/connect-gmail/page.tsx): what the warning is, which two clicks get past it, and exactly what dazl is
// asking for. Every "Connect Gmail" link should point at GMAIL_EXPLAINER_PATH; the page's button goes on to Google.
// The words here must stay true of lib/gmail/oauth.ts: the one Gmail permission asked for is sending (gmail.send).
// When Google has verified the app, set DAZL_GOOGLE_APP_VERIFIED=1: the warning steps go and only the permission stays.
export const GMAIL_EXPLAINER_PATH = '/app/connect-gmail'
export const GMAIL_CONNECT_START = '/api/gmail/connect'
export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions'

export const googleAppVerified = (env: Record<string, string | undefined> = process.env) => ['1', 'on', 'true', 'yes'].includes((env.DAZL_GOOGLE_APP_VERIFIED ?? '').trim().toLowerCase())

export interface GmailExplainer { title: string; warning: { lead: string; steps: string[] } | null; asks: string[]; cta: string; back: string }

export function gmailExplainer(env: Record<string, string | undefined> = process.env): GmailExplainer {
  return {
    title: 'Before you connect Gmail',
    warning: googleAppVerified(env) ? null : {
      lead: 'Google will first show a warning that says "Google hasn\'t verified this app". That is expected: dazl is new and Google has not reviewed it yet. To carry on:',
      steps: [
        'Choose your Google account.',
        'On the warning, click "Advanced" (bottom left).',
        'Click "Go to dazl.ai (unsafe)". That is Google\'s wording for any app it has not reviewed.',
        'On the next screen, allow dazl to send email for you.',
      ],
    },
    asks: [
      'dazl asks Gmail for one thing: to send email from your address.',
      'It does not ask to read, change or delete your mail.',
      'You can take the permission back at any time in your Google account, under "Third-party apps and services".',
    ],
    cta: 'Continue to Google',
    back: 'Not now',
  }
}
