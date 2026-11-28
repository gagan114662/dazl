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

async function smtpOptions(input: SmtpMailbox, lookup?: Lookup): Promise<SmtpOptions> {
  if (!input.username.trim() || !input.password) throw new Error('Enter your SMTP username and app password')
  return {
    ...await smtpEndpoint(input.host, input.port, lookup),
    auth: { user: input.username, pass: input.password },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  }
}

export async function verifySmtpMailbox(input: SmtpMailbox, deps: {
  lookup?: Lookup
  connect?: (options: SmtpOptions) => VerificationTransport
} = {}): Promise<void> {
  const options = await smtpOptions(input, deps.lookup)
  let transport: VerificationTransport | undefined
  try {
    transport = (deps.connect ?? (configuration => nodemailer.createTransport(configuration)))(options)
    if (await transport.verify()) return
  } catch {
    // Server and transport errors may echo authentication data.
  } finally {
    transport?.close()
  }
  throw new Error('Could not verify the SMTP mailbox')
}

type SmtpMessage = { envelope: { from: string; to: string }; raw: Buffer }
type SendingTransport = {
  sendMail(message: SmtpMessage): Promise<{ accepted: string[]; messageId: string }>
  close(): void
}

export async function sendSmtpMessage(input: SmtpMailbox, message: SmtpMessage, deps: {
  lookup?: Lookup
  connect?: (options: SmtpOptions) => SendingTransport
  assertAuthorized: () => void
}): Promise<{ id: string }> {
  const options = await smtpOptions(input, deps.lookup)
  deps.assertAuthorized()
  let transport: SendingTransport | undefined
  try {
    transport = (deps.connect ?? (configuration => nodemailer.createTransport(configuration)))(options)
    const result = await transport.sendMail(message)
    if (result.accepted.length === 1 && result.accepted[0].toLowerCase() === message.envelope.to.toLowerCase()
      && result.messageId.trim()) return { id: result.messageId }
  } catch {
    // The relay may have accepted the message before the connection failed.
  } finally {
    transport?.close()
  }
  throw new Error('SMTP delivery could not be confirmed')
}
