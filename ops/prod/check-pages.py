#!/usr/bin/env python3
"""#1116 acceptance 2: after a deploy, can a stranger use the sign-up page? Run by deploy-prod.sh on the new release (local smoke, step 7) and
on dazl.ai after the switch (public smoke, step 9, which rolls back on failure).

The 12 Nov failure: prod served a /sign-up page that did not match its own script bundle, so the page never hydrated and the form silently
reloaded. A curl-only check (the box has no browser) catches both halves of that:
  1. /sign-up and /sign-in answer 200, and /sign-up's form posts to /api/auth/signup (since #1218 the form works even unhydrated);
  2. every script and stylesheet those pages reference under /_next/static/ loads (200) from the SAME base, so a page that names a bundle
     the release does not have fails here.
It does not prove React attached its handler: the release gate checks that in a real browser before any deploy.
usage: check-pages.py <base-url>   (exit 0 = ok; 1 = a check failed, the reason printed; 2 = bad usage). Python standard library only.
"""
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 10
MAX_ASSETS = 80
DEADLINE_S = 60   # the whole check, so a hanging asset server cannot hold a deploy for 80 x 10 s
PAGES = ('/sign-up', '/sign-in')
FORM_ACTION = re.compile(r'<form\b[^>]*\baction="/api/auth/signup"', re.I)
ASSET = re.compile(r'''(?:src|href)=["'](/_next/static/[^"'?#]+\.(?:js|css))(?:\?[^"'#]*)?["']''', re.I)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):   # a redirect is an answer to report, not a page to follow
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'dazl-deploy-check/1', 'Accept': 'text/html,*/*'})
    try:
        with OPENER.open(req, timeout=TIMEOUT) as r:
            return r.status, r.read(2_000_000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, ''
    except Exception as e:  # noqa: BLE001 - any failure to answer is a failed check, with its class named
        return 0, type(e).__name__


def check(base):
    base = base.rstrip('/')
    problems, assets = [], []
    t0 = time.monotonic()
    for path in PAGES:
        code, body = get(base + path)
        if code != 200:
            problems.append(f'{path} answered {code or body}')
            continue
        if path == '/sign-up' and not FORM_ACTION.search(body):
            problems.append('/sign-up has no form posting to /api/auth/signup')
        for a in ASSET.findall(body):
            if a not in assets:
                assets.append(a)
    if not problems and not assets:
        problems.append('the pages reference no /_next/static scripts or styles')
    for a in assets[:MAX_ASSETS]:
        if time.monotonic() - t0 > DEADLINE_S:
            problems.append(f'the check ran over {DEADLINE_S} s'); break
        code, body = get(base + urllib.parse.quote(a, safe='/%'))   # a reference already percent-encoded (a [id] route) is not encoded twice
        if code != 200:
            problems.append(f'{a} answered {code or body}')
    return problems, len(assets)


def main(argv):
    if len(argv) != 2 or not re.match(r'^https?://[^/\s]+$', argv[1].rstrip('/')):
        print('usage: check-pages.py <base-url>', file=sys.stderr)
        return 2
    problems, n = check(argv[1])
    if problems:
        print(f'pages check FAILED on {argv[1]}: ' + '; '.join(problems[:5]) + (f' (+{len(problems) - 5} more)' if len(problems) > 5 else ''))
        return 1
    print(f'pages check ok on {argv[1]}: {", ".join(PAGES)} 200, the sign-up form posts to /api/auth/signup, {n} scripts and styles load')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
