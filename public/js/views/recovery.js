import { api } from '../api.js';
import { formModal, toast } from '../ui.js';

export function recoveryView(view, token, onDone) {
  view.innerHTML = '<div class="error-page"><h1>Set a new password</h1><p>This link works once and expires 15 minutes after it was issued. Choose a password you do not use elsewhere.</p><button class="btn" id="recover-password">Set password</button><a class="btn secondary" href="#/">Back to sign in</a></div>';
  view.querySelector('#recover-password').onclick = async () => {
    const saved = await formModal({
      title: 'Set your password', submitLabel: 'Save password',
      fields: [
        { name: 'password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', help: '12 to 200 characters.' },
        { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
      ],
      onSubmit: (values) => {
        if (values.password !== values.confirm) throw Object.assign(new Error('Passwords do not match.'), { field: 'confirm' });
        return api('/auth/recover', { method: 'POST', body: { token, password: values.password } });
      },
    });
    if (saved) { toast('Password saved. Sign in with your new password.', 'success'); onDone(); }
  };
}
