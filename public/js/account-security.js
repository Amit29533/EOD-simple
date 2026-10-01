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

export async function authenticatorSettings() {
  try {
    const status = await api('/auth/security');
    if (!status.mfa_enabled && !status.setup_available) {
      toast('Authenticator setup requires your administrator to configure SECURITY_ENCRYPTION_KEY on the server.', 'error');
      return;
    }
    if (status.mfa_enabled) {
      const result = await formModal({ title: 'Disable authenticator protection', submitLabel: 'Disable',
        intro: 'Other signed-in devices will be signed out.',
        fields: [
          { name: 'password', label: 'Current password', type: 'password', required: true },
          { name: 'otp', label: 'Fresh authenticator or unused backup code', required: true },
        ], onSubmit: (body) => api('/auth/mfa/disable', { method: 'POST', body }) });
      if (result) toast('Authenticator protection disabled.', 'success');
      return;
    }
    const setup = await formModal({ title: 'Set up authenticator protection', submitLabel: 'Continue',
      fields: [{ name: 'password', label: 'Current password', type: 'password', required: true }],
      onSubmit: (body) => api('/auth/mfa/setup', { method: 'POST', body }) });
    if (!setup) return;
    const enabled = await formModal({ title: 'Connect your authenticator', submitLabel: 'Enable protection',
      intro: 'In your authenticator app, add a time-based account named ECOD and enter this setup key. Then enter its six-digit code. Setup expires in 10 minutes.',
      values: { secret: setup.secret },
      fields: [{ name: 'secret', label: 'Private setup key', readonly: true },
        { name: 'otp', label: 'Six-digit code', required: true }],
      onSubmit: ({ otp }) => api('/auth/mfa/enable', { method: 'POST', body: { otp } }) });
    if (!enabled) return;
    await formModal({ title: 'Save your backup codes', submitLabel: 'I saved these codes',
      intro: 'Protection is enabled. Copy these codes into a safe place before closing this dialog. Each code works once if you lose your authenticator; they cannot be displayed again.',
      values: { codes: enabled.recovery_codes.join('\n') },
      fields: [{ name: 'codes', label: 'Backup codes', type: 'textarea', readonly: true }] });
  } catch (err) { toast(err.message, 'error'); }
}
