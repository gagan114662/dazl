// Synthetic structured delivery-status notice as Gmail returns it inside a recipient thread (offline fixtures only).
const b64 = (s: string) => Buffer.from(s).toString('base64url')
export interface DsnOpts { recipient: string; status?: string; action?: string; from?: string; at: number; authResults?: string | null; threadId?: string; ref?: string; refHeader?: string }
export const dsnAuth = (domain: string) => `mx.google.com; spf=pass smtp.mailfrom=${domain}`
export function sameThreadDsn(id: string, o: DsnOpts) {
  const domain = o.recipient.split('@')[1]
  const ar = o.authResults === undefined ? dsnAuth(domain) : o.authResults
  return { id, threadId: o.threadId ?? 't', internalDate: String(o.at * 1000), payload: {
    mimeType: 'multipart/report',
    headers: [...(ar ? [{ name: 'Authentication-Results', value: ar }] : []), { name: 'From', value: o.from ?? 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }, ...(o.refHeader ? [{ name: 'References', value: o.refHeader }] : [])],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Delivery Status Notification. Delivery to the following recipient failed permanently.') } },
      { mimeType: 'message/delivery-status', body: { data: b64(`Final-Recipient: rfc822; ${o.recipient}\nAction: ${o.action ?? 'failed'}\nStatus: ${o.status ?? '5.1.1'}\nDiagnostic-Code: smtp; 550 ${o.status ?? '5.1.1'} user unknown\n`) } },
      // ref: the returned original headers (text/rfc822-headers) carrying the Message-ID of the send that bounced
      ...(o.ref ? [{ mimeType: 'text/rfc822-headers', body: { data: b64(`Message-ID: ${o.ref}\nTo: ${o.recipient}\nSubject: Quick question\n\n`) } }] : []),
    ],
  } }
}
