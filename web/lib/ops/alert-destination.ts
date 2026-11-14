// Where an ops alert goes, and the body that destination accepts (issue #1088). One rule for every sender: the app's
// error hook (lib/ops/errors.ts), the backup check (scripts/backup/backup-check.mts) and the scheduler check
// (scripts/ops/scheduler-check.mts). OPS_ALERT_WEBHOOK_URL is one https URL:
//   - a Telegram bot:  https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat id>
//     Telegram only accepts { chat_id, text }: the alert's one-block summary is sent as the text (plain text, no link
//     preview, cut to Telegram's 4096-character limit). The structured JSON is not sent (Telegram would reject it).
//   - anything else (a Slack incoming webhook, a relay): POST of the structured JSON plus a `text` summary, which is
//     what Slack-style receivers show.
// Pure: no network, no environment. The URL holds the bot token: callers never log it (they log the HTTP status only).
// Relative imports only, so the scripts can use it.
export interface AlertRequest { url: string; body: string }

const TELEGRAM_MAX = 4096
const isTelegram = (u: URL) => u.hostname === 'api.telegram.org' && /^\/bot[^/]+\/sendMessage$/.test(u.pathname)

// null = this URL cannot receive an alert (not https, unparsable, or a Telegram URL with no chat_id): the caller treats
// it exactly like "no destination" and says so, instead of sending something the receiver will reject forever.
export function alertRequest(url: string | undefined, payload: Record<string, unknown>, text: string): AlertRequest | null {
  if (!url || !/^https:\/\//.test(url)) return null
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (isTelegram(u)) {
    const chat = u.searchParams.get('chat_id')?.trim()
    if (!chat || !/^-?\d{1,20}$|^@[A-Za-z0-9_]{4,64}$/.test(chat)) return null
    const cut = text.length > TELEGRAM_MAX ? `${text.slice(0, TELEGRAM_MAX - 20)}\n... (cut)` : text
    return { url: `${u.origin}${u.pathname}`, body: JSON.stringify({ chat_id: /^-?\d+$/.test(chat) ? Number(chat) : chat, text: cut || 'dazl alert', disable_web_page_preview: true }) }
  }
  return { url, body: JSON.stringify({ text, ...payload }) }
}

// Why a configured URL is unusable, for the sender's own log line (never includes the URL).
export function alertDestinationProblem(url: string | undefined): string | null {
  if (!url) return 'OPS_ALERT_WEBHOOK_URL is not set'
  if (!/^https:\/\//.test(url)) return 'OPS_ALERT_WEBHOOK_URL is not an https URL'
  let u: URL
  try { u = new URL(url) } catch { return 'OPS_ALERT_WEBHOOK_URL is not a URL' }
  if (u.hostname === 'api.telegram.org') {
    if (!isTelegram(u)) return 'the Telegram URL must be https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>'
    if (alertRequest(url, {}, 'x') === null) return 'the Telegram URL has no valid chat_id (?chat_id=<number or @channel>)'
  }
  return null
}
