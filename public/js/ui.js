/** DOM + widget toolkit. All user data MUST pass through esc(). */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const num = (v, d = '—') => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? d : Number(v);
export const pct = (v) => (v === null || v === undefined || v === '') ? '—' : `${Number(v)}%`;

const SHORT_DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const SHORT_DT = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
/**
 * An unreadable date reads like a missing one. `Intl.DateTimeFormat#format`
 * throws a RangeError on an Invalid Date, so one row with a date the app did
 * not write itself (a hand-edited Airtable base, a migrated or hand-edited
 * store) used to take a whole screen (the assessments list, the audit log,
 * a candidate record) down to the error page.
 */
const safeFormat = (formatter, iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : formatter.format(d);
};
export const fmtDate = (iso) => safeFormat(SHORT_DATE, iso);
export const fmtDateTime = (iso) => safeFormat(SHORT_DT, iso);

export const initials = (name = '') => name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';

export function badge(text, tone = 'grey') {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}
// `untested` is a real verdict: the paper simply carried no question for that
// competency, which must never be displayed as (or scored like) a failure.
export const gapBadge = (c) => c.status === 'critical_gap' ? badge(`Gap ${c.gap} · critical`, 'red')
  : c.status === 'moderate_gap' ? badge(`Gap ${c.gap}`, 'amber')
  : c.status === 'strength' ? badge('Strength', 'green')
  : c.status === 'untested' ? badge('Not assessed', 'grey') : badge('On target', 'green');

export const loading = (text = 'Loading…') => `<div class="loading"><span class="spinner"></span><span>${esc(text)}</span></div>`;
export const emptyState = (title, sub = '', emoji = '') =>
  `<div class="empty"><div class="empty-icon" aria-hidden="true">${emoji || '◇'}</div><div style="font-weight:600;color:var(--ink-2)">${esc(title)}</div>${sub ? `<div class="small">${esc(sub)}</div>` : ''}</div>`;

/* ------------------------------ toast ------------------------------ */
const TOAST_ICONS = { success: '✓', error: '!', info: 'i' };

/**
 * Transient notification. Errors are announced assertively and stay on screen
 * longer (they usually carry something the user must act on); every toast can
 * be dismissed immediately. Identical consecutive messages are de-duplicated
 * so a retried action does not stack the same banner repeatedly.
 */
export function toast(message, type = 'info', ms) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const text = String(message ?? '');
  const last = root.lastElementChild;
  if (last && last.dataset.message === text) { // refresh instead of stacking
    last.classList.remove('toast-in');
    void last.offsetWidth;
    last.classList.add('toast-in');
    return;
  }
  const life = ms ?? (type === 'error' ? 6000 : 3600);
  const el = document.createElement('div');
  el.className = `toast toast-in ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`.trim();
  el.dataset.message = text;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-icon" aria-hidden="true">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <span class="toast-text"></span>
    <button type="button" class="toast-x" aria-label="Dismiss notification">✕</button>`;
  el.querySelector('.toast-text').textContent = text;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 240);
  };
  el.querySelector('.toast-x').onclick = dismiss;
  root.appendChild(el);
  const timer = setTimeout(dismiss, life);
  el.addEventListener('mouseenter', () => clearTimeout(timer));  // don't vanish mid-read
  return dismiss;
}

/** Run an async action, showing errors as toasts. Returns undefined on failure. */
export async function attempt(fn, { onOk, okMessage } = {}) {
  try {
    const out = await fn();
    if (okMessage) toast(okMessage, 'success');
    if (onOk) onOk(out);
    return out;
  } catch (err) {
    toast(err.message || 'Something went wrong', 'error');
    return undefined;
  }
}

/* ------------------------------ modal ------------------------------ */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let modalDepth = 0;

/**
 * Accessible dialog: labelled by its heading, focus moved inside on open,
 * Tab cycles within the dialog, Escape closes it (top-most first) and focus
 * returns to whatever opened it. Body scroll is locked while one is open.
 */
export function modal({ title, bodyHtml, actions = [], wide = false, onOpen, onClose, dismissible = true }) {
  const root = document.getElementById('modal-root');
  const opener = document.activeElement;
  const titleId = `m-title-${Math.random().toString(36).slice(2, 9)}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="m-head"><h3 id="${titleId}">${esc(title)}</h3>${dismissible ? '<button class="x" data-x type="button" aria-label="Close dialog">✕</button>' : ''}</div>
      <div class="m-body">${bodyHtml}</div>
      <div class="m-foot"></div>
    </div>`;
  const dialog = backdrop.querySelector('.modal');
  const foot = backdrop.querySelector('.m-foot');

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    modalDepth = Math.max(0, modalDepth - 1);
    if (!modalDepth) document.body.classList.remove('modal-open');
    if (onClose) onClose();
    // Return focus to the trigger so keyboard users are not dumped at the top.
    if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus({ preventScroll: true });
  };

  const onKey = (e) => {
    if (backdrop !== root.lastElementChild) return;    // only the top dialog reacts
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);

  if (dismissible) {
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-x]').onclick = () => close();
  }

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${a.kind || ''}`.trim();
    btn.textContent = a.label;
    if (a.danger) btn.classList.add('danger');
    btn.onclick = async () => { if (a.onClick) await a.onClick(close, btn); else close(); };
    foot.appendChild(btn);
  }

  root.appendChild(backdrop);
  modalDepth += 1;
  document.body.classList.add('modal-open');

  // Focus the first meaningful control, preferring a real input over the close button.
  const target = dialog.querySelector('.m-body input:not([type=hidden]):not([disabled]), .m-body select, .m-body textarea')
    || foot.querySelector('.btn:last-child')
    || dialog.querySelector('[data-x]')
    || dialog;
  requestAnimationFrame(() => target.focus({ preventScroll: true }));

  if (onOpen) onOpen(dialog, close);
  return { el: dialog, close };
}

/**
 * Yes/no dialog. Any dismissal (Escape, backdrop, ✕, Cancel) resolves false,
 * so callers can always treat a falsy result as "do not proceed".
 */
export function confirmModal(title, message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    modal({
      title,
      bodyHtml: `<p class="confirm-copy">${esc(message)}</p>`,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { settle(false); close(); } },
        { label: confirmLabel, danger, onClick: (close) => { settle(true); close(); } },
      ],
      onClose: () => settle(false),
    });
  });
}

/* --------------------------- form modal --------------------------- */
/**
 * fields: [{ name, label, type: text|email|password|number|textarea|select|checkbox|static,
 *            options: [{value,label}] | fn(values), required, help, value, min, max, step,
 *            placeholder, rows, pattern, patternMessage, autocomplete }]
 *
 * Without `onSubmit`: resolves with the collected values, or null when
 * cancelled, and the caller saves them after the dialog has closed.
 *
 * With `onSubmit(values)`: the dialog does the save itself and closes only once
 * it succeeds. While it runs, both buttons are disabled and the submit button
 * reads `busyLabel`. If it throws, the dialog stays open with everything the
 * user typed. The message appears against the field it names: the field in
 * `err.field`, else the field whose name or label the message mentions first.
 * If it names no field, the message appears in a banner above the form.
 * Resolves with onSubmit's result (`true` if it returns nothing), or null when
 * cancelled. A dialog dismissed mid-save still resolves with the outcome, so a
 * save that lands is never reported as cancelled.
 *
 * Errors are shown inline against the offending field (and announced), rather
 * than only as a toast that disappears before the user reaches the input.
 */
export function formModal({
  title, fields, values = {}, submitLabel = 'Save', wide = false, intro = '',
  onSubmit = null, busyLabel = 'Saving…',
}) {
  return new Promise((resolve) => {
    // The dialog can be dismissed in several ways (Escape, backdrop, ✕, Cancel);
    // settle() guarantees the caller sees exactly one outcome, whichever wins.
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    let saving = false;           // an onSubmit call is in flight
    let dismissed = false;        // the dialog was closed while it was
    const id = (n) => `fm-${n}`;
    const errId = (n) => `fm-err-${n}`;
    const control = (f) => {
      const v = values[f.name] ?? f.value ?? '';
      const req = f.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
      const describedBy = [f.help ? `fm-help-${f.name}` : '', errId(f.name)].filter(Boolean).join(' ');
      const common = `name="${esc(f.name)}" id="${id(f.name)}" aria-describedby="${describedBy}"`
        + `${f.required ? ' required aria-required="true"' : ''}`
        + `${f.autocomplete ? ` autocomplete="${esc(f.autocomplete)}"` : ''}`;
      const help = f.help ? `<div class="help" id="fm-help-${esc(f.name)}">${esc(f.help)}</div>` : '';
      const err = `<div class="field-err" id="${errId(f.name)}" role="alert" hidden></div>`;

      if (f.type === 'textarea')
        return `<label class="f"><span class="lbl">${esc(f.label)}${req}</span><textarea ${common} rows="${f.rows || 3}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>${esc(v)}</textarea>${help}${err}</label>`;
      if (f.type === 'select') {
        const opts = (typeof f.options === 'function' ? f.options(values) : f.options) || [];
        return `<label class="f"><span class="lbl">${esc(f.label)}${req}</span>
          <select ${common}>
            ${f.allowEmpty !== false ? '<option value="">— select —</option>' : ''}
            ${opts.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>${help}${err}</label>`;
      }
      if (f.type === 'checkbox')
        return `<label class="check" style="margin-bottom:13px"><input type="checkbox" ${common} ${(values[f.name] ?? f.value) ? 'checked' : ''}/> <span>${esc(f.label)}</span></label>${help}${err}`;
      return `<label class="f"><span class="lbl">${esc(f.label)}${req}</span>
        <input type="${f.type || 'text'}" ${common} value="${esc(v)}"
          ${f.min !== undefined ? `min="${esc(f.min)}"` : ''} ${f.max !== undefined ? `max="${esc(f.max)}"` : ''} ${f.step !== undefined ? `step="${esc(f.step)}"` : ''}
          ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}/>${help}${err}</label>`;
    };

    const html = fields.filter((f) => f.type !== 'static').map(control).join('');
    let submit;
    let cancel;

    const formEl = () => m.el.querySelector('#fm-form');
    const banner = () => m.el.querySelector('.form-err');
    const showBanner = (message) => {
      const box = banner();
      if (!box) return;
      box.textContent = message;
      box.hidden = !message;
    };
    // Marks one field (message '' clears it). Returns its input.
    const setError = (field, message) => {
      const box = m.el.querySelector(`#${errId(field.name)}`);
      const input = formEl().elements[field.name];
      if (box) { box.textContent = message; box.hidden = !message; }
      if (input) {
        input.classList.toggle('invalid', !!message);
        input.setAttribute('aria-invalid', message ? 'true' : 'false');
      }
      return input;
    };
    const reveal = (el) => {
      el.focus();
      el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    };

    // Reads and checks every field; marks the bad ones. Returns the values, or
    // null after focusing the first bad field.
    const collect = () => {
      const form = formEl();
      const out = {};
      let firstBad = null;
      const fail = (f, message) => { const input = setError(f, message); if (!firstBad) firstBad = input; };
      for (const f of fields) {
        if (f.type === 'static') continue;
        const input = form.elements[f.name];
        if (!input) continue;
        setError(f, '');
        if (f.type === 'checkbox') { out[f.name] = input.checked; continue; }
        const raw = typeof input.value === 'string' ? input.value.trim() : input.value;
        if (f.type === 'number') out[f.name] = raw === '' ? null : Number(raw);
        else out[f.name] = raw;

        const val = out[f.name];
        if (f.required && (val === '' || val === null || val === undefined)) {
          fail(f, `${f.label} is required.`);
          continue;
        }
        if (val === '' || val === null) continue;
        if (f.type === 'number') {
          if (!Number.isFinite(val)) { fail(f, 'Enter a valid number.'); continue; }
          if (f.min !== undefined && val < Number(f.min)) { fail(f, `Must be ${f.min} or more.`); continue; }
          if (f.max !== undefined && val > Number(f.max)) { fail(f, `Must be ${f.max} or less.`); continue; }
        }
        if (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(val))) {
          fail(f, 'Enter a valid email address.'); continue;
        }
        if (f.pattern && !new RegExp(f.pattern).test(String(val))) {
          fail(f, f.patternMessage || `${f.label} is not in the expected format.`); continue;
        }
      }
      if (firstBad) { reveal(firstBad); return null; }
      return out;
    };

    // The field a save error is about: the one it names explicitly, else the
    // one whose name or label the message mentions first, as a whole word.
    // "Username already exists." → username; "That candidate already has a
    // portal user." → candidate_id. Messages naming no field get the banner.
    const errorField = (err, message) => {
      const form = formEl();
      const present = fields.filter((f) => f.type !== 'static' && form.elements[f.name]);
      const named = present.find((f) => f.name === err?.field);
      if (named) return named;
      const text = message.toLowerCase();
      let best = null;
      let bestAt = Infinity;
      for (const f of present) {
        const words = [f.name, f.name.replace(/_id$/, '').replace(/_/g, ' '), String(f.label || '').split('(')[0].trim()];
        for (const word of new Set(words.map((w) => w.toLowerCase()).filter(Boolean))) {
          const hit = new RegExp(`(^|[^a-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`).exec(text);
          const at = hit ? hit.index + hit[1].length : Infinity;
          if (at < bestAt) { best = f; bestAt = at; }
        }
      }
      return best;
    };

    const setBusy = (busy) => {
      saving = busy;
      submit.disabled = busy;
      if (cancel) cancel.disabled = busy;
      submit.textContent = busy ? busyLabel : submitLabel;
      if (busy) formEl().setAttribute('aria-busy', 'true');
      else formEl().removeAttribute('aria-busy');
    };

    const save = async (out, close) => {
      showBanner('');
      setBusy(true);
      let result;
      try {
        result = await onSubmit(out);
      } catch (err) {
        const message = err?.message || 'Something went wrong';
        if (dismissed || err?.status === 401) {
          // Nothing left to correct here: the dialog was closed mid-save, or
          // the session ended and the app has gone back to the sign-in page.
          saving = false;
          toast(message, 'error');
          settle(null);
          close();
          return;
        }
        setBusy(false);
        const field = errorField(err, message);
        if (field) reveal(setError(field, message));
        else { showBanner(message); reveal(banner()); }
        return;
      }
      saving = false;
      settle(result ?? true);
      close();
    };

    const m = modal({
      title,
      wide,
      bodyHtml: `${intro ? `<p class="modal-intro">${esc(intro)}</p>` : ''}`
        + '<div class="form-err" role="alert" tabindex="-1" hidden></div>'
        + `<form id="fm-form" novalidate>${html}</form>`,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { settle(null); close(); } },
        {
          label: submitLabel,
          onClick: async (close, btn) => {
            if (saving) return;
            const out = collect();
            if (!out) return;
            if (!onSubmit) {
              btn.disabled = true;
              settle(out);
              close();
              return;
            }
            await save(out, close);
          },
        },
      ],
      // Escape / backdrop / ✕ resolve as cancelled, except mid-save: then the
      // save's outcome decides, so a save that lands is not reported as cancelled.
      onClose: () => { if (saving) dismissed = true; else settle(null); },
      onOpen: (el) => {
        submit = el.querySelector('.m-foot .btn:last-child');
        cancel = el.querySelector('.m-foot .btn:first-child');
        // Enter submits from any single-line input, matching a normal form.
        el.querySelector('#fm-form').addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); submit?.click(); }
        });
        // Clear a field's error as soon as the user starts fixing it.
        el.querySelectorAll('#fm-form input, #fm-form select, #fm-form textarea').forEach((input) => {
          const clear = () => {
            const box = el.querySelector(`#fm-err-${input.name}`);
            if (box && !box.hidden) { box.hidden = true; box.textContent = ''; }
            input.classList.remove('invalid');
            input.setAttribute('aria-invalid', 'false');
          };
          input.addEventListener('input', clear);
          input.addEventListener('change', clear);
        });
      },
    });
  });
}

/* --------------------------- domain widgets --------------------------- */
export function pipelineStepper(stages, currentKey) {
  const idx = stages.findIndex((s) => s.key === currentKey);
  return `<div class="stepper">${stages.map((s, i) => `
    <div class="step ${i < idx ? 'done' : i === idx ? 'current' : ''}">
      <div class="dot">${i < idx ? '✓' : i + 1}</div>
      <div class="name">${esc(s.label)}</div>
    </div>`).join('')}</div>`;
}

export const stageBadge = (stages, key) => {
  const i = stages.findIndex((s) => s.key === key);
  const tone = key === 'enterprise_ready' ? 'green' : ['enrichment', 'validation'].includes(key) ? 'amber' : 'blue';
  return badge(i >= 0 ? stages[i].label : key, tone);
};

export const assessmentStatusBadge = (statuses, key) => {
  const s = statuses.find((x) => x.key === key);
  return badge(s?.label || key, s?.tone || 'grey');
};

export const readinessBadge = (key, label) => {
  const tone = key === 'enterprise_ready' ? 'green' : key === 'development_needed' ? 'amber' : key === 'not_ready' ? 'red' : 'grey';
  return badge(label || 'Not scored', tone);
};

export const levelPips = (level, max = 5) =>
  `<span class="level-pips" title="Level ${level} of ${max}">${Array.from({ length: max }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('')}</span>`;

export const progressBar = (pctVal, width = 90) =>
  `<div class="progress" style="width:${width}px"><span style="width:${Math.min(100, Math.max(0, pctVal))}%"></span></div>`;

/**
 * Simple data table. cols: [{label, render(row), cls}]
 * `caption` gives screen-reader users context for the table; on narrow screens
 * the card scrolls horizontally, so it is exposed as a focusable region
 * (tabindex is applied by the caller's card via enhanceTables).
 */
export function dataTable(cols, rows, rowKey = (r) => r.id, caption = '') {
  return `<table class="data">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ''}
    <thead><tr>${cols.map((c) => `<th scope="col" class="${c.cls || ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr data-key="${esc(rowKey(r))}">${cols.map((c) => `<td class="${c.cls || ''}">${c.render(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/**
 * Make any horizontally-overflowing table card reachable by keyboard, so the
 * hidden columns are not a mouse-only affordance. Safe to call repeatedly.
 */
export function enhanceTables(root = document) {
  root.querySelectorAll('.card:has(> table.data), .table-card').forEach((card) => {
    const overflowing = card.scrollWidth > card.clientWidth + 1;
    if (overflowing) {
      card.tabIndex = 0;
      card.setAttribute('role', 'region');
      if (!card.hasAttribute('aria-label')) card.setAttribute('aria-label', 'Scrollable table');
    } else {
      card.removeAttribute('tabindex');
      card.removeAttribute('role');
    }
  });
}
