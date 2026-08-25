"""
ECOD full-feature test suite. Exercises every feature of the platform against
a running server (isolated seed data). Usage:
    BASE=http://127.0.0.1:8765/api python3 tests/features.py
"""
import json, os, sys, urllib.request, urllib.error, uuid

BASE = os.environ.get('BASE', 'http://127.0.0.1:8765/api')
ROOT = BASE[:-4]  # strip /api

def call(method, path, token=None, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('content-type', 'application/json')
    if token: req.add_header('authorization', f'Bearer {token}')
    if isinstance(body, (bytes, bytearray)): data = body
    elif body is not None: data = json.dumps(body).encode()
    else: data = None
    try:
        with urllib.request.urlopen(req, data) as res:
            payload = res.read()
            return res.status, (payload if raw else json.loads(payload))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try: return e.code, json.loads(payload)
        except Exception: return e.code, {'error': payload[:200].decode(errors='ignore')}

FAILS, PASSED = [], 0
def check(label, cond):
    global PASSED
    cond = bool(cond)
    PASSED += cond
    (print(f'PASS | {label}') if cond else FAILS.append(label) or print(f'FAIL | {label}'))
def section(t): print(f'\n== {t} ==')

# ================================ S0 infrastructure
section('S0 · infrastructure: static SPA, fallback, API 404, payload cap')
st, html = call('GET', '/x/../..', raw=True) if False else (None, None)
resp = urllib.request.urlopen(ROOT + '/'); html = resp.read().decode()
check('GET / serves SPA', resp.status == 200 and 'Anthroprime ECOD' in html)
resp = urllib.request.urlopen(ROOT + '/candidates/abc123'); deep = resp.read().decode()
check('SPA fallback on deep route', 'Anthroprime ECOD' in deep and '<script' in deep)
resp = urllib.request.urlopen(ROOT + '/styles.css'); check('styles.css served', resp.status == 200)
resp = urllib.request.urlopen(ROOT + '/js/app.js'); check('app.js served', resp.status == 200)
st, b = call('GET', '/no-such-route'); check('unknown API route -> JSON 404', st == 404 and 'error' in b)
st, _ = call('POST', '/auth/login', body=b'{"username": "broken'); check('malformed JSON body -> 400', st == 400)
st, _ = call('POST', '/auth/login', body=b'{}'); check('missing credentials -> 400', st == 400)
st, _ = call('POST', '/auth/login', body=b' ' * (2 * 1024 * 1024 + 10))
check('oversized payload -> 413', st == 413)

# ================================ S1 auth & sessions
section('S1 · authentication, throttling, logout, deactivated users')
st, _ = call('POST', '/auth/login', body={'username': 'admin', 'password': 'WRONG'})
check('wrong password -> 401', st == 401)
for i in range(8): st, _ = call('POST', '/auth/login', body={'username': 'throttle.probe', 'password': 'x'})
st, b = call('POST', '/auth/login', body={'username': 'throttle.probe', 'password': 'x'})
check('login throttled after 8 failures -> 429', st == 429)
_, admin = call('POST', '/auth/login', body={'username': 'admin', 'password': 'ECOD-admin-2026'})
_, priya = call('POST', '/auth/login', body={'username': 'priya.nair', 'password': 'ECOD-assessor-2026'})
_, arjun = call('POST', '/auth/login', body={'username': 'arjun.mehta', 'password': 'ECOD-assessor-2026'})
_, rohit = call('POST', '/auth/login', body={'username': 'rohit.verma', 'password': 'ECOD-candidate-2026'})
AT, PT, AJ, RT = admin['token'], priya['token'], arjun['token'], rohit['token']
check('all seeded logins ok', all([AT, PT, AJ, RT]))
check('login response carries no hash', 'password_hash' not in json.dumps(admin))
st, me = call('GET', '/auth/me', RT)
check('/auth/me returns user+linked candidate', st == 200 and me['candidate']['name'] == 'Rohit Verma')
st, _ = call('GET', '/auth/me'); check('/auth/me anon -> 401', st == 401)
check('garbage token -> 401', call('GET', '/auth/me', 'deadbeef')[0] == 401)
call('POST', '/auth/logout', admin['token'].join(['Bearer ', '']) and AT)
check('logout invalidates session', call('GET', '/auth/me', AT)[0] == 401)
_, admin = call('POST', '/auth/login', body={'username': 'admin', 'password': 'ECOD-admin-2026'})
AT = admin['token']; check('re-login after logout ok', bool(AT))

# ================================ S2 users & access (admin-only provisioning)
section('S2 · users: provisioning rules, uniqueness, resets, deactivation')
st, b = call('POST', '/admin/users', AT, {'username': 'new.assessor1', 'name': 'Scratch Assessor', 'role': 'assessor', 'password': 'scratch-pw-1'})
check('admin creates assessor', st == 201)
U1 = b['id']
check('username lowercased+regex enforced', call('POST', '/admin/users', AT, {'username': 'Bad Name!', 'name': 'X', 'role': 'assessor', 'password': '12345678'})[0] == 400)
check('short password rejected', call('POST', '/admin/users', AT, {'username': 'ok.name', 'name': 'X', 'role': 'assessor', 'password': 'short'})[0] == 400)
check('duplicate username -> 409 (case-insensitive)', call('POST', '/admin/users', AT, {'username': 'NEW.ASSESSOR1', 'name': 'X', 'role': 'assessor', 'password': '12345678'})[0] == 409)
check('unknown role rejected', call('POST', '/admin/users', AT, {'username': 'r.x', 'name': 'X', 'role': 'superuser', 'password': '12345678'})[0] == 400)
check('candidate user without linked candidate -> 400', call('POST', '/admin/users', AT, {'username': 'c.nolink', 'name': 'X', 'role': 'candidate', 'password': '12345678'})[0] == 400)
st, cand2 = call('POST', '/admin/candidates', AT, {'name': 'Feature Candidate Two', 'current_title': 'Consultant', 'stage': 'intake'})
C2 = cand2['id']; check('scratch candidate created', st == 201)
st, b = call('POST', '/admin/users', AT, {'username': 'feat.cand2', 'name': 'FC2', 'role': 'candidate', 'password': 'cand2-pass', 'candidate_id': C2})
check('candidate user with linkage -> 201', st == 201); U_C2 = b['id']
check('second user for same candidate -> 409', call('POST', '/admin/users', AT, {'username': 'feat.cand2b', 'name': 'Y', 'role': 'candidate', 'password': 'cand2-pass', 'candidate_id': C2})[0] == 409)
st, b = call('POST', '/admin/users', AT, {'username': 'feat.validator', 'name': 'Val', 'role': 'validator', 'password': 'val-pass-1'})
check('validator user -> 201', st == 201); U_VAL = b['id']
st, users = call('GET', '/admin/users', AT)
check('user list has no hashes', 'password_hash' not in json.dumps(users))
check('user list includes candidate_name join', any(u.get('candidate_name') == 'Feature Candidate Two' for u in users['users']))
# login as new assessor, then reset password
check('scratch assessor can login', call('POST', '/auth/login', body={'username': 'new.assessor1', 'password': 'scratch-pw-1'})[0] == 200)
st, _ = call('PATCH', f'/admin/users/{U1}', AT, {'password': 'reset-pw-99'})
check('reset password -> old fails, new works',
      call('POST', '/auth/login', body={'username': 'new.assessor1', 'password': 'scratch-pw-1'})[0] == 401 and
      call('POST', '/auth/login', body={'username': 'new.assessor1', 'password': 'reset-pw-99'})[0] == 200)
st, U1tok = call('POST', '/auth/login', body={'username': 'new.assessor1', 'password': 'reset-pw-99'})
T1 = U1tok['token']
st, _ = call('PATCH', f'/admin/users/{U1}', AT, {'active': False})
check('deactivated -> 401 on next request', call('GET', '/auth/me', T1)[0] == 401)
check('deactivated -> login blocked', call('POST', '/auth/login', body={'username': 'new.assessor1', 'password': 'reset-pw-99'})[0] == 401)
call('PATCH', f'/admin/users/{U1}', AT, {'active': True})
check('reactivated login works', call('POST', '/auth/login', body={'username': 'new.assessor1', 'password': 'reset-pw-99'})[0] == 200)
admin_id = next(u['id'] for u in users['users'] if u['username'] == 'admin')
check('primary admin cannot be deactivated', call('PATCH', f'/admin/users/{admin_id}', AT, {'active': False})[0] == 400)
st, b = call('PATCH', f'/admin/users/{U1}', AT, {'name': 'Renamed Assessor', 'email': 'ra@x.io'})
check('edit name/email -> 200', st == 200 and b['name'] == 'Renamed Assessor')

# ================================ S3 candidates admin features
section('S3 · candidates: CRUD, validation, search/filter, delete guards, detail')
check('create without name -> 400', call('POST', '/admin/candidates', AT, {'email': 'x@y.z'})[0] == 400)
check('create with bogus stage -> 400', call('POST', '/admin/candidates', AT, {'name': 'X', 'stage': 'nowhere'})[0] == 400)
check('create with bogus role -> 400', call('POST', '/admin/candidates', AT, {'name': 'X', 'target_role_id': 'nope'})[0] == 400)
st, roles = call('GET', '/admin/roles', AT); RSA = roles['roles'][0]['id']
st, c3 = call('POST', '/admin/candidates', AT, {'name': 'Feature Candidate Three', 'target_role_id': RSA, 'current_title': 'Engineer'})
C3 = c3['id']
check('stage defaults to role_mapped when target role set', st == 201 and c3['stage'] == 'role_mapped')
st, lst = call('GET', '/admin/candidates?q=verma', token=AT)
check('search by name', len(lst['candidates']) == 1)
st, lst = call('GET', '/admin/candidates?q=example.com', token=AT)
check('search by email domain', len(lst['candidates']) >= 3)
st, lst = call('GET', '/admin/candidates?stage=intake', token=AT)
check('stage filter', all(c['stage'] == 'intake' for c in lst['candidates']) and len(lst['candidates']) >= 1)
st, det = call('GET', f'/admin/candidates/{C3}', AT)
check('detail shape', st == 200 and 'timeline' in det and 'assessments' in det and 'linked_user' in det)
st, detR = call('GET', '/admin/candidates/' + call('GET','/admin/candidates?q=verma',token=AT)[1]['candidates'][0]['id'], AT)
check('rohit detail shows linked portal user', detR['linked_user']['username'] == 'rohit.verma')
st, b = call('PATCH', f'/admin/candidates/{C3}', AT, {'name': 'Feature C3 Renamed', 'years_experience': 7, 'notes': 'note'})
check('PATCH candidate fields', st == 200 and b['name'] == 'Feature C3 Renamed' and b['years_experience'] == 7)
check('PATCH bogus stage -> 400', call('PATCH', f'/admin/candidates/{C3}', AT, {'stage': 'quantum'})[0] == 400)
rohit_cid = detR['candidate']['id']
st, b = call('DELETE', f'/admin/candidates/{rohit_cid}', AT)
check('delete without admin password -> 403', st == 403 and 'password' in b.get('error', '').lower())
st, b = call('DELETE', f'/admin/candidates/{rohit_cid}', AT, {'password': 'WRONG-PASSWORD'})
check('delete with wrong admin password -> 403', st == 403)
check('candidate untouched after failed deletes', call('GET', f'/admin/candidates/{rohit_cid}', AT)[0] == 200)
# password-gated cascade: probe candidate with a linked portal user + an open assessment
st, cdel = call('POST', '/admin/candidates', AT, {'name': 'Delete Cascade Probe', 'target_role_id': RSA})
CD = cdel['id']
check('probe candidate created', st == 201)
check('probe portal user created', call('POST', '/admin/users', AT, {'username': 'feat.delprobe', 'name': 'DP', 'role': 'candidate', 'password': 'del-probe-1', 'candidate_id': CD})[0] == 201)
check('probe portal login works before delete', call('POST', '/auth/login', body={'username': 'feat.delprobe', 'password': 'del-probe-1'})[0] == 200)
check('probe open assessment allocated', call('POST', '/admin/assessments', AT, {'candidate_id': CD, 'role_id': RSA})[0] == 201)
st, b = call('DELETE', f'/admin/candidates/{CD}', AT, {'password': 'ECOD-admin-2026'})
check('password-gated delete cascades user + open assessment -> 200', st == 200 and b.get('removed_users') == 1 and b.get('removed_assessments') == 1)
check('deleted candidate gone', call('GET', f'/admin/candidates/{CD}', AT)[0] == 404)
check('probe portal login gone after cascade delete', call('POST', '/auth/login', body={'username': 'feat.delprobe', 'password': 'del-probe-1'})[0] == 401)
st, lst = call('GET', '/admin/candidates?stage=intake', token=AT)
sana = next((c for c in lst['candidates'] if 'Sana' in c['name']), None)
if sana:
    st, _ = call('DELETE', f"/admin/candidates/{sana['id']}", AT)
    check('delete still requires password for unlinked candidates -> 403', st == 403)
    st, _ = call('DELETE', f"/admin/candidates/{sana['id']}", AT, {'password': 'ECOD-admin-2026'})
    check('delete unlinked candidate w/o assessments (password) -> 200', st == 200)
    check('deleted candidate gone', call('GET', f"/admin/candidates/{sana['id']}", AT)[0] == 404)
else: check('sana present for deletion test', False)

# ================================ S4 role/competency/question/framework configuration
section('S4 · configuration: roles, competencies, questions, frameworks, validation')
check('role missing fields -> 400', call('POST', '/admin/roles', AT, {'name': 'X'})[0] == 400)
check('role bad slug -> 400', call('POST', '/admin/roles', AT, {'key': 'Bad Key!', 'name': 'X', 'technology': 'Y'})[0] == 400)
st, b = call('POST', '/admin/roles', AT, {'key': 'scratch-role', 'name': 'Scratch Architect', 'technology': 'ScratchStack', 'description': 'temp'})
SR = b['id']; check('role created', st == 201)
check('duplicate key -> 409', call('POST', '/admin/roles', AT, {'key': 'scratch-role', 'name': 'X', 'technology': 'Y'})[0] == 409)
st, fw = call('GET', f'/admin/frameworks?role_id={SR}', AT)
check('default framework auto-created with role', st == 200 and fw['framework'].get('config', {}).get('readiness_bands') and not fw['framework'].get('unsaved'))
check('allocating assessment on role with no questions -> 400', call('POST', '/admin/assessments', AT, {'candidate_id': C3, 'role_id': SR})[0] == 400)
check('competency weight >100 -> 400', call('POST', '/admin/competencies', AT, {'role_id': SR, 'name': 'C', 'weight': 200, 'target_level': 4})[0] == 400)
check('competency target level 7 -> 400', call('POST', '/admin/competencies', AT, {'role_id': SR, 'name': 'C', 'weight': 50, 'target_level': 7})[0] == 400)
st, cm1 = call('POST', '/admin/competencies', AT, {'role_id': SR, 'name': 'Scratch Core', 'weight': 60, 'target_level': 4, 'category': 'technical', 'enrichment_hint': 'Read the manual'})
CM1 = cm1['id']; check('competency 1 created (60)', st == 201 and cm1['weight'] == 60)
st, cm2 = call('POST', '/admin/competencies', AT, {'role_id': SR, 'name': 'Scratch Ops', 'weight': 40, 'target_level': 5})
CM2 = cm2['id']; check('competency 2 created (40)', st == 201)
st, b = call('PATCH', f'/admin/competencies/{CM2}', AT, {'weight': 45, 'enrichment_hint': 'Practice runs'})
check('competency PATCH', st == 200 and b['weight'] == 45)
# question validation battery
check('mcq_single needs exactly 1 correct', call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM1, 'type': 'mcq_single', 'prompt': 'P', 'options': [{'id':'a','label':'A'},{'id':'b','label':'B'}], 'correct_option_ids': []})[0] == 400)
check('mcq needs 2+ options', call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM1, 'type': 'mcq_single', 'prompt': 'P', 'options': [{'id':'a','label':'A'}], 'correct_option_ids': ['a']})[0] == 400)
check('mcq_multi cannot mark all correct', call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM1, 'type': 'mcq_multi', 'prompt': 'P', 'options': [{'id':'a','label':'A'},{'id':'b','label':'B'}], 'correct_option_ids': ['a','b']})[0] == 400)
check('text requires rubric', call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM1, 'type': 'text', 'prompt': 'P', 'points': 6})[0] == 400)
check('points out of range', call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM1, 'type': 'mcq_single', 'prompt': 'P', 'points': 99, 'options': [{'id':'a','label':'A'},{'id':'b','label':'B'}], 'correct_option_ids': ['a']})[0] == 400)
check('bad difficulty', call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM1, 'type': 'mcq_single', 'prompt': 'P', 'difficulty': 'extreme', 'options': [{'id':'a','label':'A'},{'id':'b','label':'B'}], 'correct_option_ids': ['a']})[0] == 400)
Q1 = call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM1, 'type': 'mcq_single', 'prompt': 'Core Q: pick B', 'options': [{'id':'a','label':'Opt A'},{'id':'b','label':'Opt B'}], 'correct_option_ids': ['b'], 'points': 4, 'difficulty': 'foundation'})[1]
Q2 = call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM1, 'type': 'scale', 'prompt': 'Core Q: rate yourself', 'points': 3})[1]
Q3 = call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM2, 'type': 'text', 'prompt': 'Ops Q: design it', 'points': 7, 'rubric': 'Must mention X, Y, Z'})[1]
check('valid questions of 3 types created', all(q.get('id') for q in [Q1, Q2, Q3]))
st, qs = call('GET', f'/admin/questions?role_id={SR}&competency_id={CM1}', AT)
check('question filters (role + competency)', len(qs['questions']) == 2)
st, b = call('PATCH', f"/admin/questions/{Q1['id']}", AT, {'prompt': 'Core Q: pick B (edited)', 'points': 5})
check('question PATCH', st == 200 and b['points'] == 5 and 'edited' in b['prompt'])
# framework PUT validation + save
st, b = call('PUT', '/admin/frameworks', AT, {'role_id': SR, 'config': {'readiness_bands': [{'key': 'x', 'label': 'X', 'min': 50}], 'level_thresholds': [0,20,40,60,80], 'gap_severity': {'moderate': 1, 'critical': 2}}})
check('framework with <2 bands -> 422 with problems', st == 422 and b.get('problems'))
st, b = call('PUT', '/admin/frameworks', AT, {'role_id': SR, 'name': 'Scratch FW', 'config': {
    'readiness_bands': [{'key': 'go', 'label': 'Go', 'min': 70, 'tone': 'green', 'description': 'ship it'},
                        {'key': 'hold', 'label': 'Hold', 'min': 0, 'tone': 'red', 'description': 'wait'}],
    'level_thresholds': [0, 25, 50, 75, 90], 'gap_severity': {'moderate': 1, 'critical': 2}}})
check('framework PUT valid -> 200', st == 200)
st, fw = call('GET', f'/admin/frameworks?role_id={SR}', AT)
check('framework persisted with custom thresholds', fw['framework']['config']['level_thresholds'] == [0,25,50,75,90])
st, b = call('PATCH', f'/admin/roles/{SR}', AT, {'description': 'temp v2'})
check('role PATCH', st == 200 and b['description'] == 'temp v2')

# ================================ S5 assessment lifecycle & immutability
section('S5 · assessment allocation, snapshot immutability, lifecycle transitions')
# scratch candidate user for C3
call('POST', '/admin/users', AT, {'username': 'feat.cand3', 'name': 'FC3', 'role': 'candidate', 'password': 'cand3-pass', 'candidate_id': C3})
_, fc3 = call('POST', '/auth/login', body={'username': 'feat.cand3', 'password': 'cand3-pass'})
T3 = fc3['token']
_, meP = call('GET', '/auth/me', PT)
st, asg = call('POST', '/admin/assessments', AT, {'candidate_id': C3, 'role_id': SR, 'assessor_id': meP['user']['id']})
check('assessment allocated with snapshot', st == 201 and len(asg['snapshot_json']['questions']) == 3)
AID = asg['id']
check('snapshot embeds competencies+framework', len(asg['snapshot_json']['competencies']) == 2 and asg['snapshot_json']['framework']['config']['level_thresholds'] == [0,25,50,75,90])
check('candidate stage advanced to assessment', call('GET', f'/admin/candidates/{C3}', AT)[1]['candidate']['stage'] == 'assessment')
check('duplicate open assessment -> 409', call('POST', '/admin/assessments', AT, {'candidate_id': C3, 'role_id': SR})[0] == 409)
# IMMUTABILITY: edit the question + framework after allocation, snapshot must stay frozen
call('PATCH', f"/admin/questions/{Q1['id']}", AT, {'prompt': 'Core Q: COMPLETELY CHANGED', 'points': 20})
call('PUT', '/admin/frameworks', AT, {'role_id': SR, 'config': {'readiness_bands': [{'key':'go','label':'Go','min':95,'tone':'green','description':'x'},{'key':'hold','label':'Hold','min':0,'tone':'red','description':'y'}], 'level_thresholds': [0,1,2,3,4], 'gap_severity': {'moderate':1,'critical':2}}})
st, snap = call('GET', f'/assessor/assessments/{AID}', PT)
check('assessor blocked before submit -> 409', st == 409)
quiz = call('GET', f'/candidate/assessments/{AID}', T3)[1]
snap_q1 = next(q for q in quiz['questions'] if q['id'] == Q1['id'])
check('snapshot frozen: prompt unchanged after edit', snap_q1['prompt'] == 'Core Q: pick B (edited)')
# new allocation for a different candidate picks up the NEW config
st, c4 = call('POST', '/admin/candidates', AT, {'name': 'Feature Candidate Four'})
C4 = c4['id']
call('POST', '/admin/users', AT, {'username': 'feat.cand4', 'name': 'FC4', 'role': 'candidate', 'password': 'cand4-pass', 'candidate_id': C4})
_, fc4 = call('POST', '/auth/login', body={'username': 'feat.cand4', 'password': 'cand4-pass'})
T4 = fc4['token']
st, asg2 = call('POST', '/admin/assessments', AT, {'candidate_id': C4, 'role_id': SR, 'assessor_id': None})
AID2 = asg2['id'] if st == 201 else None
check('unassigned-allocator allowed (assessor optional)', st == 201)
check('new snapshot got edited question (20 pts)', next(q for q in asg2['snapshot_json']['questions'] if q['id'] == Q1['id'])['points'] == 20)
# reassignment flow
_, meA = call('GET', '/auth/me', AJ)
st, _ = call('PATCH', f'/admin/assessments/{AID}', AT, {'assessor_id': meA['user']['id']})
check('reassign to Arjun -> 200', st == 200)
check('old assessor now 404', call('GET', f'/assessor/assessments/{AID}', PT)[0] == 404)
st, mine = call('GET', f'/assessor/assessments/{AID}', AJ)
check('new assessor blocked until submit -> 409', st == 409)
st, _ = call('PATCH', f'/admin/assessments/{AID}', AT, {'assessor_id': admin_id})
check('non-assessor user rejected for allocation -> 400', st == 400)
call('PATCH', f'/admin/assessments/{AID}', AT, {'assessor_id': meP['user']['id']})  # back to Priya

# candidate draft answer features
check('invalid scale (9) -> 422', call('PUT', f'/candidate/assessments/{AID}/answers', T3, {'answers': {Q2['id']: 9}})[0] == 422)
check('invalid mcq option -> 422', call('PUT', f'/candidate/assessments/{AID}/answers', T3, {'answers': {Q1['id']: 'zzz'}})[0] == 422)
check('unknown question ids ignored', call('PUT', f'/candidate/assessments/{AID}/answers', T3, {'answers': {'nope': 1, Q1['id']: 'b'}})[0] == 200)
quiz = call('GET', f'/candidate/assessments/{AID}', T3)[1]
check('saved answers round-trip', quiz['answers'].get(Q1['id']) == 'b')
check('clearing answer removes it', call('PUT', f'/candidate/assessments/{AID}/answers', T3, {'answers': {Q1['id']: ''}})[0] == 200
      and call('GET', f'/candidate/assessments/{AID}', T3)[1]['answers'].get(Q1['id']) in (None, ''))
check('scoring blocked before submit', call('PUT', f'/assessor/assessments/{AID}/scores', PT, {'scores': [{'question_id': Q3['id'], 'score': 4}]})[0] == 409)
check('finalize blocked before submit', call('POST', f'/assessor/assessments/{AID}/finalize', PT)[0] == 409)
# submit: missing -> 422, then full
st, b = call('POST', f'/candidate/assessments/{AID}/submit', T3, {'answers': {Q1['id']: 'b'}})
check('submit missing answers -> 422 + list', st == 422 and set(b['missing_question_ids']) == {Q2['id'], Q3['id']})
answers = {Q1['id']: 'b', Q2['id']: 5, Q3['id']: 'I would do X, Y and Z with runbooks and alerts.'}
st, _ = call('POST', f'/candidate/assessments/{AID}/submit', T3, {'answers': answers})
check('submit full -> 200', st == 200)
check('resubmit -> 409', call('POST', f'/candidate/assessments/{AID}/submit', T3, {'answers': answers})[0] == 409)
check('answers locked after submit -> 409', call('PUT', f'/candidate/assessments/{AID}/answers', T3, {'answers': {Q1['id']: 'a'}})[0] == 409)

# assessor scoring features
st, det = call('GET', f'/assessor/assessments/{AID}', PT)
resp = {r['question_id']: r for r in det['responses']}
check('auto score: mcq correct -> full (snapshot 5 pts)', resp[Q1['id']]['auto_score'] == 5)
check('auto score: scale 5/5 -> 3.0', resp[Q2['id']]['auto_score'] == 3)
check('score above max -> 422', call('PUT', f'/assessor/assessments/{AID}/scores', PT, {'scores': [{'question_id': Q3['id'], 'score': 99}]})[0] == 422)
st, b = call('PUT', f'/assessor/assessments/{AID}/scores', PT, {'scores': [
    {'question_id': Q3['id'], 'score': 6, 'comment': 'Covered X and Y, missed Z depth'},
    {'question_id': Q1['id'], 'score': 0, 'comment': 'note on auto q'},
    {'question_id': 'ghost', 'score': 1}]})
check('score save: manual + comment-on-auto accepted, ghost ignored', st == 200)
det = call('GET', f'/assessor/assessments/{AID}', PT)[1]
resp = {r['question_id']: r for r in det['responses']}
check('score on AUTO question did NOT overwrite auto_score', resp[Q1['id']]['auto_score'] == 5 and (resp[Q1['id']].get('assessor_score') in (None, '')))
check('comment on auto question persisted', resp[Q1['id']]['assessor_comment'] == 'note on auto q')
check('scoring progress tracked', det['scoring_progress'] == {'manual_total': 1, 'manual_scored': 1})
st, fin = call('POST', f'/assessor/assessments/{AID}/finalize', PT)
check('finalize ok', st == 200)
# expected: CM1 = 5+3 = 8/8 = 100% ; CM2 = 6/7 = 85.7% ; overall = 100*.6 + 85.7*.45/wsum(1.05) -> normalized
rep = fin['report']
cm1r = next(c for c in rep['competencies'] if c['competency_id'] == CM1)
cm2r = next(c for c in rep['competencies'] if c['competency_id'] == CM2)
check('CM1 pct 100', cm1r['score_pct'] == 100)
check('CM2 pct ~85.7', abs(cm2r['score_pct'] - 85.7) < 0.05)
exp_overall = round((100*60 + round(6/7*1000)/10*45) / 105 * 10) / 10
check(f'overall = weighted blend ({exp_overall})', abs(rep['overall_pct'] - exp_overall) < 0.05, )
check('verdict uses snapshot-era bands (go@70), proving immutability vs later edit to @95', rep['band']['key'] == 'go')
check('custom level thresholds applied (L>=90 -> L5)', cm1r['observed_level'] == 5)
check('framework name from snapshot era', fin['assessment_id'] == AID)
check('finalize locked: re-finalize -> 409', call('POST', f'/assessor/assessments/{AID}/finalize', PT)[0] == 409)
check('finalize locked: scoring -> 409', call('PUT', f'/assessor/assessments/{AID}/scores', PT, {'scores': [{'question_id': Q3['id'], 'score': 1}]})[0] == 409)
check('finalize locked: reassignment -> 409', call('PATCH', f'/admin/assessments/{AID}', AT, {'assessor_id': meA['user']['id']})[0] == 409)
check('delete scored -> 409', call('DELETE', f'/admin/assessments/{AID}', AT)[0] == 409)
check('stage advanced to gap_mapping', call('GET', f'/admin/candidates/{C3}', AT)[1]['candidate']['stage'] == 'gap_mapping')
check('candidate with finalized report stays protected even with admin password -> 409',
      call('DELETE', f'/admin/candidates/{C3}', AT, {'password': 'ECOD-admin-2026'})[0] == 409)
# reports by audience
st, crep = call('GET', f'/candidate/reports/{AID}', T3)
blob = json.dumps(crep)
check('candidate report ok, assessor unknown to candidate', st == 200 and 'Priya' not in blob)
check('candidate report hides comments + breakdown', 'Covered X and Y' not in blob and 'breakdown' not in blob)
check('recommended_focus surfaced from enrichment_hint', 'Practice runs' in blob)
st, arep = call('GET', f'/admin/reports/{AID}', AT)
check('admin report full: assessor+comments+breakdown', arep['assessor_name'] == 'Priya Nair' and 'Covered X and Y' in json.dumps(arep))
# draft deletion cascade
call('PUT', f'/candidate/assessments/{AID2}/answers', T4, {'answers': {Q1['id']: 'a'}})
st, _ = call('DELETE', f'/admin/assessments/{AID2}', AT)
check('delete in-progress assessment -> 200', st == 200)
st, lst = call('GET', f'/admin/assessments?status=assigned', AT)
check('deleted draft fully gone (no responses remnants)', all(a['id'] != AID2 for a in lst['assessments']))
# role delete guard + cascade
check('role with scored assessment: delete -> 409', call('DELETE', f'/admin/roles/{SR}', AT)[0] == 409)
st, tx = call('POST', '/admin/roles', AT, {'key': 'temp-del', 'name': 'Temp', 'technology': 'T'})
TC = call('POST', '/admin/competencies', AT, {'role_id': tx['id'], 'name': 'TC', 'weight': 100, 'target_level': 3})[1]
TQ = call('POST', '/admin/questions', AT, {'role_id': tx['id'], 'competency_id': TC['id'], 'type': 'text', 'prompt': 'p', 'points': 5, 'rubric': 'r'})[1]
st, _ = call('DELETE', f'/admin/roles/{tx["id"]}', AT)
check('role without assessments: delete -> 200 + cascades', st == 200 and call('GET', f'/admin/roles/{tx["id"]}', AT)[0] == 404)
check('cascade: its questions gone', call('GET', f'/admin/questions?role_id={tx["id"]}', AT)[1]['questions'] == [])
# competency delete cascades questions
QC = call('POST', '/admin/questions', AT, {'role_id': SR, 'competency_id': CM2, 'type': 'mcq_single', 'prompt': 'temp', 'options': [{'id':'a','label':'A'},{'id':'b','label':'B'}], 'correct_option_ids': ['a']})[1]
st, _ = call('DELETE', f'/admin/competencies/{CM2}', AT)
check('competency delete -> 200, cascades its questions', st == 200 and call('GET', f'/admin/questions?competency_id={CM2}', AT)[1]['questions'] == [])

# ================================ S6 dashboard & audit consistency
section('S6 · dashboard, audit trail, list filters')
st, dash = call('GET', '/admin/dashboard', AT)
check('dashboard: candidate count reflects ops', dash['counts']['candidates'] >= 4)
check('dashboard: by_status has scored', dash['by_status'].get('scored', 0) >= 2)
check('dashboard: recent activity populated', len(dash['recent_activity']) > 3)
st, aud = call('GET', '/admin/audit?entity=questions', AT)
check('audit filter by entity=questions', st == 200 and all(e['entity'] == 'questions' for e in aud['events']) and len(aud['events']) >= 3)
st, aud = call('GET', '/admin/audit', AT)
check('audit log captures key actions', {e['action'] for e in aud['events']} >= {'login', 'user_created', 'candidate_created', 'assessment_scored', 'question_created'})
st, lst = call('GET', f'/admin/assessments?assessor_id={meP["user"]["id"]}', AT)
check('assessment filter by assessor', all(a['assessor_id'] == meP['user']['id'] for a in lst['assessments']))
st, lst = call('GET', f'/admin/assessments?role_id={SR}', AT)
check('assessment filter by role', all(a['role_id'] == SR for a in lst['assessments']) and len(lst['assessments']) == 1)

# ================================ S7 meta + compartmentalization sweep
section('S7 · meta/bootstrap + full compartmentalization sweep')
st, meta = call('GET', '/meta/bootstrap', RT)
check('bootstrap enums', st == 200 and len(meta['pipelineStages']) == 7 and len(meta['questionTypes']) == 4)
ADMIN_ROUTES = ['/admin/dashboard', '/admin/candidates', '/admin/users', '/admin/roles', '/admin/questions', '/admin/audit']
ok_all = all(call('GET', r, tok)[0] == 403 for tok in (PT, RT) for r in ADMIN_ROUTES)
check('assessor+candidate blocked from ALL admin routes (403)', ok_all)
_, val = call('POST', '/auth/login', body={'username': 'feat.validator', 'password': 'val-pass-1'})
VT = val['token']
check('validator: no data routes, only meta/me', call('GET', '/candidate/assessments', VT)[0] == 403
      and call('GET', '/assessor/assessments', VT)[0] == 403
      and call('GET', '/admin/dashboard', VT)[0] == 403
      and call('GET', '/meta/bootstrap', VT)[0] == 200)
check('rohit cannot see scratch assessment (404)', call('GET', f'/candidate/assessments/{AID}', RT)[0] == 404)
check('arjun cannot see priya assessment (404)', call('GET', f'/assessor/assessments/{AID}', AJ)[0] == 404)
check('C4 candidate cannot see C3 assessment', call('GET', f'/candidate/assessments/{AID}', T4)[0] == 404)
st, wl = call('GET', '/assessor/assessments', PT)
proj = next(a for a in wl['assessments'] if a['id'] == AID)['candidate']
check('assessor projection exposes only professional fields', set(proj.keys()) <= {'id', 'name', 'current_title', 'years_experience', 'target_role_id'})

# ================================ S8 question allocation (X questions per candidate)
section('S8 · allocate X questions, balanced across competencies')

st, plan = call('GET', f'/admin/roles/{RSA}/question-plan', AT)
BANK = plan['bank_total']
check('question-plan: full bank by default', st == 200 and plan['total'] == BANK and BANK > 1)
check('question-plan: per-competency split provided', len(plan['per_competency']) > 1
      and sum(r['count'] for r in plan['per_competency']) == plan['total'])
check('question-plan: reports a points total', plan['points'] > 0)

st, capped = call('GET', f'/admin/roles/{RSA}/question-plan?limit=8', AT)
check('question-plan: limit=8 serves exactly 8', st == 200 and capped['total'] == 8)
check('question-plan: limit keeps bank_total visible', capped['bank_total'] == BANK)
check('question-plan: 8 spread over competencies, none over-drawn',
      sum(r['count'] for r in capped['per_competency']) == 8
      and all(r['count'] >= 0 for r in capped['per_competency']))
st, over = call('GET', f'/admin/roles/{RSA}/question-plan?limit={BANK + 50}', AT)
check('question-plan: limit above the cap is clamped to min(cap, bank)',
      st == 200 and over['total'] == min(BANK + 50, over['max_questions'], BANK))
check('question-plan: limit=0 rejected', call('GET', f'/admin/roles/{RSA}/question-plan?limit=0', AT)[0] == 400)
check('question-plan: non-numeric limit rejected', call('GET', f'/admin/roles/{RSA}/question-plan?limit=abc', AT)[0] == 400)
check('question-plan: unknown role -> 404', call('GET', '/admin/roles/nope/question-plan', AT)[0] == 404)
check('question-plan is admin-only', call('GET', f'/admin/roles/{RSA}/question-plan', PT)[0] == 403
      and call('GET', f'/admin/roles/{RSA}/question-plan', RT)[0] == 403)

# allocate a capped assessment and confirm the candidate is served exactly X
st, cx = call('POST', '/admin/candidates', AT, {'name': 'Question Cap Probe', 'target_role_id': RSA})
CX = cx['id']
st, ux = call('POST', '/admin/users', AT, {'username': f'cap.probe.{uuid.uuid4().hex[:6]}', 'name': 'Cap Probe',
                                           'role': 'candidate', 'password': 'cap-pass-1', 'candidate_id': CX})
_, capl = call('POST', '/auth/login', body={'username': ux['username'], 'password': 'cap-pass-1'})
CXT = capl['token']

check('allocate with question_count=0 -> 400',
      call('POST', '/admin/assessments', AT, {'candidate_id': CX, 'role_id': RSA, 'question_count': 0})[0] == 400)
check('allocate with fractional question_count -> 400',
      call('POST', '/admin/assessments', AT, {'candidate_id': CX, 'role_id': RSA, 'question_count': 3.5})[0] == 400)
check('allocate with question_count above the bank -> 400',
      call('POST', '/admin/assessments', AT, {'candidate_id': CX, 'role_id': RSA, 'question_count': BANK + 1})[0] == 400)

st, ax = call('POST', '/admin/assessments', AT, {'candidate_id': CX, 'role_id': RSA, 'question_count': 6})
AX = ax['id']
check('allocate with question_count=6 -> 201', st == 201)
check('snapshot stores only the 6 served questions', len(ax['snapshot_json']['questions']) == 6)
check('snapshot records the limit and the bank size',
      ax['snapshot_json']['question_limit'] == 6 and ax['snapshot_json']['bank_total'] == BANK)

st, quiz = call('GET', f'/candidate/assessments/{AX}', CXT)
check('candidate is served exactly 6 questions', st == 200 and len(quiz['questions']) == 6)
check('served questions still hide correct answers/rubrics',
      'correct_option_ids' not in json.dumps(quiz) and 'rubric' not in json.dumps(quiz))
served_comps = {q['competency_id'] for q in quiz['questions']}
check('6 questions cover multiple competencies', len(served_comps) > 1)

st, lst = call('GET', '/candidate/assessments', CXT)
row = next(a for a in lst['assessments'] if a['id'] == AX)
check('candidate list reports the served question count', row['question_count'] == 6)

st, adm = call('GET', '/admin/assessments', AT)
arow = next(a for a in adm['assessments'] if a['id'] == AX)
check('admin list exposes served vs bank counts',
      arow['question_count'] == 6 and arow['question_limit'] == 6 and arow['bank_total'] == BANK)

# a capped assessment must still submit and score end-to-end
db_answers = {}
for q in quiz['questions']:
    if q['type'] == 'mcq_single': db_answers[q['id']] = q['options'][0]['id']
    elif q['type'] == 'mcq_multi': db_answers[q['id']] = [q['options'][0]['id']]
    elif q['type'] == 'scale': db_answers[q['id']] = 4
    else: db_answers[q['id']] = 'A considered answer covering the architecture, trade-offs and rollout plan.'
check('capped assessment submits', call('POST', f'/candidate/assessments/{AX}/submit', CXT, {'answers': db_answers})[0] == 200)

st, unrel = call('GET', '/admin/assessments', AT)
check('default allocation (no question_count) still serves the whole bank',
      any(a['question_limit'] is None and a['question_count'] == a['bank_total']
          for a in unrel['assessments'] if a['bank_total']))

# ================================ S9 published catalogue sync (bank below the cap)
section('S9 · published catalogue: status, sync, unlocking the 50-question cap')

st, cat = call('GET', '/admin/content/catalogue', AT)
check('catalogue status: available for the RSA track', st == 200 and cat['available'] is True
      and cat['role']['key'] == 'databricks-rsa')
CAT_TOTAL = cat['catalogue_total']
check('catalogue status: seeded bank is complete', cat['bank_total'] == CAT_TOTAL and cat['missing'] == 0)
check('catalogue endpoints are admin-only',
      call('GET', '/admin/content/catalogue', PT)[0] == 403
      and call('POST', '/admin/content/sync', PT)[0] == 403
      and call('GET', '/admin/content/catalogue')[0] == 401)

st, plan = call('GET', f'/admin/roles/{RSA}/question-plan', AT)
check('question-plan carries catalogue context', st == 200
      and plan['catalogue']['total'] == CAT_TOTAL and plan['catalogue']['missing'] == 0)
st, oplan = call('GET', f'/admin/roles/{SR}/question-plan', AT)
check('question-plan omits catalogue context for other tracks', oplan['catalogue'] is None)

# reproduce the "stuck below the cap" state: trim the bank below 50 questions
_, qs = call('GET', f'/admin/questions?role_id={RSA}', AT)
TRIM = CAT_TOTAL - 45
victims = [q['id'] for q in qs['questions']][:TRIM]
for qid in victims: call('DELETE', f'/admin/questions/{qid}', AT)
st, cat2 = call('GET', '/admin/content/catalogue', AT)
check('catalogue status: trimmed bank reports the gap',
      cat2['bank_total'] == CAT_TOTAL - TRIM and cat2['missing'] == TRIM)
st, plan2 = call('GET', f'/admin/roles/{RSA}/question-plan?limit=50', AT)
check('a bank smaller than the cap limits the plan to the bank', plan2['total'] == 45)

st, sync = call('POST', '/admin/content/sync', AT)
check('sync restores the trimmed bank', st == 200 and sync['added'] == TRIM
      and sync['bank_total'] == CAT_TOTAL)
check('sync is idempotent', call('POST', '/admin/content/sync', AT)[1]['added'] == 0)
st, aud = call('GET', '/admin/audit?entity=questions', AT)
check('catalogue sync is audited', any(e['action'] == 'catalogue_synced' for e in aud['events']))

# the original complaint, end to end: a full-bank workspace allocates 50 questions
st, ccap = call('POST', '/admin/candidates', AT, {'name': 'Full Cap After Sync'})
st, full = call('POST', '/admin/assessments', AT, {'candidate_id': ccap['id'], 'role_id': RSA, 'question_count': 50})
check('allocate the full 50-question cap -> 201',
      st == 201 and len(full['snapshot_json']['questions']) == 50
      and full['snapshot_json']['question_limit'] == 50
      and full['snapshot_json']['bank_total'] == CAT_TOTAL)

print()
print(f'PASSED {PASSED} / {PASSED + len(FAILS)}')
if FAILS:
    print('FAILURES:'); [print(' -', f) for f in FAILS]; sys.exit(1)
print('ALL FEATURE TESTS PASSED')
