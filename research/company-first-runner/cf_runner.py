#!/usr/bin/env python3
"""Company-first lead finder prototype (Quest). Generic: all targeting comes from the brief JSON.
Stages: discover (Claude web_search, parallel angles) -> website proof -> signal proof (ATS API / JSON-LD date)
-> buyer (Claude web_search) + corroboration on fetched pages -> published email. Strict holds; only ready leads shown.
Usage: cf_runner.py brief.json out.json
"""
import json, re, sys, os, time, datetime as dt, concurrent.futures as cf, html
from urllib.parse import urlparse, urljoin
import requests

KEY = open('/tmp/quest/agent/.anthropic_key').read().strip()
MODEL = os.environ.get('CF_MODEL', 'claude-sonnet-4-5')
PRICE_IN, PRICE_OUT, PRICE_SEARCH = 3e-6, 15e-6, 0.01
BUYER_MODEL = os.environ.get('CF_BUYER_MODEL', 'claude-haiku-4-5')
PRICES = {'claude-haiku-4-5': (1e-6, 5e-6)}
BUDGET = float(os.environ.get('CF_BUDGET', '5'))
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9'}
spent = {'usd': 0.0, 'searches': 0, 'calls': 0}
LOG = []

def log(*a):
    s = ' '.join(str(x) for x in a); LOG.append(s); print(s, file=sys.stderr, flush=True)

def claude(prompt, max_uses=5, max_tokens=4000, system=None, model=None):
    if spent['usd'] > BUDGET - 0.4:
        raise RuntimeError('budget_stop')
    body = {'model': model or MODEL, 'max_tokens': max_tokens, 'messages': [{'role': 'user', 'content': prompt}],
            'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': max_uses}]}
    if system: body['system'] = system
    msgs = body['messages']
    text = ''
    for _ in range(4):  # handle pause_turn
        r = requests.post('https://api.anthropic.com/v1/messages', json=body, timeout=300,
                          headers={'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
        if r.status_code != 200:
            raise RuntimeError(f'claude {r.status_code}: {r.text[:300]}')
        j = r.json(); u = j.get('usage', {})
        ns = (u.get('server_tool_use') or {}).get('web_search_requests', 0)
        pi, po = PRICES.get(body['model'], (PRICE_IN, PRICE_OUT))
        cost = (u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0)) * pi + \
               u.get('cache_read_input_tokens', 0) * pi * 0.1 + u.get('output_tokens', 0) * po + ns * PRICE_SEARCH
        spent['usd'] += cost; spent['searches'] += ns; spent['calls'] += 1
        text += ''.join(b.get('text', '') for b in j['content'] if b.get('type') == 'text')
        if j.get('stop_reason') == 'pause_turn':
            msgs = msgs + [{'role': 'assistant', 'content': j['content']}]
            body['messages'] = msgs; continue
        break
    return text

def extract_json(text):
    m = re.search(r'<json>(.*?)</json>', text, re.S)
    s = m.group(1) if m else text[text.find('['):text.rfind(']') + 1] if '[' in text else text[text.find('{'):text.rfind('}') + 1]
    try: return json.loads(s)
    except Exception: return None

def fetch(url, timeout=15):
    try:
        r = requests.get(url, headers=UA, timeout=timeout, allow_redirects=True)
        return r.status_code, r.url, r.text[:600000]
    except Exception as e:
        return 0, url, ''

def norm_domain(u):
    if not u: return ''
    if '://' not in u: u = 'https://' + u
    h = urlparse(u).netloc.lower().split(':')[0]
    return h[4:] if h.startswith('www.') else h

def page_text(h):
    h = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', h, flags=re.S | re.I)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', h)))

def name_tokens(n):
    return [t for t in re.findall(r'[a-z0-9]+', n.lower()) if t not in ('inc', 'llc', 'ltd', 'the', 'co', 'corp', 'limited', 'group', 'hq', 'ai', 'io')]

# ---------- stage 1: discovery ----------
ANGLES = [
  'Search company career pages and public applicant-tracking job boards (e.g. boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, apply.workable.com) for open postings that match the signal.',
  'Search job aggregators and professional networks (e.g. LinkedIn Jobs, Indeed, Wellfound, Built In) for recent postings that match the signal, then identify the employer.',
  'Search recent news, press releases and company blogs/announcements (funding, launches, expansion) where the company says it is building or growing the team described in the signal, and confirm with an open job posting.',
  'Search for very recent postings (last 2-3 weeks) that match the signal, using varied wording of the role titles.',
  'Search jobs.ashbyhq.com and jobs.lever.co specifically for the role titles in the signal, newest first.',
  'Search boards.greenhouse.io and job-boards.greenhouse.io specifically for the role titles in the signal, newest first.',
]

def discover(brief, angle, n=15):
    p = f"""You are a B2B lead researcher. Find REAL companies matching this brief.
BRIEF (seller and target): {brief['seller']}
TARGET COMPANIES: {brief['target']}
BUYING SIGNAL: {brief['signal']}
ALLOWED REGIONS: {', '.join(brief['regions'])}
MAX SIGNAL AGE: {brief['max_age_days']} days (today is {dt.date.today().isoformat()}).
Search approach for this pass: {angle}
Strongly prefer postings hosted on boards.greenhouse.io / job-boards.greenhouse.io, jobs.lever.co or jobs.ashbyhq.com (their freshness can be verified). Prefer postings from the last 30 days; skip anything that looks older.\nRules: only companies you found evidence for in search results this session; never invent. Exclude staffing/recruiting agencies posting for clients. Company size matters: only companies with fewer than {brief.get('max_employees', 250)} employees (typically seed to Series B startups or small established firms); skip well-known large companies and public companies. The job posting URL must be a specific posting page (not a search page).
Return up to {n} companies as JSON inside <json></json>: a list of objects with keys
company, website (the company's own official domain), job_title, job_url, job_location, date_posted (YYYY-MM-DD or null if unknown), employees_estimate, why (one sentence)."""
    try:
        t = claude(p, max_uses=6, max_tokens=5000)
    except Exception as e:
        log('discover error', e); return []
    j = extract_json(t)
    return j if isinstance(j, list) else []

# ---------- stage 2: website proof ----------
def prove_website(c):
    d = norm_domain(c.get('website', ''))
    if not d: return None, 'no_website'
    code, final, h = fetch('https://' + d)
    if code != 200 or not h: return None, f'website_unreachable({code})'
    fd = norm_domain(final)
    toks = name_tokens(c['company'])
    t = page_text(h)[:20000].lower()
    title = (re.search(r'<title[^>]*>(.*?)</title>', h, re.S | re.I) or [None, ''])[1].lower()
    if not toks or not any(tok in t or tok in title or tok in fd for tok in toks):
        return None, 'website_name_mismatch'
    return {'domain': fd, 'home': final, 'html': h}, None

# ---------- stage 3: signal proof ----------
def board_jobs(url):
    """List all open jobs on the company's public ATS board (free APIs)."""
    u = urlparse(url); host = u.netloc.lower(); parts = [p for p in u.path.split('/') if p]
    out = []
    try:
        if 'greenhouse.io' in host and parts:
            slug = parts[0]
            r = requests.get(f'https://boards-api.greenhouse.io/v1/boards/{slug}/jobs', timeout=15)
            if r.ok:
                for j in r.json().get('jobs', []):
                    out.append((j.get('title',''), (j.get('first_published') or j.get('updated_at') or '')[:10], (j.get('location') or {}).get('name',''), j.get('absolute_url'), 'greenhouse_api'))
        elif 'lever.co' in host and parts:
            r = requests.get(f'https://api.lever.co/v0/postings/{parts[0]}?mode=json', timeout=15)
            if r.ok:
                for j in r.json():
                    ts = j.get('createdAt'); d = dt.datetime.fromtimestamp(ts/1000, dt.timezone.utc).date().isoformat() if ts else ''
                    out.append((j.get('text',''), d, (j.get('categories') or {}).get('location',''), j.get('hostedUrl'), 'lever_api'))
        elif 'ashbyhq.com' in host and parts:
            r = requests.get(f'https://api.ashbyhq.com/posting-api/job-board/{parts[0]}', timeout=15)
            if r.ok:
                for j in r.json().get('jobs', []):
                    out.append((j.get('title',''), (j.get('publishedAt') or '')[:10], j.get('location',''), j.get('jobUrl'), 'ashby_api'))
    except Exception:
        pass
    return out

def job_links_site(job_url, c, site, h=None):
    """The job posting (or its ATS board) must point at the company's website, or the website must link to the board."""
    dom = site['domain']; base = dom.split('.')[0]
    if h is None:
        code, _, h = fetch(job_url)
    if h and (dom in h.lower()): return True
    u = urlparse(job_url); parts = [p for p in u.path.split('/') if p]
    slug = parts[0].lower() if parts else ''
    if slug and slug in site['html'].lower(): return True
    for path in ('/careers', '/jobs', '/company/careers', '/about/careers'):
        code, _, hh = fetch('https://' + dom + path, timeout=10)
        if code == 200 and hh and (slug and slug in hh.lower()) and u.netloc.split('.')[-2] in hh.lower(): return True
    return False

def fresh_board_match(c, brief):
    roles = [r.lower() for r in brief['role_keywords']]
    best = None
    for t, d, loc, u, src in board_jobs(c.get('job_url') or ''):
        if not d or not any(r in t.lower() for r in roles): continue
        try: age = (dt.date.today() - dt.date.fromisoformat(d)).days
        except Exception: continue
        if age > brief['max_age_days']: continue
        if not any(x.lower() in str(loc).lower() for x in brief['region_terms']): continue
        if best is None or age < best['age_days']:
            best = {'url': u, 'date': d, 'title': t, 'location': loc, 'date_source': src, 'age_days': age}
    return best

def ats_date(url):
    u = urlparse(url); host = u.netloc.lower(); parts = [p for p in u.path.split('/') if p]
    try:
        if 'greenhouse.io' in host and 'jobs' in parts:
            slug = parts[0] if parts[0] != 'embed' else None
            jid = parts[parts.index('jobs') + 1]
            if slug:
                r = requests.get(f'https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jid}', timeout=15)
                if r.ok:
                    j = r.json(); d = j.get('first_published') or j.get('updated_at')
                    return (d or '')[:10], j.get('title'), (j.get('location') or {}).get('name'), 'greenhouse_api'
                return None, None, None, f'greenhouse_api_{r.status_code}'
        if 'lever.co' in host and len(parts) >= 2:
            r = requests.get(f'https://api.lever.co/v0/postings/{parts[0]}/{parts[1]}', timeout=15)
            if r.ok:
                j = r.json(); ts = j.get('createdAt')
                d = dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).date().isoformat() if ts else None
                return d, j.get('text'), (j.get('categories') or {}).get('location'), 'lever_api'
            return None, None, None, f'lever_api_{r.status_code}'
        if 'ashbyhq.com' in host and len(parts) >= 2:
            r = requests.get(f'https://api.ashbyhq.com/posting-api/job-board/{parts[0]}', timeout=15)
            if r.ok:
                for j in r.json().get('jobs', []):
                    if parts[1] in (j.get('id', ''), j.get('jobUrl', '')) or parts[1] in j.get('jobUrl', ''):
                        return (j.get('publishedAt') or '')[:10], j.get('title'), j.get('location'), 'ashby_api'
                return None, None, None, 'ashby_job_closed'
    except Exception as e:
        return None, None, None, f'ats_error'
    return None, None, None, None

def jsonld_date(h):
    for m in re.finditer(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', h, re.S | re.I):
        try: j = json.loads(m.group(1).strip())
        except Exception: continue
        items = j if isinstance(j, list) else j.get('@graph', [j]) if isinstance(j, dict) else []
        for it in items:
            if isinstance(it, dict) and it.get('@type') == 'JobPosting':
                loc = it.get('jobLocation'); locs = json.dumps(loc)[:300] if loc else ''
                return (it.get('datePosted') or '')[:10], it.get('title'), locs, it.get('hiringOrganization', {}).get('name') if isinstance(it.get('hiringOrganization'), dict) else None
    return None, None, None, None

def prove_signal(c, brief, site):
    url = c.get('job_url') or ''
    if not url.startswith('http'): return None, 'no_job_url'
    fb = fresh_board_match(c, brief)
    if fb:
        if not job_links_site(fb['url'], c, site): return None, 'website_job_mismatch'
        return fb, None
    d, title, loc, src = ats_date(url)
    if src and src.endswith(('_404', 'closed')): return None, 'job_closed'
    code, final, h = fetch(url)
    if not d:
        if code != 200 or not h: return None, f'job_unreachable({code})'
        d2, t2, l2, org = jsonld_date(h)
        if d2: d, title, loc, src = d2, t2 or title, l2, 'jsonld'
    pt = page_text(h).lower() if h else ''
    if code and code != 200 and not src: return None, f'job_unreachable({code})'
    # role must match
    jt = (title or c.get('job_title') or '').lower()
    roles = [r.lower() for r in brief['role_keywords']]
    if not any(r in jt for r in roles) and not any(r in pt[:5000] for r in roles):
        return None, 'role_not_matching'
    # employer must be the company: page mentions company name or domain
    toks = name_tokens(c['company'])
    if pt and not any(t in pt for t in toks) and site['domain'].split('.')[0] not in final.lower():
        return None, 'employer_mismatch'
    if not job_links_site(url, c, site, h): return None, 'website_job_mismatch'
    if not d: return None, 'date_unverified'
    try: age = (dt.date.today() - dt.date.fromisoformat(d)).days
    except Exception: return None, 'date_unparseable'
    if age > brief['max_age_days']: return None, f'stale({age}d)'
    locs = (str(loc or '') + ' ' + (c.get('job_location') or '')).lower() + ' ' + pt[:20000]
    if not any(r.lower() in locs for r in brief['region_terms']):
        return None, 'region_unverified'
    return {'url': final if code == 200 else url, 'date': d, 'title': title or c.get('job_title'), 'location': loc or c.get('job_location'), 'date_source': src, 'age_days': age}, None

# ---------- stage 4: buyer ----------
def find_buyer(c, site, brief):
    p = f"""Find the best person to sell to at {c['company']} ({site['domain']}). Preferred roles, in order: {', '.join(brief['buyer_titles'])}.
Use web search. Only report a person who CURRENTLY holds the role per a recent source. Prefer sources on the company's own website (team/about/leadership pages) or press, plus their public LinkedIn profile URL (linkedin.com/in/...).
Also determine, from a source you found: current employee count (e.g. LinkedIn company page band or recent press), whether the company mainly sells to businesses (B2B), and whether it is an independent company (not acquired / not a subsidiary).
Return JSON in <json></json>: {{"name":..., "title":..., "linkedin": url or null, "sources": [urls that name this person with this role at this company], "employees": integer best estimate or null, "employees_source": url or null, "b2b": true/false/null, "independent": true/false/null, "notes": short}} or {{"name": null}} if not found."""
    try: j = extract_json(claude(p, max_uses=4, max_tokens=1800, model=BUYER_MODEL))
    except Exception as e: return None, 'buyer_error'
    if not isinstance(j, dict) or not j.get('name'): return None, 'buyer_not_found'
    name = j['name'].strip(); last = name.split()[-1].lower(); first = name.split()[0].lower()
    titles_ok = any(k in (j.get('title') or '').lower() for k in brief['buyer_title_keywords'])
    if not titles_ok: return None, 'buyer_title_off'
    emp = j.get('employees')
    if not isinstance(emp, (int, float)) or emp <= 0: return None, 'size_unverified'
    if emp > brief.get('max_employees', 300) or emp < brief.get('min_employees', 1): return None, f'size_out_of_range({int(emp)})'
    if j.get('b2b') is not True: return None, 'not_b2b_or_unknown'
    if j.get('independent') is False: return None, 'acquired_or_subsidiary'
    corroborated = None
    srcs = [s for s in (j.get('sources') or []) if 'linkedin.com' not in s][:3]
    # also try the company's own team/about pages
    for path in ('/about', '/team', '/about-us', '/company', '/leadership'):
        srcs.append('https://' + site['domain'] + path)
    own, other = None, set()
    for s in srcs:
        code, final, h = fetch(s, timeout=10)
        if code == 200 and h:
            t = page_text(h).lower()
            if first in t and last in t and (any(k in t for k in name_tokens(c['company'])) or site['domain'] in final):
                fd = norm_domain(final)
                if fd == site['domain'] or fd.endswith('.' + site['domain']): own = final; break
                other.add((fd, final))
    # strict: one page on the company's own site, or two independent outside pages
    if own: corroborated = own
    elif len({d for d, _ in other}) >= 2: corroborated = ' + '.join(sorted(u for _, u in other)[:2])
    li = j.get('linkedin') or ''
    li_ok = bool(re.match(r'https?://([a-z]+\.)?linkedin\.com/in/', li)) and (last in li.lower() or first in li.lower())
    if not corroborated: return None, 'buyer_uncorroborated'
    return {'name': name, 'title': j.get('title'), 'linkedin': li if li_ok else None, 'proof': corroborated,
            'employees': int(emp), 'employees_source': j.get('employees_source')}, None

# ---------- stage 5: published email ----------
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
def find_email(site, buyer):
    found = {}
    pages = [site['home']] + ['https://' + site['domain'] + p for p in ('/contact', '/contact-us', '/about', '/team')]
    for u in pages:
        code, final, h = (200, u, site['html']) if u == site['home'] else fetch(u, timeout=10)
        if code != 200: continue
        for e in set(EMAIL.findall(h)):
            e = e.lower().strip('.')
            if e.endswith('.' + site['domain']) or e.endswith('@' + site['domain']):
                if not re.search(r'\.(png|jpg|svg|webp)$', e): found.setdefault(e, final)
    if not found: return None
    first = buyer['name'].split()[0].lower(); last = buyer['name'].split()[-1].lower()
    for e, s in found.items():
        if first in e.split('@')[0] or last in e.split('@')[0]: return {'address': e, 'source': s, 'personal': True}
    e, s = sorted(found.items(), key=lambda kv: (not re.match(r'(sales|hello|info|contact)@', kv[0]), kv[0]))[0]
    return {'address': e, 'source': s, 'personal': False}

def main():
    brief = json.load(open(sys.argv[1])); out = sys.argv[2]
    t0 = time.time(); stages = {'discovered': 0, 'unique': 0}
    with cf.ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda a: discover(brief, a), ANGLES))
    cands = {}
    for lst in res:
        for c in lst:
            if not isinstance(c, dict) or not c.get('company'): continue
            stages['discovered'] += 1
            k = norm_domain(c.get('website', '')) or c['company'].lower()
            cands.setdefault(k, c)
    stages['unique'] = len(cands)
    log('discovered', stages, 'spent', round(spent['usd'], 3))
    holds = {}; ready = []; held = []
    def process(c):
        site, why = prove_website(c)
        if why: return c, None, why
        sig, why = prove_signal(c, brief, site)
        if why: return c, None, why
        return c, (site, sig), None
    with cf.ThreadPoolExecutor(8) as ex:
        stage2 = list(ex.map(process, cands.values()))
    passed = []; seen_jobs = set()
    for c, ok, why in stage2:
        if not why and ok[1]['url'] in seen_jobs: why = 'duplicate'
        if not why: seen_jobs.add(ok[1]['url'])
        if why: holds[why.split('(')[0]] = holds.get(why.split('(')[0], 0) + 1; held.append({'company': c.get('company'), 'reason': why, 'job_url': c.get('job_url')})
        else: passed.append((c, ok))
    stages['signal_verified'] = len(passed)
    log('signal verified', len(passed), holds, 'spent', round(spent['usd'], 3))
    def buyer_stage(item):
        c, (site, sig) = item
        try:
            b, why = find_buyer(c, site, brief)
        except Exception as e:
            return c, site, sig, None, 'budget_stop'
        return c, site, sig, b, why
    with cf.ThreadPoolExecutor(6) as ex:
        stage3 = list(ex.map(buyer_stage, passed))
    for c, site, sig, b, why in stage3:
        if why:
            holds[why] = holds.get(why, 0) + 1; held.append({'company': c['company'], 'reason': why}); continue
        em = find_email(site, b)
        ready.append({'company': c['company'], 'website': 'https://' + site['domain'], 'buyer': b, 'email': em,
                      'signal': sig, 'why': c.get('why'), 'employees_estimate': c.get('employees_estimate')})
    stages['ready'] = len(ready)
    stages['with_linkedin'] = sum(1 for r in ready if r['buyer'].get('linkedin'))
    stages['with_email'] = sum(1 for r in ready if r['email'])
    rep = {'brief_id': brief.get('id'), 'stages': stages, 'holds': holds, 'cost_usd': round(spent['usd'], 3),
           'searches': spent['searches'], 'claude_calls': spent['calls'], 'minutes': round((time.time() - t0) / 60, 1),
           'ready': ready, 'held': held}
    json.dump(rep, open(out, 'w'), indent=2)
    log(json.dumps({k: rep[k] for k in ('stages', 'holds', 'cost_usd', 'searches', 'minutes')}))

if __name__ == '__main__':
    main()
