import assert from 'node:assert/strict'
import test from 'node:test'

test('SMTP requires TLS and pins the public address while preserving the certificate hostname', async () => {
  const { smtpEndpoint } = await import('../lib/email/smtp-connect.ts')
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
  assert.deepEqual(await smtpEndpoint('Mail.example.com', 587, lookup), {
    host: '8.8.8.8', port: 587, secure: false, requireTLS: true,
    tls: { servername: 'mail.example.com', rejectUnauthorized: true },
  })
  const implicit = await smtpEndpoint('relay.example.net', 465, lookup)
  assert.equal(implicit.secure, true)
  assert.equal(implicit.tls.servername, 'relay.example.net')
})

test('SMTP refuses plaintext ports, malformed hosts and non-public DNS answers', async () => {
  const { smtpEndpoint } = await import('../lib/email/smtp-connect.ts')
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]
  await assert.rejects(smtpEndpoint('mail.example.com', 25, lookup), /TLS port/)
  await assert.rejects(smtpEndpoint('mail.example.com/path', 587, lookup), /hostname/)
  await assert.rejects(smtpEndpoint('mail.example.com', 587, lookup), /public/)
})

test('SMTP verifies authentication without sending and closes its transport', async () => {
  const { verifySmtpMailbox } = await import('../lib/email/smtp-connect.ts')
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
  const input = { host: 'mail.example.net', port: 587, username: 'owner@example.net', password: 'test credential' }
  const events: string[] = []
  await verifySmtpMailbox(input, {
    lookup,
    connect: options => {
      assert.equal(options.host, '8.8.8.8')
      assert.deepEqual(options.auth, { user: input.username, pass: input.password })
      return { verify: async () => { events.push('verify'); return true }, close: () => { events.push('close') } }
    },
  })
  assert.deepEqual(events, ['verify', 'close'])

  await assert.rejects(verifySmtpMailbox(input, {
    lookup,
    connect: () => ({
      verify: async () => { throw new Error(input.password) },
      close: () => { events.push('closed after failure') },
    }),
  }), { message: 'Could not verify the SMTP mailbox' })
  assert.equal(events.at(-1), 'closed after failure')
  await assert.rejects(verifySmtpMailbox({ ...input, port: 25 }, {
    lookup,
    connect: () => assert.fail('invalid endpoints must never open an SMTP connection'),
  }), /TLS port/)
})
