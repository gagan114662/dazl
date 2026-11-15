"""ops/prod/check-pages.py (#1116 acceptance 2) against a local stand-in server: a healthy release passes; each way the 12 Nov page broke fails."""
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / 'check-pages.py'
SIGNUP = '<html><head><link rel="stylesheet" href="/_next/static/css/app.css"><script src="/_next/static/chunks/main-abc.js?dpl=x"></script></head><body><form method="post" action="/api/auth/signup"></form></body></html>'
SIGNIN = '<html><head><script src="/_next/static/chunks/main-abc.js"></script><script src="/_next/static/chunks/signin-1.js"></script></head><body><form method="post"></form></body></html>'


def serve(pages):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split('?')[0]
            if path not in pages:
                self.send_response(404); self.end_headers(); return
            code, body = pages[path]
            self.send_response(code)
            if code in (301, 302, 307):
                self.send_header('Location', '/elsewhere')
            self.end_headers(); self.wfile.write(body.encode())

        def log_message(self, *a):
            pass
    srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def healthy():
    return {'/sign-up': (200, SIGNUP), '/sign-in': (200, SIGNIN), '/_next/static/css/app.css': (200, 'x'),
            '/_next/static/chunks/main-abc.js': (200, 'x'), '/_next/static/chunks/signin-1.js': (200, 'x')}


class CheckPages(unittest.TestCase):
    def run_on(self, pages, arg=None):
        srv = serve(pages)
        try:
            base = arg if arg is not None else f'http://127.0.0.1:{srv.server_address[1]}'
            r = subprocess.run([sys.executable, str(SCRIPT), base], capture_output=True, text=True, timeout=60)
            return r.returncode, r.stdout + r.stderr
        finally:
            srv.shutdown(); srv.server_close()

    def test_a_healthy_release_passes(self):
        code, out = self.run_on(healthy())
        self.assertEqual(code, 0, out)
        self.assertIn('the sign-up form posts to /api/auth/signup, 3 scripts and styles load', out)

    def test_a_page_naming_a_bundle_the_release_does_not_have_fails(self):
        p = healthy(); del p['/_next/static/chunks/main-abc.js']   # the 12 Nov shape: the page and its bundle disagree
        code, out = self.run_on(p)
        self.assertEqual(code, 1, out); self.assertIn('/_next/static/chunks/main-abc.js answered 404', out)

    def test_an_already_encoded_asset_path_is_not_encoded_twice(self):
        p = healthy(); p['/sign-in'] = (200, SIGNIN.replace('/_next/static/chunks/signin-1.js', '/_next/static/chunks/app/%5Bid%5D/page.js'))
        p['/_next/static/chunks/app/%5Bid%5D/page.js'] = (200, 'x')
        code, out = self.run_on(p)
        self.assertEqual(code, 0, out)

    def test_a_missing_stylesheet_fails(self):
        p = healthy(); p['/_next/static/css/app.css'] = (500, '')
        code, out = self.run_on(p)
        self.assertEqual(code, 1, out); self.assertIn('/_next/static/css/app.css answered 500', out)

    def test_a_sign_up_form_that_posts_nowhere_fails(self):
        p = healthy(); p['/sign-up'] = (200, SIGNUP.replace(' action="/api/auth/signup"', ''))
        code, out = self.run_on(p)
        self.assertEqual(code, 1, out); self.assertIn('/sign-up has no form posting to /api/auth/signup', out)

    def test_a_page_that_does_not_answer_200_fails(self):
        for path, status in (('/sign-up', 500), ('/sign-in', 404), ('/sign-up', 302)):
            p = healthy(); p[path] = (status, '')
            code, out = self.run_on(p)
            self.assertEqual(code, 1, f'{path} {status}: {out}'); self.assertIn(f'{path} answered {status}', out)

    def test_a_page_with_no_scripts_at_all_fails(self):
        p = {'/sign-up': (200, '<form action="/api/auth/signup"></form>'), '/sign-in': (200, '<form></form>')}
        code, out = self.run_on(p)
        self.assertEqual(code, 1, out); self.assertIn('reference no /_next/static scripts or styles', out)

    def test_nothing_listening_fails_and_bad_usage_is_refused(self):
        r = subprocess.run([sys.executable, str(SCRIPT), 'http://127.0.0.1:1'], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 1, r.stdout); self.assertIn('/sign-up answered', r.stdout)
        for bad in ([], ['not-a-url'], ['http://127.0.0.1:1/path'], ['a', 'b']):
            r = subprocess.run([sys.executable, str(SCRIPT), *bad], capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 2, f'{bad}: {r.stdout}{r.stderr}')


if __name__ == '__main__':
    unittest.main()
