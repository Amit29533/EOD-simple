const generatedPasswords = new Set();

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0].normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
}

function randomNumber(max, crypto = globalThis.crypto) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % max;
}

export function uniqueUsername(name, users = [], crypto = globalThis.crypto) {
  const prefix = firstName(name);
  const taken = new Set(users.map((u) => String(u.username).toLowerCase()));
  const initial = randomNumber(10_000, crypto);
  for (let n = 0; n < 10_000; n++) {
    const value = prefix + String((initial + n) % 10_000).padStart(4, '0');
    if (!taken.has(value)) return value;
  }
  // Keep the first name even when every four-digit suffix is occupied.
  let suffix = 10_000;
  while (taken.has(prefix + suffix)) suffix++;
  return prefix + suffix;
}

export function generatePassword(name = '', crypto = globalThis.crypto) {
  const prefix = firstName(name);
  const digits = Math.max(4, 7 - prefix.length);
  const initial = randomNumber(10 ** digits, crypto);
  let suffix = initial;
  let value = prefix + '#' + String(suffix).padStart(digits, '0');
  while (generatedPasswords.has(value)) {
    suffix++;
    value = prefix + '#' + String(suffix).padStart(digits, '0');
  }
  generatedPasswords.add(value);
  return value;
}

export function wireAccountForm(el, { candidates = [], users = [], roles = [], create = false } = {}) {
  const form = el.querySelector('form');
  const field = (name) => form.elements[name];
  const copy = async (text, button) => {
    if (!text) { button.textContent = 'Nothing to copy yet'; return; }
    try {
      await el.ownerDocument.defaultView.navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy unavailable — select the field to copy';
    }
  };
  const addButton = (input, text, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn secondary sm';
    button.textContent = text;
    button.onclick = (e) => { e.preventDefault(); action(button); };
    input.parentElement.append(button);
    return button;
  };
  const password = field('password');
  let generateVisiblePassword;
  if (password) {
    const toggle = addButton(password, 'Show password', (b) => {
      password.type = password.type === 'password' ? 'text' : 'password';
      b.textContent = password.type === 'text' ? 'Hide password' : 'Show password';
      b.setAttribute('aria-pressed', String(password.type === 'text'));
    });
    generateVisiblePassword = () => {
      password.value = generatePassword(field('name')?.value || el.dataset.accountName || 'user');
      password.type = 'text';
      toggle.textContent = 'Hide password';
      toggle.setAttribute('aria-pressed', 'true');
      password.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
    };
    addButton(password, 'Generate password', generateVisiblePassword);
    const copyPassword = addButton(password, 'Copy password', (button) => copy(password.value, button));
    password.addEventListener('input', () => { copyPassword.textContent = 'Copy password'; });
  }
  if (!create) return;
  const username = field('username');
  const generateUsername = () => {
    username.value = uniqueUsername(field('name').value, users);
    username.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
  };
  addButton(username, 'Generate username', generateUsername);
  const copyUsername = addButton(username, 'Copy username', (button) => copy(username.value, button));
  username.addEventListener('input', () => { copyUsername.textContent = 'Copy username'; });
  const linked = field('candidate_id');
  const allocationHelp = el.querySelector('#fm-help-auto_allocate');
  const updateAllocation = () => {
    const candidate = candidates.find((c) => c.id === linked.value);
    const role = roles.find((r) => r.id === candidate?.target_role_id);
    field('auto_allocate').closest('label').querySelector('span').textContent = role
      ? `Auto-allocate: ${role.name} (default: ${role.default_question_count} questions)`
      : 'Auto-allocate the role’s default assessment';
    if (!allocationHelp) return;
    allocationHelp.textContent = !candidate ? 'Link a candidate to see which exam will be allocated.'
      : !field('auto_allocate').checked ? 'Automatic allocation is off. Create the assessment later from the candidate record.'
      : !role ? 'No target exam is set for this candidate. Set their target role before auto-allocation.'
      : role.active === false ? `${role.name} is inactive; an exam will not be allocated.`
      : `Exam: ${role.name} · ${role.default_question_count} questions.${!field('assessor_id').value && !candidate.assessor_id ? ' No assessor selected; assign one before scoring.' : ''}`;
  };
  field('auto_allocate').addEventListener('change', updateAllocation);
  field('assessor_id').addEventListener('change', updateAllocation);
  linked.addEventListener('change', () => {
    const candidate = candidates.find((c) => c.id === linked.value);
    updateAllocation();
    if (!candidate) return;
    field('name').value = candidate.name || '';
    field('email').value = candidate.email || '';
    generateUsername();
    generateVisiblePassword?.();
    updateAllocation();
    ['name', 'email'].forEach((name) => field(name).dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true })));
  });
  const syncRole = () => {
    const isCandidate = field('role').value === 'candidate';
    linked.required = isCandidate;
    linked.setAttribute('aria-required', String(isCandidate));
    ['candidate_id', 'auto_allocate', 'assessor_id'].forEach((name) => {
      const input = field(name);
      input.disabled = !isCandidate;
      input.closest('label').hidden = !isCandidate;
      const help = el.querySelector(`#fm-help-${name}`);
      if (help) help.hidden = !isCandidate;
    });
  };
  field('role').addEventListener('change', syncRole);
  syncRole();
  updateAllocation();
}
