export function uniqueUsername(name, users = [], now = new Date()) {
  const words = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) || ['candidate'];
  const base = `${words[0]}.${words.length > 1 ? words.at(-1) + '.' : ''}${now.toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const taken = new Set(users.map((u) => String(u.username).toLowerCase()));
  let value = base;
  for (let n = 2; taken.has(value); n++) value = `${base}.${n}`;
  return value;
}

export function generatePassword(crypto = globalThis.crypto) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function wireAccountForm(el, { candidates = [], users = [], create = false } = {}) {
  const form = el.querySelector('form');
  const field = (name) => form.elements[name];
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
  if (password) {
    const toggle = addButton(password, 'Show password', (b) => {
      password.type = password.type === 'password' ? 'text' : 'password';
      b.textContent = password.type === 'text' ? 'Hide password' : 'Show password';
      b.setAttribute('aria-pressed', String(password.type === 'text'));
    });
    addButton(password, 'Generate password', () => {
      password.value = generatePassword();
      password.type = 'text';
      toggle.textContent = 'Hide password';
      toggle.setAttribute('aria-pressed', 'true');
      password.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
    });
  }
  if (!create) return;
  const username = field('username');
  const generateUsername = () => {
    username.value = uniqueUsername(field('name').value, users);
    username.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
  };
  addButton(username, 'Generate username', generateUsername);
  const linked = field('candidate_id');
  linked.addEventListener('change', () => {
    const candidate = candidates.find((c) => c.id === linked.value);
    if (!candidate) return;
    field('name').value = candidate.name || '';
    field('email').value = candidate.email || '';
    generateUsername();
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
}
