// Builds a plain-text RFC 5322 message for the Gmail API. Every header value is
// stripped of CR/LF so user text cannot inject headers or extra recipients.

const clean = (s: string) => s.replace(/[\r\n\u0000]+/g, ' ').trim()
const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s)
const encWord = (s: string) => (ascii(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)
const wrap76 = (b64: string) => b64.replace(/(.{76})/g, '$1\r\n')

export { PUBLISHED_EMAIL_RE as EMAIL_RE } from '../outreach/published-email.ts'
import { PUBLISHED_EMAIL_RE as EMAIL_RE } from '../outreach/published-email.ts'

export interface MimeInput {
  fromName: string
  fromEmail: string
  to: string
  subject: string
  body: string
  messageId: string // without angle brackets
  unsubscribeUrl: string
  date?: Date
  inReplyTo?: string // message id without angle brackets
}

export function buildMime(m: MimeInput): string {
  if (!EMAIL_RE.test(m.fromEmail) || !EMAIL_RE.test(m.to)) throw new Error('bad_address')
  const name = clean(m.fromName).replace(/["\\]/g, '')
  const from = name ? `${ascii(name) ? `"${name}"` : encWord(name)} <${m.fromEmail}>` : m.fromEmail
  const headers = [
    `From: ${from}`,
    `To: ${m.to}`,
    `Subject: ${encWord(clean(m.subject))}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${clean(m.messageId)}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${clean(m.inReplyTo)}>`, `References: <${clean(m.inReplyTo)}>`] : []),
    `List-Unsubscribe: <${clean(m.unsubscribeUrl)}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  const body = m.body.replace(/\r?\n/g, '\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(body, 'utf8').toString('base64'))}\r\n`
}

export const toBase64Url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
