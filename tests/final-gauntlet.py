"""
ECOD final gauntlet. Black-box hardening checks against a running server that go
beyond smoke.py / features.py: a route x role authorisation matrix, cross-tenant
isolation, a full lock-and-next exam journey with the review phase, a zero-5xx
fuzz sweep, concurrency races (exactly-once advances, exact integrity counters,
racing allocations), live spreadsheet imports (including a zip bomb), generic
pagination, and security headers.

Self-contained: every fixture is namespaced with a timestamp and the script
cleans up everything it can (bank questions, open assessments, candidates and
their cascaded portal users). The one scored journey assessment is left behind
by design — finalized reports are delete-protected — so prefer a fresh seed for
a pristine database, but a repeat run still passes.

Run:  npm run seed:fresh && <restart server> && npm run test:gauntlet
"""
import base64
import concurrent.futures as cf
import json
import os
import struct
import sys
import time
import urllib.request
import urllib.error

BASE = os.environ.get('BASE', 'http://127.0.0.1:3000/api')
ROOT = BASE[:-4]  # strip /api
ADMIN_USER = os.environ.get('ADMIN_USER', 'admin')
ADMIN_PASS = os.environ.get('ADMIN_PASS', 'ECOD-admin-2026')
TS = int(time.time())
TAG = f'G{TS}'


def call(method, path, token=None, body=None, raw=False, headers=False):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('content-type', 'application/json')
    if token:
        req.add_header('authorization', f'Bearer {token}')
    if isinstance(body, (bytes, bytearray)):
        data = body
    elif body is not None:
        data = json.dumps(body).encode()
    else:
        data = None
    try:
        with urllib.request.urlopen(req, data) as res:
            payload = res.read()
            out = (res.status, (payload if raw else json.loads(payload)))
            return out + (dict(res.headers),) if headers else out
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            out = (e.code, json.loads(payload))
        except Exception:
            out = (e.code, {'error': payload[:200].decode(errors='ignore')})
        return out + (dict(e.headers),) if headers else out


FAILS, PASSED = [], 0


def check(label, cond):
    global PASSED
    cond = bool(cond)
    PASSED += cond
    if cond:
        print(f'PASS | {label}')
    else:
        FAILS.append(label)
        print(f'FAIL | {label}')


def section(t):
    print(f'\n== {t} ==')


# ================================ fixtures
section('fixtures: namespaced role, questions, candidates, users')
st, adm = call('POST', '/auth/login', body={'username': ADMIN_USER, 'password': ADMIN_PASS})
check('admin login works', st == 200 and bool(adm.get('token')))
AT = adm['token']

st, role = call('POST', '/admin/roles', AT,
                {'key': f'gauntlet-{TS}', 'name': f'Gauntlet {TAG}', 'technology': 'Gauntlet'})
check('role created', st == 201)
ROLE = role['id']
st, comp = call('POST', '/admin/competencies', AT,
                {'role_id': ROLE, 'name': f'Gauntlet Comp {TAG}', 'weight': 100})
check('competency created', st == 201)
COMP = comp['id']
st, q_mcq = call('POST', '/admin/questions', AT, {
    'role_id': ROLE, 'competency_id': COMP, 'type': 'mcq_single',
    'prompt': f'Gauntlet {TAG}: which layout separates raw, curated and served data?',
    'options': [{'id': 'a', 'label': 'One schema'}, {'id': 'b', 'label': 'Bronze silver gold'}],
    'correct_option_ids': ['b'], 'order': 1})
check('mcq question created', st == 201)
st, q_open = call('POST', '/admin/questions', AT, {
    'role_id': ROLE, 'competency_id': COMP, 'type': 'text',
    'prompt': f'Gauntlet {TAG}: describe how you would recover a failed migration.',
    'rubric': f'Gauntlet {TAG} evidence: rollback plan, comms, verification.', 'order': 2})
check('open question created', st == 201)


def mk_candidate(name):
    st, c = call('POST', '/admin/candidates', AT, {'name': name})
    assert st == 201, f'candidate create failed: {st} {c}'
    return c['id']


def mk_user(username, role_name, candidate_id=None):
    body = {'username': username, 'name': username, 'role': role_name,
            'password': 'gauntlet-pass-1', 'auto_allocate': False}
    if candidate_id:
        body['candidate_id'] = candidate_id
    st, u = call('POST', '/admin/users', AT, body)
    assert st == 201, f'user create failed: {st} {u}'
    return u


def login(username):
    st, b = call('POST', '/auth/login', body={'username': username, 'password': 'gauntlet-pass-1'})
    assert st == 200, f'login failed for {username}: {st} {b}'
    return b['token']


CA = mk_candidate(f'Gauntlet A {TAG}')
CB = mk_candidate(f'Gauntlet B {TAG}')
CC = mk_candidate(f'Gauntlet C {TAG}')
mk_user(f'gauntlet.a.{TS}', 'candidate', CA)
mk_user(f'gauntlet.b.{TS}', 'candidate', CB)
mk_user(f'gauntlet.assessor.{TS}', 'assessor')
mk_user(f'gauntlet.assessor2.{TS}', 'assessor')
TA, TB = login(f'gauntlet.a.{TS}'), login(f'gauntlet.b.{TS}')
TS1, TS2 = login(f'gauntlet.assessor.{TS}'), login(f'gauntlet.assessor2.{TS}')
_, assessor1 = call('GET', '/auth/me', TS1)
AS1 = assessor1['user']['id']
check('candidate + assessor logins work', True)

# ================================ G1 auth matrix
section('G1 · route x role authorisation matrix')
matrix = [
    ('GET', '/admin/candidates', None, 401, TA, 403, TS1, 403, AT, 200),
    ('GET', '/assessor/assessments', None, 401, TA, 403, AT, 403, TS1, 200),
    ('GET', '/candidate/assessments', None, 401, TS1, 403, AT, 403, TA, 200),
    ('GET', '/meta/bootstrap', None, 200, TA, 200, TS1, 200, AT, 200),
    ('GET', '/health', None, 200, None, 200, None, 200, None, 200),
]
for method, path, t1, e1, t2, e2, t3, e3, t4, e4 in matrix:
    exp = [e1, e2, e3, e4]
    got = [call(method, path, t)[0] for t in (t1, t2, t3, t4)]
    check(f'{method} {path} -> {exp}', got == exp)
st, _ = call('POST', '/admin/questions', TS1, {'role_id': ROLE})
check('assessor POST /admin/questions -> 403 (guard before validation)', st == 403)
st, _ = call('PUT', '/assessor/assessments/x/scores', AT, {'scores': []})
check('admin PUT assessor scores -> 403', st == 403)
st, _ = call('GET', f'/candidate/assessments/x', TA)
check('candidate reads foreign assessment id -> 404, not 403 (existence hidden)', st == 404)

# ================================ G2 full journey
section('G2 · full exam journey: allocate, lock-and-next, review, submit, score, report')
st, asm = call('POST', '/admin/assessments', AT,
               {'candidate_id': CA, 'role_id': ROLE, 'assessor_id': AS1})
check('allocate journey assessment -> 201 with 2 questions',
      st == 201 and asm['question_count'] == 2)
ASMA = asm['id']
check('re-allocation of the same track conflicts',
      call('POST', '/admin/assessments', AT, {'candidate_id': CA, 'role_id': ROLE})[0] == 409)

def answer_for(q):
    if q['type'] == 'mcq_single':
        return q['options'][0]['id']
    if q['type'] == 'mcq_multi':
        return [q['options'][0]['id']]
    if q['type'] == 'scale':
        return 4
    return 'Roll back via blue/green, page the on-call, verify with canaries.'


st, quiz = call('GET', f'/candidate/assessments/{ASMA}', TA)
check('quiz opens with 2 questions and answers hidden',
      st == 200 and quiz['exam']['total'] == 2 and quiz['current_question']
      and 'correct_option_ids' not in json.dumps(quiz) and 'rubric' not in json.dumps(quiz))

# Walk the paper in whatever shuffled order it was served: review the open
# question through its review phase, answer everything, and prove a stale
# advance no-ops mid-paper.
saw_review = transitioned = stale_checked = False
order_seen = []
for _ in range(5):
    st, quiz = call('GET', f'/candidate/assessments/{ASMA}', TA)
    q, ex = quiz['current_question'], quiz['exam']
    if not q or ex.get('complete'):
        break
    order_seen.append(q['type'])
    if q['type'] == 'text' and ex.get('phase') == 'review':
        saw_review = True
        if not transitioned:
            st, ph = call('POST', f'/candidate/assessments/{ASMA}/phase', TA, {'phase': 'answer'})
            check('review -> answer transition inside the window -> 200',
                  st == 200 and ph.get('phase') == 'answer')
            check('second transition attempt -> 409 (timer cannot be reset)',
                  call('POST', f'/candidate/assessments/{ASMA}/phase', TA, {'phase': 'answer'})[0] == 409)
            check('bogus phase value -> 400',
                  call('POST', f'/candidate/assessments/{ASMA}/phase', TA, {'phase': 'review'})[0] == 400)
            transitioned = True
    st, nxt = call('POST', f'/candidate/assessments/{ASMA}/next', TA,
                   {'answer': answer_for(q), 'question_id': q['id']})
    if not stale_checked:
        st2, dup = call('POST', f'/candidate/assessments/{ASMA}/next', TA,
                        {'answer': answer_for(q), 'question_id': q['id']})
        check('a duplicated advance (stale question_id) no-ops instead of skipping',
              st2 == 200 and (dup.get('duplicate') is True or dup.get('complete') is True))
        stale_checked = True
    if nxt.get('complete'):
        break
check('the walk answered both questions in order', sorted(order_seen) == ['mcq_single', 'text'])
check('the open question was served through a review phase', saw_review and transitioned)

st, sub = call('POST', f'/candidate/assessments/{ASMA}/submit', TA, {'answers': {}})
check('submit with an empty transcript finalises (answers already persisted)',
      st == 200 and sub.get('status') == 'submitted')
check('resubmit -> 409',
      call('POST', f'/candidate/assessments/{ASMA}/submit', TA, {'answers': {}})[0] == 409)
check('answers locked after submit -> 409',
      call('PUT', f'/candidate/assessments/{ASMA}/answers', TA,
           {'answers': {q_mcq['id']: 'a'}})[0] == 409)

COMMENT = f'Gauntlet {TAG} assessor comment, must stay assessor-side.'
st, _ = call('PUT', f'/assessor/assessments/{ASMA}/scores', TS1,
             {'scores': [{'question_id': q_open['id'], 'score': 4, 'comment': COMMENT}]})
check('assessor scores the open question', st == 200)
st, fin = call('POST', f'/assessor/assessments/{ASMA}/finalize', TS1)
check('finalize produces a banded report',
      st == 200 and fin.get('status') == 'scored' and bool(fin['report'].get('band')))

st, crep = call('GET', f'/candidate/reports/{ASMA}', TA)
check('candidate report hides assessor name and comments',
      st == 200 and 'assessor_name' not in crep and COMMENT not in json.dumps(crep))
st, arep = call('GET', f'/admin/reports/{ASMA}', AT)
check('admin report shows assessor name and comments',
      st == 200 and 'gauntlet.assessor' in arep.get('assessor_name', '') and COMMENT in json.dumps(arep))

st, audit = call('GET', '/admin/audit?entity=assessments&limit=200', AT)
mine = [e['action'] for e in audit.get('events', []) if e.get('entity_id') == ASMA]
check('this journey audited (allocated + submitted + scored)',
      st == 200 and 'assessment_allocated' in mine and 'assessment_submitted' in mine
      and 'assessment_scored' in mine)

# ================================ G3 cross-tenant isolation
section('G3 · cross-tenant isolation: foreign objects 404-hide')
check('candidate B reads A paper -> 404', call('GET', f'/candidate/assessments/{ASMA}', TB)[0] == 404)
check('candidate B writes A answers -> 404',
      call('PUT', f'/candidate/assessments/{ASMA}/answers', TB, {'answers': {'x': 1}})[0] == 404)
check('candidate B advances A paper -> 404',
      call('POST', f'/candidate/assessments/{ASMA}/next', TB, {'answer': 'a'})[0] == 404)
check('candidate B reads A report -> 404', call('GET', f'/candidate/reports/{ASMA}', TB)[0] == 404)
check('assessor 2 reads assessor 1 paper -> 404',
      call('GET', f'/assessor/assessments/{ASMA}', TS2)[0] == 404)
check('assessor 2 scores assessor 1 paper -> 404',
      call('PUT', f'/assessor/assessments/{ASMA}/scores', TS2, {'scores': []})[0] == 404)
check('control: owner assessor still reads it', call('GET', f'/assessor/assessments/{ASMA}', TS1)[0] == 200)

# ================================ G4 concurrency races
section('G4 · concurrency: exactly-once advances, exact counters, racing allocations')
st, asmB = call('POST', '/admin/assessments', AT, {'candidate_id': CB, 'role_id': ROLE})
ASMB = asmB['id']
_, qb = call('GET', f'/candidate/assessments/{ASMB}', TB)
BQID = qb['current_question']['id']
BANS = answer_for(qb['current_question'])
with cf.ThreadPoolExecutor(max_workers=6) as ex:
    futs = [ex.submit(call, 'POST', f'/candidate/assessments/{ASMB}/next', TB,
                      {'answer': BANS, 'question_id': BQID}) for _ in range(6)]
    res = [x.result() for x in futs]
    codes = sorted(r[0] for r in res)
check('6 racing lock-and-next: no 500s', all(c != 500 for c in codes))
check('6 racing advances: exactly one advances, five no-op as duplicates',
      sum(1 for r in res if not r[1].get('duplicate')) == 1)
st, quiz = call('GET', f'/candidate/assessments/{ASMB}', TB)
check('6 racing advances land the cursor exactly once (index 1)',
      st == 200 and quiz['exam']['index'] == 1)
db = json.load(open(os.environ.get('DATA_FILE', 'data/ecod.json')))
brows = [r for r in db.get('tables', {}).get('responses', {}).values()
         if r.get('assessment_id') == ASMB and r.get('question_id') == BQID]
check('6 racing advances store exactly one response row (no duplicates)', len(brows) == 1)

with cf.ThreadPoolExecutor(max_workers=10) as ex:
    futs = [ex.submit(call, 'POST', f'/candidate/assessments/{ASMB}/integrity', TB,
                      {'event': 'blur', 'detail': f'race {i}'}) for i in range(10)]
    codes = sorted(f[0] for f in (x.result() for x in futs))
st, trail = call('GET', f'/admin/assessments/{ASMB}/integrity', AT)
check('10 parallel integrity events: all accepted, counter exact',
      all(c == 200 for c in codes) and trail['integrity'].get('blur') == 10
      and len([e for e in trail['events'] if e['event'] == 'blur']) == 10)

with cf.ThreadPoolExecutor(max_workers=2) as ex:
    futs = [ex.submit(call, 'POST', '/admin/assessments', AT,
                      {'candidate_id': CC, 'role_id': ROLE}) for _ in range(2)]
    got = sorted(x.result()[0] for x in futs)
check('racing allocations: exactly one wins (201 + 409)', got == [201, 409])
st, lst = call('GET', '/candidate/assessments', TB)
check('control: B assessment list intact after races', st == 200)

# cleanup of race fixtures (open assessment -> candidate cascade incl. portal user)
openB = asmB['id']
check('delete B open assessment', call('DELETE', f'/admin/assessments/{openB}', AT)[0] == 200)
st, _ = call('DELETE', f'/admin/candidates/{CB}', AT, {'password': ADMIN_PASS})
check('delete candidate B cascades', st == 200)
check('cascaded portal user can no longer log in',
      call('POST', '/auth/login', body={'username': f'gauntlet.b.{TS}', 'password': 'x'})[0] in (401, 400))
st, cc_list = call('GET', '/candidate/assessments', TA)  # control only
cc_asm = [a for a in call('GET', '/admin/assessments', AT)[1]['assessments'] if a['candidate_id'] == CC]
for a in cc_asm:
    call('DELETE', f"/admin/assessments/{a['id']}", AT)
check('delete candidate C cascades',
      call('DELETE', f'/admin/candidates/{CC}', AT, {'password': ADMIN_PASS})[0] == 200)

# ================================ G5 fuzz: zero 5xx
section('G5 · fuzz sweep: hostile input never 500s')
FUZZ = [
    ('PUT', f'/candidate/assessments/{ASMA}/answers', TA, {'answers': None}),
    ('PUT', f'/candidate/assessments/{ASMA}/answers', TA, {'answers': {'q': {'d': {'n': [1]}}}}),
    ('PUT', f'/candidate/assessments/{ASMA}/answers', TA, {'__proto__': {'x': 1}, 'answers': {}}),
    ('POST', f'/candidate/assessments/{ASMA}/submit', TA, {'answers': {'q': ['a'] * 5000}}),
    ('POST', f'/candidate/assessments/{ASMA}/phase', TA, {'phase': {'x': 1}}),
    ('POST', f'/candidate/assessments/{ASMA}/integrity', TA, {'event': 'constructor', 'detail': 'x'}),
    ('POST', '/admin/candidates', AT, {'name': 'x' * 200000}),
    ('POST', '/admin/candidates', AT, {'name': ['a'] * 5000}),
    ('POST', '/admin/candidates', AT, {'name': 'ok', 'stage': 'not-a-stage'}),
    ('POST', '/admin/candidates', AT, {'name': 'ok', 'years_experience': 1e100}),
    ('POST', '/admin/candidates', AT, [{'name': 'array-body'}]),
    ('POST', '/admin/users', AT, {'username': 'x', 'name': 'n', 'role': 'superadmin', 'password': 'x' * 9}),
    ('POST', '/admin/questions', AT, {'role_id': ROLE, 'competency_id': COMP, 'type': 'wat',
                                      'prompt': 'x' * 30, 'options': [None] * 100}),
    ('POST', '/admin/questions', AT, {'role_id': ROLE, 'competency_id': COMP, 'type': 'mcq_single',
                                      'prompt': 'x' * 30, 'options': 'not-a-list'}),
    ('PUT', f'/assessor/assessments/{ASMA}/scores', TS1, {'scores': [[None]]}),
    ('PUT', f'/assessor/assessments/{ASMA}/scores', TS1, {'scores': 'x'}),
    ('PUT', f'/assessor/assessments/{ASMA}/scores', TS1, {'scores': [{'question_id': q_open['id'], 'score': 'NaN'}]}),
    ('PUT', '/admin/frameworks', AT, {'role_id': ROLE, 'config': {'readiness_bands': [None, None]}}),
    ('PUT', '/admin/frameworks', AT, {'role_id': ROLE, 'config': 'bands?'}),
    ('POST', '/admin/question-bank/questions', AT, {'module': ['T01'], 'type': 'open',
                                                    'prompt': 'x' * 40, 'rubric': 'r'}),
    ('POST', '/admin/assessments', AT, {'candidate_id': CA, 'role_id': ROLE, 'question_count': 'many'}),
    ('POST', '/auth/login', None, {'username': {'$ne': 1}, 'password': 'x'}),
    ('POST', '/auth/login', None, {'username': 'admin', 'password': ['x']}),
    ('POST', '/auth/login', None, {'__proto__': {'role': 'admin'}}),
]
bad = []
for method, path, tok, body in FUZZ:
    try:
        st, b = call(method, path, tok, body)
    except Exception as e:  # connection reset etc. also counts as a failure
        bad.append(f'{method} {path} :: EXC {e}')
        continue
    if st == 500:
        bad.append(f'{method} {path} :: 500 {str(b)[:120]}')
check(f'fuzz sweep: zero 5xx across {len(FUZZ)} hostile payloads', not bad)
for line in bad[:10]:
    print(f'   >> {line}')
check('proto-pollution login fails closed (no token)',
      call('POST', '/auth/login', body={'username': {'$ne': 1}, 'password': 'x'})[1].get('token') is None)
hostile_ids = ['%ff', 'constructor', '__proto__', '..', '%2e%2e%2f', 'a' * 2000]
id_bad = []
for hid in hostile_ids:
    st, _ = call('GET', f'/admin/candidates/{hid}', AT)
    if st == 500:
        id_bad.append(hid)
check('hostile ids never 500', not id_bad)
st, _ = call('GET', '/health')
check('server healthy after fuzz', st == 200)
st, _ = call('GET', '/admin/questions?limit=abc&offset=-5', AT)
check('garbage pagination params fail safe (no 500)', st != 500)

# ================================ G6 bank intake, live
section('G6 · bank authoring over HTTP: 422s, persistence, delete')
P = f'Gauntlet {TAG} live probe: what breaks first under sustained load, and why?'
st, b = call('POST', '/admin/question-bank/questions', AT,
             {'module': 'T01', 'family': {'name': 'x'}, 'type': 'open', 'prompt': P, 'rubric': 'r'})
check('structured family -> 422 naming the field',
      st == 422 and 'Family must be plain text.' in json.dumps(b))
st, b = call('POST', '/admin/question-bank/questions', AT,
             {'module': 'T01', 'family': 'Advanced Technical Judgment', 'type': 'open',
              'prompt': P, 'rubric': 'r', 'tags': ['latency', {'tag': 'cost'}]})
check('structured tag -> 422', st == 422 and 'Tags must be plain text.' in json.dumps(b))
st, b = call('POST', '/admin/question-bank/questions', AT,
             {'module': 'T01', 'family': 'Advanced Technical Judgment', 'type': 'open',
              'prompt': P, 'rubric': 'Evidence of the bottleneck and its cause.',
              'tags': ['latency', 'cost']})
check('valid form with array tags -> 201 with tags persisted',
      st == 201 and b['question'].get('tags') == ['latency', 'cost'])
BQ = b['question']['id']
st, b = call('PATCH', f'/admin/question-bank/questions/{BQ}', AT, {'rubric': {'deep': 1}})
check('structured rubric on PATCH -> 422', st == 422 and 'Rubric must be plain text.' in json.dumps(b))
check('bank question deletes cleanly', call('DELETE', f'/admin/question-bank/questions/{BQ}', AT)[0] == 200)
check('re-delete -> 404', call('DELETE', f'/admin/question-bank/questions/{BQ}', AT)[0] == 404)

# ================================ G7 spreadsheet imports, live
section('G7 · spreadsheet imports: csv paths, zip bomb, garbage')


def build_zip(entries):
    chunks, central, offset = [], [], 0
    for name, method, data, declared in entries:
        nm = name.encode()
        local = struct.pack('<IHHHHHIIIHH', 0x04034B50, 20, 0, method, 0, 0, 0,
                            len(data), declared if declared is not None else len(data),
                            len(nm), 0)
        chunks += [local, nm, data]
        c = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014B50, 20, 20, 0, method, 0, 0, 0,
                        len(data), declared if declared is not None else len(data),
                        len(nm), 0, 0, 0, 0, 0, offset)
        central += [c, nm]
        offset += 30 + len(nm) + len(data)
    cbuf = b''.join(central)
    eocd = struct.pack('<IHHHHIIH', 0x06054B50, 0, 0, len(entries), len(entries), len(cbuf), offset, 0)
    return b''.join(chunks) + cbuf + eocd


import zlib
_co = zlib.compressobj(9, zlib.DEFLATED, -15)
_raw = _co.compress(b'<worksheet><sheetData></sheetData></worksheet>') + _co.flush()
bomb = build_zip([('xl/worksheets/sheet1.xml', 8, _raw, 100_000_000)])
st, b = call('POST', '/admin/question-bank/import', AT,
             {'filename': 'bomb.xlsx', 'file_base64': base64.b64encode(bomb).decode()})
check('zip-bomb xlsx -> 400 naming the guard', st == 400 and 'zip bomb' in json.dumps(b).lower())
st, _ = call('POST', '/admin/question-bank/import', AT,
             {'filename': 'x.xlsx', 'file_base64': '!!!not-base64!!!'})
check('garbage base64 -> 400', st == 400)
st, _ = call('POST', '/admin/question-bank/import', AT, {'filename': 'x.csv', 'file_base64': ''})
check('empty upload -> 400', st == 400)
st, b = call('POST', '/admin/question-bank/import', AT, {'csv': 'Module,Type,Prompt\n'})
check('header-only csv -> 422 with headers echoed', st == 422 and 'headers' in b)

csv = ('Module,Family,Type,Prompt,Rubric\n'
       f'T01,Advanced Technical Judgment,open,Gauntlet {TAG} csv probe: where does the queue saturate first?,Name the queue and the metric\n')
st, b = call('POST', '/admin/question-bank/import', AT, {'csv': csv, 'dry_run': True})
check('bank csv dry run accepts the valid row',
      st == 200 and b.get('accepted') == 1 and b.get('dry_run') is True)

ccsv = (f'Name,Email\nGauntlet Import {TAG},gauntlet.import.{TS}@example.com\n')
st, b = call('POST', '/admin/candidates/import', AT, {'csv': ccsv, 'dry_run': True, 'create_users': True})
check('candidate csv dry run previews one row', st == 200 and b.get('total') == 1)
st, b = call('POST', '/admin/candidates/import', AT, {'csv': ccsv, 'dry_run': False, 'create_users': True})
created = (b.get('created') or b.get('users') or [])
cid = None
if isinstance(created, list) and created:
    cid = created[0].get('candidate_id') or created[0].get('id')
if not cid:  # fall back to listing by name
    _, lst = call('GET', f'/admin/candidates?q=Gauntlet%20Import%20{TAG}', AT)
    rows = lst.get('candidates', [])
    cid = rows[0]['id'] if rows else None
check('candidate csv commit creates the record', st == 200 and bool(cid))
if cid:
    check('imported candidate deletes (cascade)',
          call('DELETE', f'/admin/candidates/{cid}', AT, {'password': ADMIN_PASS})[0] == 200)

# ================================ G8 pagination + misc
section('G8 · pagination, headers, payload ceiling')
st, p1 = call('GET', '/admin/questions?limit=1', AT)
st, p2 = call('GET', '/admin/questions?limit=1&offset=1', AT)
check('limit=1 returns one row with the total',
      st == 200 and len(p1['questions']) == 1 and p1['total'] >= 2 and p1['limit'] == 1)
check('offset shifts the window',
      len(p2['questions']) == 1 and p2['questions'][0]['id'] != p1['questions'][0]['id']
      and p2['offset'] == 1)
st, p3 = call('GET', '/admin/questions?limit=99999', AT)
check('absurd limit clamps to 500', st == 200 and p3['limit'] == 500)
st, p4 = call('GET', '/admin/audit?limit=1&offset=1', AT)
check('audit paginates with total/limit/offset echoed',
      st == 200 and p4['limit'] == 1 and p4['offset'] == 1 and p4['total'] >= 1)

_, _, h = call('GET', '/meta/bootstrap', headers=True)
check('API answers carry no-store + nosniff',
      h.get('cache-control') == 'no-store' and h.get('x-content-type-options') == 'nosniff')
with urllib.request.urlopen(ROOT + '/') as r:
    check('SPA serves html with nosniff',
          r.status == 200 and r.headers.get('x-content-type-options') == 'nosniff')
st, _ = call('POST', '/admin/candidates', AT, {'name': 'x' * (2_100_000)})
check('2.1 MB JSON to an authed route -> 413', st == 413)
st, _ = call('GET', '/health')
check('final health check', st == 200)

print(f'\nPASSED {PASSED} / {PASSED + len(FAILS)}')
if FAILS:
    print('FAILURES:')
    for f in FAILS:
        print(f'  - {f}')
    sys.exit(1)
print('ALL GAUNTLET CHECKS PASSED')
