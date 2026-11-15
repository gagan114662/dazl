"""#1116: check-hydration.mjs (the headless-browser post-deploy check) against local pages, in a real headless Chromium.

FAILS on a form React never attached to, on a hydration error in the console, and on a page with no form; PASSES on a form that carries React
props and a submit handler. The pages are tiny stand-ins served on loopback (no network). Skipped when this machine has no headless browser
(the script exits 2 and says so); the live proof (dazl.ai and staging PASS, the bundle blocked FAILS) is in the PR.
"""
import http.server
import os
import subprocess
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'check-hydration.mjs'
HYDRATED = ("<html><body><form id=f action=/api/auth/signup method=post><input name=email></form><script>"
            "const f=document.getElementById('f');f['__reactProps$x']={onSubmit(){}};f['__reactFiber$x']={}</script></body></html>")
NOT_HYDRATED = "<html><body><form action=/api/auth/signup method=post><input name=email></form></body></html>"
HYDRATION_ERROR = HYDRATED.replace('</script>', ";console.error('Minified React error #418; visit https://react.dev/errors/418')</script>")
NO_FORM = "<html><body><p>Welcome</p></body></html>"


def serve(pages):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = pages.get(self.path.split('?')[0], NO_FORM).encode()
            self.send_response(200); self.send_header('content-type', 'text/html; charset=utf-8'); self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def run(pages, extra_env=None):
    srv = serve(pages)
    try:
        env = {k: v for k, v in os.environ.items() if k != 'HYDRATION_CHECK_BLOCK'}
        env.update(extra_env or {})
        r = subprocess.run(['node', str(SCRIPT), f'http://127.0.0.1:{srv.server_address[1]}'], capture_output=True, text=True, timeout=150, env=env)
    finally:
        srv.shutdown()
    if r.returncode == 2 and 'no headless browser' in r.stderr:
        raise unittest.SkipTest('no headless browser on this machine')
    return r


ALL = ('/sign-up', '/sign-in', '/app')


class CheckHydration(unittest.TestCase):
    def test_hydrated_forms_pass(self):
        r = run({p: HYDRATED for p in ALL})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout.count('ok   '), 3, r.stdout)

    def test_a_form_react_never_attached_to_fails(self):
        r = run({'/sign-up': NOT_HYDRATED, '/sign-in': HYDRATED, '/app': HYDRATED})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('/sign-up: the form on /sign-up has no React props: the page did not hydrate', r.stdout)

    def test_a_hydration_error_in_the_console_fails(self):
        r = run({'/sign-up': HYDRATED, '/sign-in': HYDRATION_ERROR, '/app': HYDRATED})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('hydration error in the console: Minified React error #418', r.stdout)

    def test_a_page_without_a_form_fails(self):
        r = run({'/sign-up': HYDRATED, '/sign-in': HYDRATED})   # /app serves no form
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('/app: no form on the page', r.stdout)

    def test_bad_usage_exits_2(self):
        r = subprocess.run(['node', str(SCRIPT), 'not a url'], capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 2)


if __name__ == '__main__':
    unittest.main()
