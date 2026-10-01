import { api } from './api.js';
import { formModal, toast } from './ui.js';

export async function changePassword() {
  const result = await formModal({
    title: 'Change your password',
    intro: 'Your other signed-in devices will be signed out. This session stays active.',
    submitLabel: 'Change password',
    fields: [
      { name: 'current_password', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'new_password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', help: '8 to 200 characters. Choose a password you do not use elsewhere.' },
      { name: 'confirm_password', label: 'Confirm new password', type: 'password', required: true, autocomplete: 'new-password' },
    ],
    onSubmit: async (values) => {
      if (values.new_password !== values.confirm_password) {
        const err = new Error('Passwords do not match.');
        err.field = 'confirm_password';
        throw err;
      }
      return api('/auth/password', { method: 'POST', body: { current_password: values.current_password, new_password: values.new_password } });
    },
  });
  if (result) toast('Password changed. Other devices have been signed out.', 'success');
}
