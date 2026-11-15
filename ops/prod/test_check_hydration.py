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
NO_SUBMIT = HYDRATED.replace("{onSubmit(){}}", "{}")
LATE = ("<html><body><form id=f action=/api/auth/signup method=post><input name=email></form><script>setTimeout(()=>{"
        "const f=document.getElementById('f');f['__reactProps$x']={onSubmit(){}};f['__reactFiber$x']={}},3000)</script></body></html>")
THROWS_NOT_HYDRATED = NOT_HYDRATED.replace('</body>', "<script>throw new Error('boom')</script></body>")
THROWS_HYDRATED = HYDRATED.replace('</body>', "<script>throw new Error('third-party boom')</script></body>")
# a hydrated search form ahead of an auth form React never attached to: the auth form is the one judged
DECOY = ("<html><body><form id=s><input name=q></form><form action=/api/auth/signup method=post><input type=password name=p></form><script>"
         "const s=document.getElementById('s');s['__reactProps$x']={onSubmit(){}}</script></body></html>")
# the page's bundle: hydration happens only if /app.js loads (HYDRATION_CHECK_BLOCK=/app.js blocks it)
BUNDLED = "<html><body><form id=f action=/api/auth/signup method=post><input name=email></form><script src=/app.js></script></body></html>"
BUNDLE = "const f=document.getElementById('f');f['__reactProps$x']={onSubmit(){}};f['__reactFiber$x']={}"


def serve(pages):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split('?')[0]
            if pages.get('hang'):
                import time; time.sleep(120); return
            body = pages.get(path, NO_FORM).encode()
            ctype = 'application/javascript' if path.endswith('.js') else 'text/html; charset=utf-8'
            self.send_response(200); self.send_header('content-type', ctype); self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)

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
        srv.shutdown(); srv.server_close()
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

    def test_a_form_without_a_react_submit_handler_fails(self):
        r = run({'/sign-up': NO_SUBMIT, '/sign-in': HYDRATED, '/app': HYDRATED})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertIn('has no React submit handler', r.stdout)

    def test_a_late_hydration_still_passes(self):
        r = run({'/sign-up': LATE, '/sign-in': HYDRATED, '/app': HYDRATED})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_an_exception_fails_only_when_the_form_did_not_hydrate(self):
        r = run({'/sign-up': THROWS_NOT_HYDRATED, '/sign-in': HYDRATED, '/app': HYDRATED})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertIn('uncaught exception', r.stdout)
        r = run({'/sign-up': THROWS_HYDRATED, '/sign-in': HYDRATED, '/app': HYDRATED})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertIn('note: uncaught exception', r.stdout)

    def test_the_auth_form_is_judged_not_a_hydrated_form_before_it(self):
        r = run({'/sign-up': DECOY, '/sign-in': HYDRATED, '/app': HYDRATED})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertIn('/sign-up: the form on /sign-up has no React props', r.stdout)

    def test_the_bundle_blocked_fails_and_loaded_passes(self):
        pages = {'/sign-up': BUNDLED, '/sign-in': BUNDLED, '/app': BUNDLED, '/app.js': BUNDLE}
        self.assertEqual(run(pages).returncode, 0)
        r = run(pages, {'HYDRATION_CHECK_BLOCK': '/app.js'})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr); self.assertEqual(r.stdout.count('has no React props'), 3, r.stdout)

    def test_a_server_that_never_answers_fails_within_the_deadline(self):
        import time
        t = time.time()
        r = run({'hang': '1'}, {'HYDRATION_CHECK_DEADLINE_S': '8'})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertLess(time.time() - t, 40, 'bounded by the deadline, not hung')

    def test_bad_usage_exits_2(self):
        r = subprocess.run(['node', str(SCRIPT), 'not a url'], capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 2)


if __name__ == '__main__':
    unittest.main()
