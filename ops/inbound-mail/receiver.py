#!/usr/bin/env python3
"""dazl.ai inbound mail receiver (AWS only: replaces Cloudflare Email Routing, #1111).

A small SMTP server for the dazl box. It accepts mail for the configured domains only and does one of three things per
recipient (the routing table in config.json):

  backend  POST {from, to, raw: base64(MIME)} to the app's /internal/admin/inbound-email with x-dazl-key and
           x-dazl-forwarded, 90 s timeout, one retry after a network error or a 5xx (never after a timeout or a 4xx),
           then do what the app answers: accept / reject / forward (to the configured fallback only) / reply.
           This is the contract of the Cloudflare Worker it replaces (dazl-frontdesk, forwardInboundEmail).
  forward  wrap the mail and send it to a human inbox through the outbound relay (Resend SMTP).
  reject   550.

Outbound port 25 is blocked on EC2, so every forward and reply leaves through SYSTEM_MAIL_SMTP_URL with a From on
SYSTEM_MAIL_FROM's verified domain. Mail the app could not take is spooled (30 days) and the sender gets a 451, so its
server retries. Secrets come from the environment (a root-only EnvironmentFile); nothing here logs them or a mail body.

Run: receiver.py serve | receiver.py replay | receiver.py check-config     (config: $DAZL_INBOUND_CONFIG)
"""
import asyncio
import base64
import collections
import email
import email.policy
import email.utils
import hashlib
import json
import os
import re
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from pathlib import Path

MAX_BYTES = 10 * 1024 * 1024
BACKEND_TIMEOUT_S = 90.0
BACKEND_RETRY_S = 1.0
REJECT_REASON_CHARS = 300
POLITE_REJECT = ('This address only accepts replies to emails sent through dazl. Please reply to the original email, '
                 'or write to the business directly.')
LOOP_HEADER = 'X-Dazl-Inbound-Forwarded'
EXCERPT_PARSE_BYTES = 128 * 1024
SMTP_LINE_LIMIT = 256 * 1024
DEFAULT_CONFIG = '/etc/dazl-inbound-mail/config.json'

DEFAULTS = {
    'listen_host': '0.0.0.0',
    'listen_port': 25,
    'hostname': 'mail.dazl.ai',
    'domains': ['dazl.ai'],
    'backend_url': 'http://127.0.0.1:3104/internal/admin/inbound-email',
    'fallback_forward': '',
    'routes': {'reply@dazl.ai': {'action': 'backend'}},
    'default_route': {'action': 'forward'},
    'never_reply_to': [],
    'reply_from_mode': 'rewrite',
    'spool_dir': '/var/spool/dazl-inbound',
    'spool_days': 30,
    'spool_max_mb': 1024,
    'tls_cert': '/etc/dazl-inbound-mail/tls/fullchain.pem',
    'tls_key': '/etc/dazl-inbound-mail/tls/privkey.pem',
    'rate': {'connections_per_minute': 30, 'messages_per_minute': 20, 'max_concurrent_per_ip': 5, 'max_concurrent': 40},
    'max_parallel_deliveries': 2,
}


def load_config(path):
    cfg = json.loads(json.dumps(DEFAULTS))
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict):
        raise ValueError('config must be a JSON object')
    for k, v in data.items():
        if k.startswith('_'):
            continue
        if k not in DEFAULTS:
            raise ValueError(f'unknown config key: {k}')
        if k == 'rate':
            cfg['rate'].update(v)
        else:
            cfg[k] = v
    cfg['domains'] = [d.lower() for d in cfg['domains']]
    cfg['routes'] = {mailbox(k): v for k, v in cfg['routes'].items()}
    for name, route in list(cfg['routes'].items()) + [('default_route', cfg['default_route'])]:
        if route.get('action') not in ('backend', 'forward', 'reject'):
            raise ValueError(f'route {name}: action must be backend, forward or reject')
        if '@' in name and name.rsplit('@', 1)[1] not in cfg['domains']:
            raise ValueError(f'route {name}: not in an accepted domain')
    if not cfg['domains']:
        raise ValueError('domains is empty')
    if cfg['reply_from_mode'] not in ('rewrite', 'as_is'):
        raise ValueError('reply_from_mode must be rewrite or as_is')
    return cfg


def mailbox(addr):
    """The bare lower-cased address of 'Name <a@b>' or 'a@b' ('' when there is none)."""
    return email.utils.parseaddr(str(addr or ''))[1].strip().lower()


def inbound_key(mail_from, rcpt, data):
    """One delivery = envelope from + envelope to + the raw bytes: the Worker's inboundKey, the app's idempotency key."""
    return hashlib.sha256(f'{mail_from.lower()}\n{rcpt.lower()}\n'.encode('utf-8', 'surrogateescape') + data).hexdigest()


def log(event, **fields):
    """One JSON line per event on stdout (journald). Callers pass addresses, reasons and keys: never a secret or a body."""
    print(json.dumps({'event': event, **fields}, default=str), flush=True)


def smtp_text(s, limit=REJECT_REASON_CHARS):
    """A string that is safe as one SMTP reply line: no control characters, ASCII, capped."""
    s = re.sub(r'[\x00-\x1f\x7f\s]+', ' ', str(s)).strip()
    return s.encode('ascii', 'replace').decode()[:limit].strip()


# ---------------------------------------------------------------- the app's answer

def parse_action(obj):
    """The Worker's ForwardAction schema. None = not a valid answer (bad_response)."""
    if not isinstance(obj, dict):
        return None
    a = obj.get('action')
    short = lambda v: isinstance(v, str) and len(v) <= 320  # noqa: E731
    if a == 'accept':
        return {'action': 'accept'}
    if a == 'forward' and short(obj.get('to')):
        return {'action': 'forward', 'to': obj['to']}
    if a == 'reject' and isinstance(obj.get('reason'), str) and len(obj['reason']) <= 2000:
        return {'action': 'reject', 'reason': obj['reason']}
    if a == 'reply' and short(obj.get('from')) and short(obj.get('to')) and isinstance(obj.get('raw'), str) \
            and len(obj['raw']) <= MAX_BYTES * 2:
        return {'action': 'reply', 'from': obj['from'], 'to': obj['to'], 'raw': obj['raw']}
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # the Worker's redirect: 'manual': a 3xx is an http failure, never followed
        return None


def http_post(url, headers, body, timeout):
    """(status, body bytes). Raises TimeoutError on a timeout and OSError on any other network failure."""
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    opener = urllib.request.build_opener(_NoRedirect, urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as res:
            return res.status, res.read(MAX_BYTES * 3)
    except urllib.error.HTTPError as e:
        e.close()
        return e.code, b''
    except urllib.error.URLError as e:
        if isinstance(e.reason, TimeoutError):
            raise TimeoutError(str(e.reason)) from None
        raise OSError(str(e.reason)) from None


def smtp_send(url, env_from, rcpt, data):
    """Send one message through the outbound relay (smtps://user:pass@host:465 or smtp://...:587 with STARTTLS)."""
    u = urllib.parse.urlsplit(url)
    user, password = urllib.parse.unquote(u.username or ''), urllib.parse.unquote(u.password or '')
    ctx = ssl.create_default_context()
    if u.scheme == 'smtps' or u.port == 465:
        s = smtplib.SMTP_SSL(u.hostname, u.port or 465, timeout=30, context=ctx)
    else:
        s = smtplib.SMTP(u.hostname, u.port or 587, timeout=30)
        s.starttls(context=ctx)
    try:
        if user:
            s.login(user, password)
        s.sendmail(env_from, [rcpt], data)
    finally:
        try:
            s.quit()
        except Exception:
            pass


# ---------------------------------------------------------------- messages we send

def _header_block(data):
    m = re.search(rb'\r?\n\r?\n', data)
    return (data[:m.start()], data[m.start():]) if m else (data, b'')


def header_value(data, name):
    try:
        msg = email.message_from_bytes(_header_block(data[:65536])[0] + b'\r\n\r\n', policy=email.policy.default)
        return str(msg.get(name, '') or '')
    except Exception:
        return ''


def text_excerpt(data, limit=20000):
    """The readable text of a message, from a bounded prefix: a message built to be slow to parse costs little."""
    try:
        msg = email.message_from_bytes(data[:EXCERPT_PARSE_BYTES], policy=email.policy.default)
        part = msg.get_body(preferencelist=('plain', 'html'))
        return (part.get_content() if part else '')[:limit]
    except Exception:
        return ''


def wrap_forward(data, mail_from, rcpt, dest, system_from, peer, note=''):
    """The original mail wrapped for a human inbox: sent From our verified domain (the relay refuses anything else),
    Reply-To the real sender, readable text on top and the untouched original attached as original.eml."""
    subject = header_value(data, 'Subject') or '(no subject)'
    sender = mailbox(header_value(data, 'From')) or mailbox(mail_from)
    m = EmailMessage()
    m['From'] = system_from
    m['To'] = dest
    if sender and not re.search(r'[\r\n]', sender):
        m['Reply-To'] = sender
    m['Subject'] = re.sub(r'[\x00-\x1f\x7f]+', ' ', 'Fwd: ' + subject).strip()[:240]  # EmailMessage encodes non-ASCII
    m['Date'] = email.utils.formatdate(localtime=False)
    m['Message-ID'] = email.utils.make_msgid(domain=mailbox(system_from).rsplit('@', 1)[-1] or 'localhost')
    m[LOOP_HEADER] = '1'
    m['X-Dazl-Original-To'] = smtp_text(rcpt, 320)
    m['X-Dazl-Original-From'] = smtp_text(mail_from or '<>', 320)
    m['Auto-Submitted'] = 'auto-forwarded'
    lines = [f'Mail for {rcpt} from {mail_from or "<>"} (sending server {peer}), forwarded by the dazl.ai mail receiver.']
    if note:
        lines.append(note)
    lines += ['Reply goes to the sender. The original message is attached (original.eml).', '', '-' * 60,
              text_excerpt(data) or '(no readable text part)']
    m.set_content('\n'.join(lines))
    m.add_attachment(data, maintype='application', subtype='octet-stream', filename='original.eml')
    return m.as_bytes(policy=email.policy.SMTP)


def crlf(raw):
    """Every line ending as CRLF (SMTP requires it; smtplib does not fix bytes)."""
    return re.sub(rb'\r\n|\r|\n', b'\r\n', raw)


def rewrite_reply_from(raw, system_from, reply_from):
    """The app's reply with its From moved onto our verified sending domain (the relay refuses a From on dazl.ai) and
    the mailbox the customer wrote to kept as Reply-To. Only the header block changes (and line endings become CRLF)."""
    head, rest = _header_block(crlf(raw))
    eol = b'\r\n'
    out, skipping, has_reply_to = [], False, False
    for line in head.split(eol):
        if line[:1] in (b' ', b'\t'):
            if not skipping:
                out.append(line)
            continue
        name = line.split(b':', 1)[0].strip().lower()
        skipping = name in (b'from', b'sender', b'return-path')
        has_reply_to = has_reply_to or name == b'reply-to'
        if not skipping:
            out.append(line)
    display = (email.utils.parseaddr(header_value(raw, 'From'))[0] or email.utils.parseaddr(reply_from)[0]
               or email.utils.parseaddr(system_from)[0] or 'dazl')
    out.insert(0, f'From: {email.utils.formataddr((display, mailbox(system_from)))}'.encode())
    if not has_reply_to:
        out.insert(1, f'Reply-To: {mailbox(reply_from)}'.encode())
    return eol.join(out) + rest


LOCAL_LINK = re.compile(r'https?://(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])', re.I)


# ---------------------------------------------------------------- the receiver

class RateLimiter:
    """Sliding one-minute windows per sending IP, plus live connection counts."""

    def __init__(self, rate, now=time.monotonic):
        self.rate, self.now = rate, now
        self.hits = {'conn': collections.defaultdict(collections.deque), 'msg': collections.defaultdict(collections.deque)}
        self.live = collections.Counter()

    def allow(self, kind, ip):
        limit = self.rate['connections_per_minute' if kind == 'conn' else 'messages_per_minute']
        table, t = self.hits[kind], self.now()
        if len(table) > 20000:  # a flood of distinct IPs must not grow this without bound
            for k in [k for k, q in table.items() if not q or t - q[-1] > 60]:
                del table[k]
        q = table[ip]
        while q and t - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(t)
        return True

    def open(self, ip):
        if self.live[ip] >= self.rate['max_concurrent_per_ip'] or sum(self.live.values()) >= self.rate['max_concurrent']:
            return False
        self.live[ip] += 1
        return True

    def close(self, ip):
        self.live[ip] -= 1
        if self.live[ip] <= 0:
            del self.live[ip]


class Receiver:
    def __init__(self, cfg, env=None, post=http_post, send=None, sleep=asyncio.sleep,
                 timeout=BACKEND_TIMEOUT_S, retry_delay=BACKEND_RETRY_S, now=time.time):
        env = os.environ if env is None else env
        self.cfg = cfg
        self.key = (env.get('INBOUND_BACKEND_KEY') or '').strip()
        self.smtp_url = (env.get('SYSTEM_MAIL_SMTP_URL') or '').strip()
        self.system_from = (env.get('SYSTEM_MAIL_FROM') or '').strip()
        self.post, self.sleep, self.timeout, self.retry_delay, self.now = post, sleep, timeout, retry_delay, now
        self.send = send or (lambda env_from, rcpt, data: smtp_send(self.smtp_url, env_from, rcpt, data))
        self.fallback = mailbox(cfg['fallback_forward'])
        self.spool = Path(cfg['spool_dir'])
        self.limiter = RateLimiter(cfg['rate'])
        self.gate = asyncio.Semaphore(cfg['max_parallel_deliveries'])

    # ---- routing

    def route_for(self, rcpt):
        box = mailbox(rcpt)
        if '@' not in box or box.rsplit('@', 1)[1] not in self.cfg['domains']:
            return None
        return self.cfg['routes'].get(box, self.cfg['default_route'])

    def forward_dest(self, route):
        return mailbox(route.get('to') or '') or self.fallback

    def check_rcpt(self, rcpt):
        """The RCPT answer: None = accepted, else the SMTP reply."""
        route = self.route_for(rcpt)
        if route is None:
            return '550 5.7.1 Relaying denied: this server only accepts mail for ' + ', '.join(self.cfg['domains'])
        if route['action'] == 'reject':
            return '550 5.1.1 ' + (smtp_text(route.get('reason', '')) or 'No such mailbox')
        if route['action'] == 'forward' and not (self.forward_dest(route) and self.outbound_ready()):
            return '451 4.3.0 Mailbox temporarily unavailable'  # not configured yet: the sender keeps the mail
        return None

    def outbound_ready(self):
        return bool(self.smtp_url and self.system_from)

    # ---- spool

    def spool_put(self, key, mail_from, rcpt, data, reason, route):
        try:
            self.spool.mkdir(parents=True, exist_ok=True, mode=0o700)
            used = sum(p.stat().st_size for p in self.spool.iterdir() if p.is_file())
            if used + len(data) > self.cfg['spool_max_mb'] * 1024 * 1024:  # a flood must not fill the box's disk
                log('spool_full', key=key, used_mb=used // (1024 * 1024))
                return False
            for name, content in ((f'{key}.eml', data), (f'{key}.json', json.dumps(
                    {'from': mail_from, 'to': rcpt, 'reason': reason, 'route': route, 'at': int(self.now())}).encode())):
                tmp = self.spool / f'.{name}.tmp'
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'wb') as f:
                    f.write(content)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.spool / name)
            return True
        except OSError as e:
            log('spool_failed', key=key, error=type(e).__name__)
            return False

    def spool_mark_handed(self, key):
        """Note on a spooled mail that the human fallback already has it (a replay then never sends it again)."""
        meta = self.spool / f'{key}.json'
        try:
            data = json.loads(meta.read_text())
            data['handed'] = 'fallback'
            tmp = self.spool / f'.{key}.json.tmp'
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump(data, f)
            os.replace(tmp, meta)
        except (OSError, ValueError):
            pass

    def spool_clean(self):
        cutoff, removed = self.now() - self.cfg['spool_days'] * 86400, 0
        if not self.spool.is_dir():
            return 0
        for p in self.spool.iterdir():
            try:
                if p.is_file() and p.stat().st_mtime < cutoff:
                    p.unlink()
                    removed += 1
            except OSError:
                pass
        if removed:
            log('spool_cleaned', removed=removed)
        return removed

    # ---- the app

    async def post_backend(self, mail_from, rcpt, data):
        """('ok', action) or (reason, extra) with reason http | bad_response | timeout | network | no_key. One retry after a
        network error or a 5xx; never after a timeout (the app may still be working on that mail) or a 4xx."""
        if not self.key:
            return 'no_key', {}  # not configured to talk to the app: handled like a 4xx (the human fallback)
        body = json.dumps({'from': mail_from, 'to': rcpt, 'raw': base64.b64encode(data).decode()}).encode()
        headers = {'content-type': 'application/json', 'x-dazl-key': self.key, 'x-dazl-forwarded': '1'}
        last = ('network', {})
        for attempt in range(2):
            if attempt:
                await self.sleep(self.retry_delay)
            try:
                status, answer = await asyncio.wait_for(
                    asyncio.to_thread(self.post, self.cfg['backend_url'], headers, body, self.timeout), self.timeout)
            except (TimeoutError, asyncio.TimeoutError):
                return 'timeout', {}
            except Exception as e:  # connection refused, reset, DNS...
                last = ('network', {'error': type(e).__name__})
                continue
            if not 200 <= status < 300:
                last = ('http', {'status': status})
                if status >= 500:
                    continue
                return last
            try:
                act = parse_action(json.loads(answer))
            except ValueError:
                act = None
            return ('ok', act) if act else ('bad_response', {})
        return last

    # ---- outbound

    async def forward(self, data, mail_from, rcpt, dest, peer, note=''):
        def work():  # parsing and sending both off the event loop: one slow message must not stall the others
            self.send(mailbox(self.system_from), dest, wrap_forward(data, mail_from, rcpt, dest, self.system_from, peer, note))
        await asyncio.to_thread(work)

    async def to_fallback(self, data, mail_from, rcpt, peer, key, why, otherwise):
        """Hand the mail to the human fallback; `otherwise` is the SMTP reply when no fallback is configured."""
        if not self.fallback:
            return otherwise
        try:
            if not self.outbound_ready():
                raise RuntimeError('outbound relay is not configured')
            await self.forward(data, mail_from, rcpt, self.fallback, peer, f'Why you are getting this: {why}.')
        except Exception as e:
            self.spool_put(key, mail_from, rcpt, data, 'fallback_send_failed', 'backend')
            log('forward_failed', to=rcpt, key=key, error=type(e).__name__)
            return '451 4.3.0 Temporary failure, please retry'
        self.spool_mark_handed(key)
        log('forwarded', to=rcpt, dest='fallback', key=key, why=why)
        return '250 2.0.0 Accepted'

    # ---- one delivery

    async def deliver(self, peer, mail_from, rcpt, data):
        """Handle one message for one recipient; returns the SMTP reply to DATA."""
        key = 'unkeyed-%d' % time.monotonic_ns()
        try:
            key = inbound_key(mail_from, rcpt, data)
            async with self.gate:
                return await self._deliver(peer, mail_from, rcpt, data, key)
        except Exception as e:  # a bug must never bounce or lose mail
            self.spool_put(key, mail_from, rcpt, data, 'internal_error', 'unknown')
            log('internal_error', to=rcpt, key=key, error=type(e).__name__)
            return '451 4.3.0 Temporary failure, please retry'

    async def _deliver(self, peer, mail_from, rcpt, data, key):
        route = self.route_for(rcpt)
        if route is None:
            return '550 5.7.1 Relaying denied'
        if len(data) > MAX_BYTES:
            return '552 5.3.4 Message too large (over 10 MB). Please send a shorter email.'
        if header_value(data, LOOP_HEADER):
            log('loop_refused', to=rcpt, key=key)
            return '550 5.4.6 Mail loop: this message was already forwarded by this server'
        if route['action'] == 'reject':
            return '550 5.1.1 ' + (smtp_text(route.get('reason', '')) or 'No such mailbox')

        if route['action'] == 'forward':
            dest = self.forward_dest(route)
            if not (dest and self.outbound_ready()):
                return '451 4.3.0 Mailbox temporarily unavailable'
            try:
                await self.forward(data, mail_from, rcpt, dest, peer)
            except Exception as e:
                self.spool_put(key, mail_from, rcpt, data, 'forward_send_failed', 'forward')
                log('forward_failed', to=rcpt, key=key, error=type(e).__name__)
                return '451 4.3.0 Temporary failure, please retry'
            log('forwarded', to=rcpt, dest='route' if route.get('to') else 'fallback', key=key)
            return '250 2.0.0 Accepted'

        result, detail = await self.post_backend(mail_from, rcpt, data)
        if result != 'ok':
            # The app's outcome is unknown or it could not be reached: keep the raw mail for replay, never reject.
            spooled = self.spool_put(key, mail_from, rcpt, data, result, 'backend')
            log('backend_failed', to=rcpt, key=key, reason=result, spooled=spooled, **detail)
            if result in ('http', 'bad_response', 'no_key') and int(detail.get('status', 0)) < 500:
                # The app answered, and the same answer would come back on a retry (a 4xx, or not our contract): a
                # human gets the mail, as the Worker did. With no fallback the sender keeps it (451).
                return await self.to_fallback(data, mail_from, rcpt, peer, key, f'the app did not take it ({result})',
                                              '451 4.3.0 Temporary failure, please retry')
            return '451 4.3.0 Temporary failure, please retry'  # down, 5xx or timeout: the sender's server retries

        act = detail
        if act['action'] == 'accept':
            log('accepted', to=rcpt, key=key)
            return '250 2.0.0 Accepted'
        if act['action'] == 'reject':
            log('rejected', to=rcpt, key=key)
            return '550 5.7.1 ' + (smtp_text(act['reason']) or POLITE_REJECT)
        if act['action'] == 'forward':
            # Only ever our own configured fallback: an app that names another address must not be able to redirect mail.
            if not self.fallback or mailbox(act['to']) != self.fallback or re.search(r'[\r\n,;]', act['to']):
                log('backend_refused', to=rcpt, key=key, reason='unexpected_forward_to')
                return await self.to_fallback(data, mail_from, rcpt, peer, key, 'the app named an unexpected forward address',
                                              '550 5.7.1 ' + POLITE_REJECT)
            return await self.to_fallback(data, mail_from, rcpt, peer, key, 'it matched no outreach',
                                          '451 4.3.0 Temporary failure, please retry')

        # reply: the front desk's answer, composed by the app. Checked again here: from = the mailbox the mail was sent
        # to, to = its sender (envelope or From header), one recipient, never our own inboxes, no local link.
        senders = {mailbox(mail_from), mailbox(header_value(data, 'From'))} - {''}
        never = {mailbox(a) for a in self.cfg['never_reply_to']} | {self.fallback} - {''}
        to = mailbox(act['to'])
        problem = ('reply_from' if mailbox(act['from']) != mailbox(rcpt) or re.search(r'[\r\n]', act['from']) else
                   'reply_to' if to not in senders or re.search(r'[\r\n,;]', act['to']) else
                   'own_inbox' if to in never else
                   'bad_raw' if not re.search(r'\r?\n\r?\n', act['raw']) else
                   'local_link' if LOCAL_LINK.search(act['raw']) else
                   'no_outbound' if not self.outbound_ready() else None)
        if problem:
            log('backend_refused', to=rcpt, key=key, reason='bad_reply', problem=problem)
            return await self.to_fallback(data, mail_from, rcpt, peer, key, f'the app\'s reply was not sent ({problem})',
                                          '250 2.0.0 Accepted')
        raw = crlf(act['raw'].encode('utf-8', 'replace'))
        try:
            if self.cfg['reply_from_mode'] == 'rewrite':
                await asyncio.to_thread(self.send, mailbox(self.system_from), to,
                                        rewrite_reply_from(raw, self.system_from, act['from']))
            else:
                await asyncio.to_thread(self.send, mailbox(act['from']), to, raw)
            log('replied', to=rcpt, key=key)
        except Exception as e:  # the app has the conversation; a human gets the mail so the customer is not left unanswered
            log('reply_failed', to=rcpt, key=key, error=type(e).__name__)
            return await self.to_fallback(data, mail_from, rcpt, peer, key, 'the app\'s reply could not be sent',
                                          '250 2.0.0 Accepted')
        return '250 2.0.0 Accepted'

    # ---- replay (after an outage)

    async def replay(self, limit=50):
        """Re-deliver spooled mail, oldest first. App mail is posted again: the app is idempotent, so mail it already
        handled gets its stored answer. The SMTP session is gone, so a reject cannot be performed; when the app answers
        forward or reply and no human has had the mail yet, it goes to the fallback, so nothing ends up unread. A mail
        leaves the spool only after that worked."""
        replayed = failed = down = 0
        more = False
        metas = sorted(self.spool.glob('*.json'), key=lambda p: p.stat().st_mtime) if self.spool.is_dir() else []
        for meta_path in metas:
            if replayed >= limit or down >= 3:  # 3 in a row unreachable: the app is still down, stop here
                more = True
                break
            eml, key = meta_path.with_suffix('.eml'), meta_path.stem
            try:
                meta, data = json.loads(meta_path.read_text()), eml.read_bytes()
            except (OSError, ValueError):
                meta, data = None, b''
            mail_from, rcpt = (meta.get('from'), meta.get('to')) if isinstance(meta, dict) else (None, None)
            route = self.route_for(rcpt) if isinstance(mail_from, str) and isinstance(rcpt, str) else None
            if route is None or route['action'] == 'reject':
                failed += 1
                log('replay_skipped', key=key, reason='unreadable or no longer routed')
                continue
            ok, extra = False, {}
            try:
                if route['action'] == 'forward':
                    dest = self.forward_dest(route)
                    if not (dest and self.outbound_ready()):
                        raise RuntimeError('no forward destination')
                    await self.forward(data, mail_from, rcpt, dest, 'replay')
                    ok, extra = True, {'action': 'forward'}
                else:
                    result, detail = await self.post_backend(mail_from, rcpt, data)
                    if result != 'ok':
                        down = down + 1 if result in ('network', 'timeout') else 0
                        extra = {'reason': result, **detail}
                    else:
                        down, extra = 0, {'action': detail['action']}
                        if detail['action'] in ('forward', 'reply') and meta.get('handed') != 'fallback' and self.fallback:
                            why = 'the app wanted it forwarded' if detail['action'] == 'forward' else \
                                'the app answered it, but that reply could not be sent after the outage'
                            if not self.outbound_ready():
                                raise RuntimeError('outbound relay is not configured')
                            await self.forward(data, mail_from, rcpt, self.fallback, 'replay', f'Why you are getting this: {why}.')
                            extra['handed'] = 'fallback'
                        if detail['action'] in ('reject', 'reply'):
                            extra['not_performed'] = True
                        ok = True
            except Exception as e:
                extra = {**extra, 'error': type(e).__name__}
            if ok:
                eml.unlink(missing_ok=True)
                meta_path.unlink(missing_ok=True)
                replayed += 1
            else:
                failed += 1
            log('replayed' if ok else 'replay_failed', to=rcpt, key=key, **extra)
        return {'replayed': replayed, 'failed': failed, 'more': more}


# ---------------------------------------------------------------- SMTP

def tls_context(cfg):
    """STARTTLS with the certificate Caddy keeps for the mail host, when the files are readable; else None (plain)."""
    cert, key = Path(cfg['tls_cert']), Path(cfg['tls_key'])
    try:
        if not (cert.is_file() and key.is_file()):
            return None
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        return ctx
    except (OSError, ssl.SSLError) as e:
        log('tls_unavailable', error=type(e).__name__)
        return None


def smtp_factory(receiver, tls=None):
    """A protocol factory for loop.create_server. aiosmtpd is imported here so the delivery logic has no dependency."""
    from aiosmtpd.smtp import SMTP

    cfg = receiver.cfg

    class Handler:
        async def handle_MAIL(self, server, session, envelope, address, options):
            if not receiver.limiter.allow('msg', session.peer[0]):
                log('rate_limited', ip=session.peer[0], kind='messages')
                return '451 4.7.1 Too many messages from your server, slow down and retry later'
            envelope.mail_from, envelope.mail_options = address, options
            return '250 OK'

        async def handle_RCPT(self, server, session, envelope, address, options):
            refusal = receiver.check_rcpt(address)
            if refusal:
                return refusal
            if envelope.rcpt_tos:
                # One recipient per message: each gets its own answer from the app, which one DATA reply cannot carry.
                return '452 4.5.3 One recipient per message, send the others separately'
            envelope.rcpt_tos.append(address)
            return '250 OK'

        async def handle_DATA(self, server, session, envelope):
            sender = '' if envelope.mail_from in (None, '<>') else envelope.mail_from  # a bounce has no sender
            return await receiver.deliver(session.peer[0], sender, envelope.rcpt_tos[0],
                                          envelope.original_content or b'')

    class LimitedSMTP(SMTP):
        # Real mail has lines far over RFC 5321's 1000 bytes; aiosmtpd's default would bounce them with a 500.
        line_length_limit = SMTP_LINE_LIMIT

        def connection_made(self, transport):
            if getattr(self, '_dazl_counted', False):
                # aiosmtpd calls this a second time after a STARTTLS handshake: same connection, already counted.
                return super().connection_made(transport)
            peer = transport.get_extra_info('peername') or ('?',)
            self._dazl_ip, self._dazl_counted = peer[0], False
            if not receiver.limiter.allow('conn', peer[0]) or not receiver.limiter.open(peer[0]):
                log('rate_limited', ip=peer[0], kind='connections')
                self._dazl_refused = True
                transport.write(b'421 4.7.0 Too many connections from your server, retry later\r\n')
                transport.close()
                return
            self._dazl_refused, self._dazl_counted = False, True
            super().connection_made(transport)

        def connection_lost(self, error):
            if self._dazl_counted:
                receiver.limiter.close(self._dazl_ip)
                self._dazl_counted = False
            if not self._dazl_refused:
                super().connection_lost(error)

        def data_received(self, data):
            if not self._dazl_refused:
                super().data_received(data)

        def eof_received(self):
            return False if self._dazl_refused else super().eof_received()

    def factory():
        # timeout: above the slowest delivery (two 90 s attempts + the retry pause), so a slow app turn is not cut off
        return LimitedSMTP(Handler(), hostname=cfg['hostname'], ident='dazl inbound mail', data_size_limit=MAX_BYTES,
                           enable_SMTPUTF8=True, decode_data=False, tls_context=tls, require_starttls=False,
                           timeout=300)

    return factory


async def serve(cfg):
    receiver = Receiver(cfg)
    tls = tls_context(cfg)
    loop = asyncio.get_running_loop()
    server = await loop.create_server(smtp_factory(receiver, tls), cfg['listen_host'], cfg['listen_port'])
    log('listening', host=cfg['listen_host'], port=cfg['listen_port'], starttls=bool(tls), domains=cfg['domains'],
        backend_key_set=bool(receiver.key), outbound_ready=receiver.outbound_ready(), fallback_set=bool(receiver.fallback))

    async def janitor():
        while True:
            receiver.spool_clean()
            await asyncio.sleep(3600)

    task = asyncio.create_task(janitor())
    try:
        async with server:
            await server.serve_forever()
    finally:
        task.cancel()


def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'serve'
    cfg = load_config(os.environ.get('DAZL_INBOUND_CONFIG', DEFAULT_CONFIG))
    if cmd == 'check-config':
        r = Receiver(cfg)
        print(json.dumps({'ok': True, 'domains': cfg['domains'], 'routes': sorted(cfg['routes']),
                          'default_route': cfg['default_route']['action'], 'fallback_set': bool(r.fallback),
                          'backend_key_set': bool(r.key), 'outbound_ready': r.outbound_ready(),
                          'starttls': tls_context(cfg) is not None}))
        return 0
    if cmd == 'replay':
        print(json.dumps(asyncio.run(Receiver(cfg).replay())))
        return 0
    if cmd == 'serve':
        try:
            asyncio.run(serve(cfg))
        except KeyboardInterrupt:
            pass
        return 0
    print(__doc__.strip().splitlines()[-1], file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
