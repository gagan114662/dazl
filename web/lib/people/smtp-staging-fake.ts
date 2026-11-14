// TEST-ONLY staging fixture (#1036; Hermes 2026-11-12: live checks without a paid service). Active ONLY when DAZL_ENV=staging AND
// DAZL_STAGING_FAKE_SMTP=1 (email-pattern.ts verifierFromEnv); inert everywhere else, so production can never use it. Outbound port 25
// is closed on the box, so staging runs the REAL verifier (smtp-verify.ts: cache, hourly RCPT counter, backoff, catch-all probe) against
// a scripted in-memory mail server that answers by the address, with no network at all:
//   domain starting "catchall."  -> accepts every address (so the result is catch_all, never verified)
//   local part containing "invalid" or "nouser" -> 550 (undeliverable)
//   local part containing "greylist" -> 450 (try later: unknown, and a backoff for that host)
//   local part containing "policy" -> 554 (declined to say: unknown)
//   domain starting "nomx."       -> no such domain (undeliverable)
//   anything else                  -> 250 (deliverable)
// Its checks are recorded under the verifier name 'smtp-staging-fake', never as 'smtp'.
import type { SmtpConn, SmtpEnv, SmtpReply } from './smtp-verify.ts'

function scripted(host: string): SmtpConn {
  const domain = host.replace(/^mx\./, '')
  let mailFrom = false // a real server answers 503 to RCPT without a MAIL FROM in the current transaction
  const out: SmtpReply[] = [{ code: 220, text: `${host} staging fake ESMTP` }]
  return {
    reply: async () => out.shift() ?? { code: 421, text: 'closed' },
    send: line => {
      const u = line.toUpperCase()
      if (u.startsWith('EHLO')) out.push({ code: 250, text: host })
      else if (u.startsWith('MAIL FROM')) { mailFrom = true; out.push({ code: 250, text: 'ok' }) }
      else if (u.startsWith('RSET')) { mailFrom = false; out.push({ code: 250, text: 'ok' }) }
      else if (u.startsWith('QUIT')) out.push({ code: 221, text: 'bye' })
      else if (u.startsWith('RCPT TO') && !mailFrom) out.push({ code: 503, text: '5.5.1 need MAIL first' })
      else if (u.startsWith('RCPT TO')) {
        const to = /<([^>]*)>/.exec(line)?.[1]?.toLowerCase() ?? ''
        const local = to.split('@')[0]
        if (domain.startsWith('catchall.')) out.push({ code: 250, text: 'ok' })
        else if (local.includes('invalid') || local.includes('nouser') || local.startsWith('dazl-check-')) out.push({ code: 550, text: '5.1.1 no such user' })
        else if (local.includes('greylist')) out.push({ code: 450, text: '4.2.0 greylisted, try later' })
        else if (local.includes('policy')) out.push({ code: 554, text: '5.7.1 policy' })
        else out.push({ code: 250, text: 'ok' })
      } else out.push({ code: 500, text: 'unknown command' })
    },
    close: () => { /* in memory */ },
  }
}

export function stagingSmtpEnv(): SmtpEnv {
  return {
    resolveMx: async d => { if (d.startsWith('nomx.')) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return [{ exchange: `mx.${d}`, priority: 10 }] },
    resolveA: async () => [],
    resolveZen: async () => 'clean',
    connect: async host => scripted(host),
    now: () => Math.floor(Date.now() / 1000),
    random: () => Math.random().toString(16).slice(2, 14),
  }
}
