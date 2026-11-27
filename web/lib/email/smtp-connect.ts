import { isIP } from 'node:net'
import nodemailer from 'nodemailer'
import { defaultLookup, resolvePublic, type Lookup } from '../net/public-fetch.ts'

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

// Nodemailer dials the approved IP directly. TLS still checks the configured DNS name.
export async function smtpEndpoint(rawHost: string, port: number, lookup: Lookup = defaultLookup) {
  if (port !== 465 && port !== 587) throw new Error('Use SMTP TLS port 465 or 587')
  const hostname = rawHost.trim().toLowerCase()
  const labels = hostname.split('.')
  if (hostname.length > 253 || isIP(hostname) || labels.length < 2 || !labels.every(label => DNS_LABEL.test(label))) {
    throw new Error('Enter an SMTP hostname')
  }
  const addresses = await resolvePublic(hostname, lookup)
  if (!addresses) throw new Error('SMTP hostname must resolve to public addresses')

  return {
    host: addresses[0].address,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    tls: { servername: hostname, rejectUnauthorized: true },
  }
}

type SmtpMailbox = { host: string; port: number; username: string; password: string }
type SmtpOptions = Awaited<ReturnType<typeof smtpEndpoint>> & {
  auth: { user: string; pass: string }
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
}
type VerificationTransport = { verify(): Promise<boolean>; close(): void }

export async function verifySmtpMailbox(input: SmtpMailbox, deps: {
  lookup?: Lookup
  connect?: (options: SmtpOptions) => VerificationTransport
} = {}): Promise<void> {
  if (!input.username.trim() || !input.password) throw new Error('Enter your SMTP username and app password')
  const endpoint = await smtpEndpoint(input.host, input.port, deps.lookup)
  let transport: VerificationTransport | undefined
  try {
    transport = (deps.connect ?? (options => nodemailer.createTransport(options)))({
      ...endpoint,
      auth: { user: input.username, pass: input.password },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 12_000,
    })
    if (await transport.verify()) return
  } catch {
    // Server and transport errors may echo authentication data.
  } finally {
    transport?.close()
  }
  throw new Error('Could not verify the SMTP mailbox')
}
