"""Black-box smoke test against a running dev server.

Run with `npm run test:smoke` while `npm start` is up. It asserts against the
seeded demo data and consumes it (submitting, scoring, finalizing), so start
from a fresh database -- `npm run seed:fresh`, then restart the server so it
does not write its in-memory copy back over the new file.
"""
import json, os, urllib.request, urllib.error, sys

BASE = os.environ.get('BASE', 'http://127.0.0.1:3000/api')
def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('content-type', 'application/json')
    if token: req.add_header('authorization', f'Bearer {token}')
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

FAILURES = []
def check(label, cond):
    print(('PASS' if cond else 'FAIL'), '|', label)
    if not cond: FAILURES.append(label)

# ---------- auth ----------
st, b = call('POST', '/auth/login', body={'username': 'admin', 'password': 'wrong'})
check('wrong password rejected', st == 401)
_, admin = call('POST', '/auth/login', body={'username': 'admin', 'password': 'ECOD-admin-2026'})
_, priya = call('POST', '/auth/login', body={'username': 'priya.nair', 'password': 'ECOD-assessor-2026'})
_, rohit = call('POST', '/auth/login', body={'username': 'rohit.verma', 'password': 'ECOD-candidate-2026'})
at, pt, rt = admin['token'], priya['token'], rohit['token']
check('logins ok', all([at, pt, rt]))
check('password hash never exposed', 'password_hash' not in json.dumps(admin))

# ---------- RBAC walls ----------
check('candidate blocked from admin api', call('GET', '/admin/candidates', rt)[0] == 403)
check('assessor blocked from users mgmt', call('GET', '/admin/users', pt)[0] == 403)
check('anon blocked', call('GET', '/admin/dashboard')[0] == 401)

# ---------- admin dashboard ----------
st, dash = call('GET', '/admin/dashboard', at)
check('dashboard stats', st == 200 and dash['counts']['candidates'] == 3)
check('stage distribution has gap_mapping (Neha)', dash['by_stage'].get('gap_mapping') == 1)
check('seeded scored example visible', dash['counts']['avg_score'] is not None)

# ---------- candidate journey ----------
st, lst = call('GET', '/candidate/assessments', rt)
aid = lst['assessments'][0]['id']
check('Rohit sees exactly 1 assessment', len(lst['assessments']) == 1)
st, quiz = call('GET', f'/candidate/assessments/{aid}', rt)
check('quiz starts in_progress', quiz['assessment']['status'] == 'in_progress')
blob = json.dumps(quiz)
check('NO correct answers in quiz payload', 'correct_option_ids' not in blob)
check('NO rubric in quiz payload', 'rubric' not in blob)
check('NO assessor identity in quiz payload', 'riya' not in blob)

check('exam issues one live question', len(quiz.get('questions') or []) == 1 and quiz.get('current_question'))
check('exam.total is the full snapshot', quiz['exam']['total'] >= 1)
db = json.load(open(os.environ.get('DATA_FILE', 'data/ecod.json')))
qbank = {q['id']: q for q in db['tables']['questions'].values()}
asmt = db['tables']['assessments'][aid]
qs = asmt['snapshot_json']['questions']
quiz_role = asmt.get('role_id') or (qbank[qs[0]['id']]['role_id'] if qs else None)
bank_total = len([q for q in qbank.values() if q.get('active', True) and q['role_id'] == quiz_role])
check('exam.total matches the seeded snapshot', quiz['exam']['total'] == len(qs))
answers = {}
for q in qs:
    src = qbank[q['id']]
    if q['type'] == 'mcq_single': answers[q['id']] = src['correct_option_ids'][0]
    elif q['type'] == 'mcq_multi': answers[q['id']] = list(src['correct_option_ids'])
    elif q['type'] == 'scale': answers[q['id']] = 4
    else: answers[q['id']] = 'Medallion zones with bronze/silver/gold, Unity Catalog three-level namespace per environment, cost guardrails via cluster policies and serverless, incremental migration starting with highest-value marts.'
devops_comp = [k for k, v in db['tables']['competencies'].items() if v['key'] == 'devops-production'][0]
for q in qs:
    if q['competency_id'] == devops_comp:
        if q['type'] == 'mcq_single': answers[q['id']] = [o['id'] for o in q['options'] if o['id'] != qbank[q['id']]['correct_option_ids'][0]][0]
        elif q['type'] == 'mcq_multi': answers[q['id']] = [qbank[q['id']]['correct_option_ids'][0]]
        elif q['type'] == 'scale': answers[q['id']] = 1  # weak self-rating
        else: answers[q['id']] = 'Restart the cluster and retry the job.'

st, inc = call('POST', f'/candidate/assessments/{aid}/submit', rt, {'answers': dict(list(answers.items())[:5])})
check('incomplete submit returns 422 with missing list', st == 422 and len(inc['missing_question_ids']) == len(qs) - 5)
st, sub = call('POST', f'/candidate/assessments/{aid}/submit', rt, {'answers': answers})
check('submit ok', st == 200)
st, _ = call('POST', f'/candidate/assessments/{aid}/submit', rt, {'answers': answers})
check('resubmit blocked', st == 409)
st, rep = call('GET', f'/candidate/reports/{aid}', rt)
check('report hidden before scoring', st == 409)

# ---------- assessor journey ----------
st, wl = call('GET', '/assessor/assessments', pt)
check('Priya sees 1 assigned', len(wl['assessments']) == 1)
proj = wl['assessments'][0]['candidate']
check('candidate projection hides contact+notes', not any(k in proj for k in ('email', 'phone', 'notes', 'source')))
st, det = call('GET', f'/assessor/assessments/{aid}', pt)
check('assessor sees rubrics', any(q.get('rubric') for q in det['questions']))
check('assessor sees auto scores', any(r.get('auto_score') is not None for r in det['responses']))
manual = [q for q in det['questions'] if q['type'] == 'text']
check('manual (open-response) questions present', len(manual) >= 1)
st, early = call('POST', f'/assessor/assessments/{aid}/finalize', pt)
check('finalize blocked until all scored', st == 422)
scores = []
for q in manual:
    weak = 'incident' in q['prompt'].lower() or 'friday' in q['prompt'].lower()
    scores.append({'question_id': q['id'], 'score': 1 if weak else 5, 'comment': 'Thin - missing RCA and prevention' if weak else 'Clear and complete'})
st, sv = call('PUT', f'/assessor/assessments/{aid}/scores', pt, {'scores': scores})
check('scores saved', st == 200)
st, fin = call('POST', f'/assessor/assessments/{aid}/finalize', pt)
check('finalize produces report', st == 200)
check('band present', fin['report']['band']['key'] in ('enterprise_ready', 'development_needed', 'not_ready'))
print('   >> Rohit overall:', fin['report']['overall_pct'], fin['report']['band']['label'])
check('gap areas computed', len(fin['report']['areas_to_improve']) >= 1)
print('   >> top improvement area:', fin['report']['areas_to_improve'][0]['competency'])

# ---------- candidate report card ----------
st, card = call('GET', f'/candidate/reports/{aid}', rt)
check('candidate sees report after scoring', st == 200)
payload = json.dumps(card)
check('candidate report has areas to improve', len(card['report']['areas_to_improve']) >= 1)
check('candidate report hides assessor name', 'Priya' not in payload)
check('candidate report hides assessor comments', 'Thin - missing' not in payload and 'Clear and complete' not in payload)
check('candidate report includes recommended focus', 'recommended_focus' in payload)

# ---------- admin full report ----------
st, arep = call('GET', f'/admin/reports/{aid}', at)
check('admin sees assessor name', arep['assessor_name'] == 'Priya Nair')
check('admin sees comments', 'Thin - missing' in json.dumps(arep))

# ---------- cross-assessor isolation ----------
_, arjun = call('POST', '/auth/login', body={'username': 'arjun.mehta', 'password': 'ECOD-assessor-2026'})
st, _ = call('GET', f'/assessor/assessments/{aid}', arjun['token'])
check('other assessor gets 404 (existence hidden)', st == 404)

print()
if FAILURES:
    print(f'{len(FAILURES)} FAILURES'); sys.exit(1)
print('ALL SMOKE TESTS PASSED')
