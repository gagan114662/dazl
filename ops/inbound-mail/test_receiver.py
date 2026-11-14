"""Tests for the dazl inbound mail receiver (ops/inbound-mail/receiver.py).

The app is a real local HTTP server (FakeBackend) answering the contract, so the HTTP client, its headers, timeout and
retry are exercised for real. Outbound mail is captured. The SMTP-level tests need aiosmtpd (python3-aiosmtpd, the same
package the box runs); they are skipped where it is missing, and CI installs it.
"""
import asyncio
import base64
import email
import email.policy
import http.server
import json
import os
import shutil
import smtplib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import receiver as R  # noqa: E402

try:
    import aiosmtpd  # noqa: F401
    HAVE_AIOSMTPD = True
except ImportError:
    HAVE_AIOSMTPD = False

KEY = 'test-key-not-a-real-secret'
FALLBACK = 'owner-inbox@example.net'
SYSTEM_FROM = 'dazl <system@notify.example.org>'

# A reply as one arrives from a prospect's Gmail (wording from a real reply to dazl outreach; names, addresses and ids
# replaced). CRLF line endings, a quoted original and a Message-ID thread, as on the wire.
REAL_REPLY = (
    'Return-Path: <dana.whitfield@prospect.example>\r\n'
    'Received: from mail-yb1-f171.google.com (mail-yb1-f171.google.com [209.85.219.171])\r\n'
    '\tby mx.example with ESMTPS id 3f1490d57ef6-e0b1c2d3e4f5\r\n'
    '\tfor <reply@dazl.ai>; Fri, 13 Nov 2026 14:02:11 +0000 (UTC)\r\n'
    'MIME-Version: 1.0\r\n'
    'References: <outreach-7c1e5b0a@notify.example.org>\r\n'
    'In-Reply-To: <outreach-7c1e5b0a@notify.example.org>\r\n'
    'From: Dana Whitfield <dana.whitfield@prospect.example>\r\n'
    'Date: Fri, 13 Nov 2026 09:02:00 -0500\r\n'
    'Message-ID: <CAJx7dQ1k2exampleid@mail.gmail.com>\r\n'
    'Subject: Re: Saw you are hiring two account executives\r\n'
    'To: reply@dazl.ai\r\n'
    'Content-Type: text/plain; charset="UTF-8"\r\n'
    '\r\n'
    'Not interested right now, please take me off your list.\r\n'
    '\r\n'
    'On Thu, Nov 12, 2026 at 4:15 PM Sam at Northside <sam@seller.example> wrote:\r\n'
    '> Hi Dana, saw the two account executive openings you posted last week.\r\n'
).encode()

# What dazl.ai and staging answer on POST /internal/admin/inbound-email today (2026-11-14): Next's 404 page. The route
# does not exist in the app yet, so this is the answer the receiver must survive without losing or bouncing mail.
REAL_404_BODY = b'<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head><body></body></html>'


class FakeBackend:
    """A local HTTP server standing in for the app. `answers` is a queue of (status, body bytes | dict | callable)."""

    def __init__(self):
        self.requests, self.answers = [], []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('content-length', 0)))
                outer.requests.append({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': body})
                status, answer = outer.answers.pop(0) if outer.answers else (200, {'action': 'accept'})
                if callable(answer):
                    answer = answer()
                if isinstance(answer, dict):
                    answer = json.dumps(answer).encode()
                try:
                    self.send_response(status)
                    if status in (301, 302, 307):
                        self.send_header('location', '/elsewhere')
                    self.send_header('content-length', str(len(answer)))
                    self.end_headers()
                    self.wfile.write(answer)
                except OSError:
                    pass

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/internal/admin/inbound-email'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='inbound-mail-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.backend = FakeBackend()
        self.addCleanup(self.backend.close)
        self.sent = []
        self.send_error = None

    def config(self, **over):
        cfg = json.loads(json.dumps(R.DEFAULTS))
        cfg.update({'backend_url': self.backend.url, 'fallback_forward': FALLBACK, 'spool_dir': str(self.tmp / 'spool'),
                    'tls_cert': str(self.tmp / 'none.pem'), 'tls_key': str(self.tmp / 'none.key')})
        cfg.update(over)
        (self.tmp / 'config.json').write_text(json.dumps(cfg))
        return R.load_config(self.tmp / 'config.json')

    def receiver(self, env=None, timeout=5.0, **over):
        def send(env_from, rcpt, data):
            if self.send_error:
                raise self.send_error
            self.sent.append({'env_from': env_from, 'rcpt': rcpt, 'data': data})
        base_env = {'INBOUND_BACKEND_KEY': KEY, 'SYSTEM_MAIL_SMTP_URL': 'smtps://u:p@relay.invalid:465', 'SYSTEM_MAIL_FROM': SYSTEM_FROM}
        base_env.update(env or {})
        return R.Receiver(self.config(**over), env=base_env, send=send, timeout=timeout, retry_delay=0.01)

    def spooled(self):
        d = self.tmp / 'spool'
        return sorted(p.name for p in d.iterdir()) if d.is_dir() else []

    async def deliver(self, r, data=REAL_REPLY, mail_from='dana.whitfield@prospect.example', rcpt='reply@dazl.ai'):
        return await r.deliver('203.0.113.9', mail_from, rcpt, data)


class BackendContract(Base):
    async def test_accept_is_250_and_the_app_gets_the_worker_contract(self):
        r = self.receiver()
        self.backend.answers = [(200, {'action': 'accept'})]
        self.assertTrue((await self.deliver(r)).startswith('250'))
        (req,) = self.backend.requests
        self.assertEqual(req['path'], '/internal/admin/inbound-email')
        self.assertEqual(req['headers']['x-dazl-key'], KEY)
        self.assertEqual(req['headers']['x-dazl-forwarded'], '1')
        self.assertEqual(req['headers']['content-type'], 'application/json')
        body = json.loads(req['body'])
        self.assertEqual(sorted(body), ['from', 'raw', 'to'])
        self.assertEqual((body['from'], body['to']), ('dana.whitfield@prospect.example', 'reply@dazl.ai'))
        self.assertEqual(base64.b64decode(body['raw']), REAL_REPLY)  # byte for byte: the app's idempotency key depends on it
        self.assertEqual(self.sent, [])
        self.assertEqual(self.spooled(), [])

    async def test_reject_is_550_with_the_reason_sanitized(self):
        r = self.receiver()
        self.backend.answers = [(200, {'action': 'reject', 'reason': 'Unknown or\r\n250 inactive\x00 mailbox ' + 'x' * 500})]
        reply = await self.deliver(r)
        self.assertTrue(reply.startswith('550 5.7.1 Unknown or 250 inactive mailbox xxx'), reply)
        self.assertNotRegex(reply, r'[\r\n\x00]')  # a reason can never inject a second SMTP line
        self.assertLessEqual(len(reply), 10 + R.REJECT_REASON_CHARS)
        self.backend.answers = [(200, {'action': 'reject', 'reason': ' \r\n '})]
        self.assertEqual(await self.deliver(r), '550 5.7.1 ' + R.POLITE_REJECT)

    async def test_forward_goes_to_the_fallback_only_and_is_wrapped(self):
        r = self.receiver()
        self.backend.answers = [(200, {'action': 'forward', 'to': f'Owner <{FALLBACK.upper()}>'})]
        self.assertTrue((await self.deliver(r)).startswith('250'))
        (m,) = self.sent
        self.assertEqual((m['env_from'], m['rcpt']), ('system@notify.example.org', FALLBACK))
        msg = email.message_from_bytes(m['data'], policy=email.policy.default)
        self.assertEqual(msg['From'], SYSTEM_FROM)  # the relay only takes our verified sending domain
        self.assertEqual(msg['To'], FALLBACK)
        self.assertEqual(msg['Reply-To'], 'dana.whitfield@prospect.example')
        self.assertEqual(msg['Subject'], 'Fwd: Re: Saw you are hiring two account executives')
        self.assertEqual(msg['X-Dazl-Original-To'], 'reply@dazl.ai')
        self.assertIn('please take me off your list', msg.get_body(('plain',)).get_content())
        (att,) = list(msg.iter_attachments())
        self.assertEqual(att.get_filename(), 'original.eml')
        self.assertEqual(att.get_content(), REAL_REPLY)  # the original, untouched

    async def test_forward_to_an_address_the_app_names_is_refused(self):
        r = self.receiver()
        for named in ('attacker@evil.example', f'{FALLBACK}, attacker@evil.example', f'{FALLBACK}\r\nBcc: attacker@evil.example'):
            self.sent.clear()
            self.backend.answers = [(200, {'action': 'forward', 'to': named})]
            self.assertTrue((await self.deliver(r)).startswith('250'))
            self.assertEqual([m['rcpt'] for m in self.sent], [FALLBACK], named)
            self.assertNotIn(b'evil.example', self.sent[0]['data'])
        r = self.receiver(fallback_forward='')  # no fallback configured: the polite reject, nothing sent anywhere
        self.sent.clear()
        self.backend.answers = [(200, {'action': 'forward', 'to': 'attacker@evil.example'})]
        self.assertEqual(await self.deliver(r), '550 5.7.1 ' + R.POLITE_REJECT)
        self.assertEqual(self.sent, [])

    async def test_reply_is_sent_to_the_sender_through_the_relay(self):
        r = self.receiver()
        raw = ('From: Northside front desk <reply@dazl.ai>\r\nTo: dana.whitfield@prospect.example\r\n'
               'Subject: Re: Saw you are hiring\r\nIn-Reply-To: <CAJx7dQ1k2exampleid@mail.gmail.com>\r\n\r\nYou are off the list.\r\n')
        self.backend.answers = [(200, {'action': 'reply', 'from': 'reply@dazl.ai', 'to': 'dana.whitfield@prospect.example', 'raw': raw})]
        self.assertTrue((await self.deliver(r)).startswith('250'))
        (m,) = self.sent
        self.assertEqual((m['env_from'], m['rcpt']), ('system@notify.example.org', 'dana.whitfield@prospect.example'))
        msg = email.message_from_bytes(m['data'], policy=email.policy.default)
        self.assertEqual(msg['From'], 'Northside front desk <system@notify.example.org>')
        self.assertEqual(msg['Reply-To'], 'reply@dazl.ai')
        self.assertEqual(msg['In-Reply-To'], '<CAJx7dQ1k2exampleid@mail.gmail.com>')
        self.assertTrue(m['data'].endswith(b'\r\n\r\nYou are off the list.\r\n'))  # body untouched
        self.assertEqual(len(msg.get_all('From')), 1)

    async def test_reply_as_is_mode_keeps_the_apps_bytes(self):
        r = self.receiver(reply_from_mode='as_is')
        raw = 'From: reply@dazl.ai\r\nTo: dana.whitfield@prospect.example\r\n\r\nhi\r\n'
        self.backend.answers = [(200, {'action': 'reply', 'from': 'reply@dazl.ai', 'to': 'dana.whitfield@prospect.example', 'raw': raw})]
        await self.deliver(r)
        self.assertEqual(self.sent, [{'env_from': 'reply@dazl.ai', 'rcpt': 'dana.whitfield@prospect.example', 'data': raw.encode()}])

    async def test_a_reply_that_fails_the_checks_is_not_sent(self):
        sender = 'dana.whitfield@prospect.example'
        ok = 'From: reply@dazl.ai\r\n\r\nhello\r\n'
        cases = {
            'reply_from': {'from': 'ceo@dazl.ai', 'to': sender, 'raw': ok},
            'reply_to': {'from': 'reply@dazl.ai', 'to': 'someone-else@victim.example', 'raw': ok},
            'reply_to (two recipients)': {'from': 'reply@dazl.ai', 'to': f'{sender}, x@victim.example', 'raw': ok},
            'local_link': {'from': 'reply@dazl.ai', 'to': sender, 'raw': ok + 'see http://localhost:3000/app\r\n'},
        }
        for name, act in cases.items():
            r = self.receiver()
            self.sent.clear()
            self.backend.answers = [(200, {'action': 'reply', **act})]
            self.assertTrue((await self.deliver(r)).startswith('250'), name)  # never a bounce: the app has the conversation
            self.assertEqual([m['rcpt'] for m in self.sent], [FALLBACK], name)  # only the human fallback hears of it
        r = self.receiver(never_reply_to=[sender])
        self.sent.clear()
        self.backend.answers = [(200, {'action': 'reply', 'from': 'reply@dazl.ai', 'to': sender, 'raw': ok})]
        await self.deliver(r)
        self.assertEqual([m['rcpt'] for m in self.sent], [FALLBACK])

    async def test_a_failed_reply_send_still_accepts_the_mail(self):
        r = self.receiver()
        self.send_error = smtplib.SMTPServerDisconnected('relay down')
        self.backend.answers = [(200, {'action': 'reply', 'from': 'reply@dazl.ai', 'to': 'dana.whitfield@prospect.example', 'raw': 'From: reply@dazl.ai\r\n\r\nhi'})]
        self.assertTrue((await self.deliver(r)).startswith('250'))


class BackendDown(Base):
    async def test_backend_down_spools_and_answers_451_after_one_retry(self):
        r = self.receiver()
        self.backend.close()  # connection refused
        attempts = []
        real = r.post

        def counting(*a):
            attempts.append(1)
            return real(*a)
        r.post = counting
        reply = await self.deliver(r)
        self.assertTrue(reply.startswith('451 '), reply)
        self.assertEqual(len(attempts), 2)
        key = R.inbound_key('dana.whitfield@prospect.example', 'reply@dazl.ai', REAL_REPLY)
        self.assertEqual(self.spooled(), [f'{key}.eml', f'{key}.json'])
        self.assertEqual((self.tmp / 'spool' / f'{key}.eml').read_bytes(), REAL_REPLY)
        meta = json.loads((self.tmp / 'spool' / f'{key}.json').read_text())
        self.assertEqual((meta['from'], meta['to'], meta['reason'], meta['route']),
                         ('dana.whitfield@prospect.example', 'reply@dazl.ai', 'network', 'backend'))
        self.assertEqual(self.sent, [])  # down is temporary: the sender retries, nobody is mailed
        self.assertEqual(os.stat(self.tmp / 'spool' / f'{key}.eml').st_mode & 0o777, 0o600)

    async def test_a_5xx_is_retried_once_then_451(self):
        r = self.receiver()
        self.backend.answers = [(502, b'bad gateway'), (503, b'still down')]
        self.assertTrue((await self.deliver(r)).startswith('451 '))
        self.assertEqual(len(self.backend.requests), 2)
        self.assertEqual(self.backend.requests[0]['body'], self.backend.requests[1]['body'])  # same body: the app dedups
        self.assertEqual(len(self.spooled()), 2)
        self.assertEqual(self.sent, [])

    async def test_a_5xx_then_an_answer_is_used(self):
        r = self.receiver()
        self.backend.answers = [(500, b''), (200, {'action': 'reject', 'reason': 'Unknown or inactive mailbox'})]
        self.assertEqual(await self.deliver(r), '550 5.7.1 Unknown or inactive mailbox')
        self.assertEqual(self.spooled(), [])

    async def test_a_timeout_is_not_retried_and_never_rejects(self):
        r = self.receiver(timeout=0.3)
        self.backend.answers = [(200, lambda: (time.sleep(4.0), {'action': 'reject', 'reason': 'late'})[1])]
        t = time.monotonic()
        reply = await self.deliver(r)
        self.assertTrue(reply.startswith('451 '), reply)
        self.assertLess(time.monotonic() - t, 3.5)  # gave up at the timeout, did not wait for the late answer
        self.assertEqual(len(self.backend.requests), 1)
        self.assertEqual(json.loads((self.tmp / 'spool' / self.spooled()[1]).read_text())['reason'], 'timeout')

    async def test_todays_404_from_the_app_goes_to_the_human_fallback_not_a_bounce(self):
        r = self.receiver()
        self.backend.answers = [(404, REAL_404_BODY)]
        reply = await self.deliver(r)
        self.assertTrue(reply.startswith('250'), reply)
        self.assertEqual(len(self.backend.requests), 1)  # a 4xx is never retried
        self.assertEqual([m['rcpt'] for m in self.sent], [FALLBACK])
        self.assertIn(b'the app did not take it (http)', self.sent[0]['data'])
        self.assertEqual(len(self.spooled()), 2)  # and it is kept for replay once the route exists

    async def test_a_4xx_without_a_fallback_is_451_and_spooled(self):
        r = self.receiver(fallback_forward='')
        for status, body in ((404, REAL_404_BODY), (401, b'{"error":"unauthorized"}'), (302, b'')):
            self.backend.answers = [(status, body)]
            self.assertTrue((await self.deliver(r)).startswith('451 '), status)
        self.assertEqual(len(self.backend.requests), 3)  # the redirect was not followed
        self.assertEqual(len(self.spooled()), 2)

    async def test_an_answer_outside_the_contract_is_a_bad_response(self):
        for answer in (b'<html>ok</html>', {'action': 'delete'}, {'action': 'forward'}, {'action': 'reply', 'from': 'a@dazl.ai'}, [1]):
            r = self.receiver(fallback_forward='')
            self.backend.answers = [(200, json.dumps(answer).encode() if not isinstance(answer, bytes) else answer)]
            self.assertTrue((await self.deliver(r)).startswith('451 '), answer)
        self.assertEqual(len(self.spooled()), 2)

    async def test_no_key_never_calls_the_app(self):
        r = self.receiver(env={'INBOUND_BACKEND_KEY': ''})
        self.assertTrue((await self.deliver(r)).startswith('451 '))
        self.assertEqual(self.backend.requests, [])
        self.assertEqual(len(self.spooled()), 2)

    async def test_a_failed_fallback_send_is_451_and_spooled(self):
        r = self.receiver()
        self.send_error = OSError('relay unreachable')
        self.backend.answers = [(200, {'action': 'forward', 'to': FALLBACK})]
        self.assertTrue((await self.deliver(r)).startswith('451 '))
        self.assertEqual(len(self.spooled()), 2)

    async def test_an_internal_error_is_451_and_spooled_never_a_bounce(self):
        r = self.receiver()

        def boom(*a):
            raise RuntimeError('bug')
        r.route_for = boom
        self.assertTrue((await self.deliver(r)).startswith('451 '))
        self.assertEqual(len(self.spooled()), 2)

    async def test_the_key_is_the_workers_inbound_key(self):
        import hashlib
        self.assertEqual(R.inbound_key('A@X.example', 'Reply@Dazl.ai', b'raw'),
                         hashlib.sha256(b'a@x.example\nreply@dazl.ai\nraw').hexdigest())

    async def test_replay_redelivers_and_clears_the_spool(self):
        r = self.receiver()
        self.backend.answers = [(503, b''), (503, b'')]
        await self.deliver(r)
        self.backend.answers = [(503, b''), (503, b'')]
        self.assertEqual(await r.replay(), {'replayed': 0, 'failed': 1, 'more': False})
        self.assertEqual(len(self.spooled()), 2)
        self.backend.answers = [(200, {'action': 'reply', 'from': 'reply@dazl.ai', 'to': 'dana.whitfield@prospect.example', 'raw': 'x'})]
        self.assertEqual(await r.replay(), {'replayed': 1, 'failed': 0, 'more': False})
        self.assertEqual(self.spooled(), [])
        self.assertEqual(self.sent, [])  # a replay records the mail in the app; it does not perform the action
        self.assertEqual(base64.b64decode(json.loads(self.backend.requests[-1]['body'])['raw']), REAL_REPLY)

    async def test_spool_cleanup_removes_only_files_older_than_30_days(self):
        r = self.receiver()
        d = self.tmp / 'spool'
        d.mkdir()
        for name, age_days in (('old.eml', 31), ('old.json', 31), ('fresh.eml', 29), ('fresh.json', 29)):
            (d / name).write_text('x')
            t = time.time() - age_days * 86400
            os.utime(d / name, (t, t))
        self.assertEqual(r.spool_clean(), 2)
        self.assertEqual(self.spooled(), ['fresh.eml', 'fresh.json'])


class Routing(Base):
    async def test_other_addresses_go_to_the_fallback_by_default(self):
        r = self.receiver()
        self.assertTrue((await self.deliver(r, rcpt='Hello@DAZL.ai')).startswith('250'))
        self.assertEqual(self.backend.requests, [])  # only reply@ talks to the app
        self.assertEqual([m['rcpt'] for m in self.sent], [FALLBACK])

    async def test_a_route_can_name_its_own_inbox_or_reject(self):
        r = self.receiver(routes={'reply@dazl.ai': {'action': 'backend'},
                                  'Billing@dazl.ai': {'action': 'forward', 'to': 'books@example.net'},
                                  'old@dazl.ai': {'action': 'reject', 'reason': 'This mailbox is closed'}})
        await self.deliver(r, rcpt='billing@dazl.ai')
        self.assertEqual([m['rcpt'] for m in self.sent], ['books@example.net'])
        self.assertEqual(r.check_rcpt('old@dazl.ai'), '550 5.1.1 This mailbox is closed')
        self.assertIsNone(r.check_rcpt('reply@dazl.ai'))

    async def test_other_domains_are_refused(self):
        r = self.receiver()
        for rcpt in ('someone@gmail.com', 'reply@dazl.ai.evil.example', 'reply@notdazl.ai', 'reply', '"reply@dazl.ai"@evil.example', ''):
            self.assertTrue((r.check_rcpt(rcpt) or '').startswith('550 5.7.1 Relaying denied'), rcpt)
            self.assertTrue((await self.deliver(r, rcpt=rcpt)).startswith('550 5.7.1'), rcpt)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.backend.requests, [])

    async def test_forward_routes_wait_with_451_until_a_destination_and_the_relay_are_configured(self):
        self.assertTrue(self.receiver(fallback_forward='').check_rcpt('hello@dazl.ai').startswith('451 '))
        self.assertTrue(self.receiver(env={'SYSTEM_MAIL_SMTP_URL': ''}).check_rcpt('hello@dazl.ai').startswith('451 '))
        self.assertIsNone(self.receiver(fallback_forward='').check_rcpt('reply@dazl.ai'))

    async def test_our_own_forward_coming_back_is_refused_as_a_loop(self):
        r = self.receiver()
        await self.deliver(r, rcpt='hello@dazl.ai')
        looped = self.sent[0]['data']
        self.sent.clear()
        self.assertTrue((await self.deliver(r, data=looped, rcpt='hello@dazl.ai')).startswith('550 5.4.6'))
        self.assertEqual(self.sent, [])

    async def test_a_failed_forward_is_451_and_replayable(self):
        r = self.receiver()
        self.send_error = OSError('relay unreachable')
        self.assertTrue((await self.deliver(r, rcpt='hello@dazl.ai')).startswith('451 '))
        self.send_error = None
        self.assertEqual(await r.replay(), {'replayed': 1, 'failed': 0, 'more': False})
        self.assertEqual([m['rcpt'] for m in self.sent], [FALLBACK])
        self.assertEqual(self.spooled(), [])

    async def test_config_rejects_unknown_keys_and_routes_outside_the_domains(self):
        for bad in ({'surprise': 1}, {'routes': {'x@gmail.com': {'action': 'forward'}}}, {'routes': {'x@dazl.ai': {'action': 'drop'}}}):
            with self.assertRaises(ValueError):
                self.config(**bad)

    async def test_the_shipped_example_config_loads(self):
        cfg = R.load_config(HERE / 'config.example.json')
        self.assertEqual(cfg['routes'], {'reply@dazl.ai': {'action': 'backend'}})
        self.assertEqual(cfg['default_route'], {'action': 'forward'})
        self.assertEqual(cfg['fallback_forward'], '')  # no inbox address is committed

    async def test_rate_limiter_windows_and_concurrency(self):
        clock = [0.0]
        lim = R.RateLimiter({'connections_per_minute': 2, 'messages_per_minute': 3, 'max_concurrent_per_ip': 1, 'max_concurrent': 2},
                            now=lambda: clock[0])
        self.assertEqual([lim.allow('msg', 'a') for _ in range(4)], [True, True, True, False])
        self.assertTrue(lim.allow('msg', 'b'))  # per IP
        clock[0] = 61
        self.assertTrue(lim.allow('msg', 'a'))
        self.assertEqual([lim.open('a'), lim.open('a'), lim.open('b'), lim.open('c')], [True, False, True, False])
        lim.close('a')
        self.assertTrue(lim.open('c'))


@unittest.skipUnless(HAVE_AIOSMTPD, 'aiosmtpd is not installed')
class OverSmtp(Base):
    """Real SMTP sessions (smtplib) against the server the service runs."""

    async def start(self, tls=None, **over):
        self.r = self.receiver(**over)
        self.port = free_port()
        server = await asyncio.get_running_loop().create_server(R.smtp_factory(self.r, tls), '127.0.0.1', self.port)
        self.addAsyncCleanup(self._stop, server)

    async def _stop(self, server):
        server.close()
        await server.wait_closed()

    async def smtp(self, fn):
        def run():
            with smtplib.SMTP('127.0.0.1', self.port, timeout=10) as s:
                return fn(s)
        return await asyncio.to_thread(run)

    async def test_end_to_end_accept_reject_and_down(self):
        await self.start()
        self.backend.answers = [(200, {'action': 'accept'}), (200, {'action': 'reject', 'reason': 'Unknown or inactive mailbox'})]
        self.assertEqual(await self.smtp(lambda s: s.sendmail('dana.whitfield@prospect.example', ['reply@dazl.ai'], REAL_REPLY)), {})
        self.assertEqual(base64.b64decode(json.loads(self.backend.requests[0]['body'])['raw']), REAL_REPLY)
        with self.assertRaises(smtplib.SMTPDataError) as e:
            await self.smtp(lambda s: s.sendmail('dana.whitfield@prospect.example', ['reply@dazl.ai'], REAL_REPLY))
        self.assertEqual((e.exception.smtp_code, e.exception.smtp_error), (550, b'5.7.1 Unknown or inactive mailbox'))
        self.backend.close()
        with self.assertRaises(smtplib.SMTPDataError) as e:
            await self.smtp(lambda s: s.sendmail('dana.whitfield@prospect.example', ['reply@dazl.ai'], REAL_REPLY))
        self.assertEqual(e.exception.smtp_code, 451)
        self.assertEqual(len(self.spooled()), 2)

    async def test_not_an_open_relay(self):
        await self.start()

        def session(s):
            s.ehlo('client.example')
            s.mail('spammer@evil.example')
            return [s.rcpt('victim@gmail.com'), s.rcpt('reply@dazl.ai.evil.example'), s.rcpt('reply@dazl.ai'), s.rcpt('hello@dazl.ai')]
        other, lookalike, ours, second = await self.smtp(session)
        self.assertEqual((other[0], lookalike[0], ours[0]), (550, 550, 250))
        self.assertIn(b'Relaying denied', other[1])
        self.assertEqual(second[0], 452)  # one recipient per message
        self.assertEqual(self.backend.requests, [])
        self.assertEqual(self.sent, [])

    async def test_a_null_sender_bounce_is_accepted_for_our_domain(self):
        await self.start()
        self.assertEqual(await self.smtp(lambda s: s.sendmail('', ['reply@dazl.ai'], REAL_REPLY)), {})
        self.assertEqual(json.loads(self.backend.requests[0]['body'])['from'], '')

    async def test_over_10_mb_is_refused(self):
        await self.start()

        def session(s):
            s.ehlo('client.example')
            return s.esmtp_features.get('size'), s.mail('a@b.example', ['SIZE=%d' % (R.MAX_BYTES + 1)])
        size, mail = await self.smtp(session)
        self.assertEqual(size, str(R.MAX_BYTES))
        self.assertEqual(mail[0], 552)
        big = b'Subject: big\r\n\r\n' + (b'x' * 998 + b'\r\n') * 10600  # 10.6 MB, sent without declaring SIZE
        with self.assertRaises(smtplib.SMTPResponseException) as e:
            def undeclared(s):
                s.helo('client.example')
                return s.sendmail('a@b.example', ['reply@dazl.ai'], big)
            await self.smtp(undeclared)
        self.assertEqual(e.exception.smtp_code, 552)
        self.assertEqual(self.backend.requests, [])

    async def test_message_rate_limit_per_ip(self):
        await self.start(rate={'connections_per_minute': 100, 'messages_per_minute': 2, 'max_concurrent_per_ip': 5, 'max_concurrent': 40})

        def session(s):
            s.ehlo('client.example')
            out = []
            for _ in range(3):
                out.append(s.mail('a@b.example')[0])
                s.rset()
            return out
        self.assertEqual(await self.smtp(session), [250, 250, 451])

    async def test_connection_rate_limit_per_ip(self):
        await self.start(rate={'connections_per_minute': 2, 'messages_per_minute': 20, 'max_concurrent_per_ip': 5, 'max_concurrent': 40})

        def greeting():
            with socket.create_connection(('127.0.0.1', self.port), timeout=5) as c:
                return c.recv(200)[:3]
        got = [await asyncio.to_thread(greeting) for _ in range(3)]
        self.assertEqual(got, [b'220', b'220', b'421'])
        self.assertEqual(sum(self.r.limiter.live.values()), 0)  # refused and closed connections are not left counted

    async def test_starttls_is_offered_only_with_a_certificate(self):
        await self.start()
        self.assertFalse(await self.smtp(lambda s: (s.ehlo('c.example'), s.has_extn('starttls'))[1]))
        self.assertIsNone(R.tls_context(self.r.cfg))

    @unittest.skipUnless(shutil.which('openssl'), 'openssl is not installed')
    async def test_starttls_with_a_certificate_delivers(self):
        crt, key = self.tmp / 'fullchain.pem', self.tmp / 'privkey.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=mail.dazl.ai',
                        '-keyout', str(key), '-out', str(crt)], check=True, capture_output=True)
        cfg = self.config(tls_cert=str(crt), tls_key=str(key))
        tls = R.tls_context(cfg)
        self.assertIsNotNone(tls)
        await self.start(tls=tls)

        def session(s):
            import ssl
            s.ehlo('c.example')
            offered = s.has_extn('starttls')
            ctx = ssl.create_default_context()
            ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE  # self-signed test certificate
            s.starttls(context=ctx)
            s.ehlo('c.example')
            return offered, s.sendmail('dana.whitfield@prospect.example', ['reply@dazl.ai'], REAL_REPLY)
        self.assertEqual(await self.smtp(session), (True, {}))
        self.assertEqual(len(self.backend.requests), 1)


class Packaging(unittest.TestCase):
    def test_the_unit_runs_unprivileged_with_only_the_bind_capability_and_no_inline_secret(self):
        unit = (HERE / 'dazl-inbound-mail.service').read_text()
        for line in ('User=dazl-mail', 'AmbientCapabilities=CAP_NET_BIND_SERVICE', 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
                     'NoNewPrivileges=true', 'EnvironmentFile=/etc/dazl-inbound-mail/env', 'ConditionPathExists=/etc/dazl-inbound-mail/enabled',
                     'MemoryMax=192M'):
            self.assertIn(line + '\n', unit)
        self.assertNotRegex(unit, r'(?m)^Environment=.*(KEY|SECRET|SMTP_URL|PASSWORD)')

    def test_the_installer_never_starts_the_receiver_or_flips_the_switch(self):
        code = '\n'.join(l for l in (HERE / 'install.sh').read_text().splitlines() if not l.lstrip().startswith(('#', 'echo')))
        self.assertNotRegex(code, r'systemctl (re)?start dazl-inbound-mail(\.service)?(\s|$)')
        self.assertNotRegex(code, r'(touch|>)\s*/etc/dazl-inbound-mail/enabled')
        self.assertNotRegex(code, r'\b(npm|pip3?|next build)\b')  # NEVER-AGAIN 1: nothing builds on the box

    def test_shell_scripts_parse(self):
        for name in ('install.sh', 'sync-cert.sh'):
            self.assertEqual(subprocess.run(['bash', '-n', str(HERE / name)], capture_output=True).returncode, 0, name)

    def test_logging_never_carries_the_key_or_a_body(self):
        import contextlib
        import io

        class T(Base):
            async def runTest(self):
                r = self.receiver()
                self.backend.answers = [(200, {'action': 'accept'}), (404, REAL_404_BODY), (503, b''), (503, b'')]
                for _ in range(3):
                    await self.deliver(r)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            result = T().run()
        self.assertTrue(result.wasSuccessful(), result.errors + result.failures)
        out = buf.getvalue()
        self.assertIn('"event": "accepted"', out)
        self.assertNotIn(KEY, out)
        self.assertNotIn('take me off your list', out)
        self.assertNotIn('u:p@relay', out)


if __name__ == '__main__':
    unittest.main()
