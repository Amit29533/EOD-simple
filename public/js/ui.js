/** DOM + widget toolkit. All user data MUST pass through esc(). */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const num = (v, d = '—') => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? d : Number(v);
export const pct = (v) => (v === null || v === undefined || v === '') ? '—' : `${Number(v)}%`;

const SHORT_DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const SHORT_DT = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (iso) => iso ? SHORT_DATE.format(new Date(iso)) : '—';
export const fmtDateTime = (iso) => iso ? SHORT_DT.format(new Date(iso)) : '—';

export const initials = (name = '') => name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';

export function badge(text, tone = 'grey') {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}
export const gapBadge = (c) => c.status === 'critical_gap' ? badge(`Gap ${c.gap} · critical`, 'red')
  : c.status === 'moderate_gap' ? badge(`Gap ${c.gap}`, 'amber')
  : c.status === 'strength' ? badge('Strength', 'green') : badge('On target', 'green');

export const loading = (text = 'Loading…') => `<div class="loading"><span class="spinner"></span><span>${esc(text)}</span></div>`;
export const emptyState = (title, sub = '', emoji = '🗂️') =>
  `<div class="empty"><div class="big">${emoji}</div><div style="font-weight:600;color:var(--ink-2)">${esc(title)}</div>${sub ? `<div class="small">${esc(sub)}</div>` : ''}</div>`;

/* ------------------------------ toast ------------------------------ */
export function toast(message, type = 'info', ms = 3600) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
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
export function modal({ title, bodyHtml, actions = [], wide = false, onOpen }) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="m-head"><h3>${esc(title)}</h3><button class="x" data-x aria-label="Close">✕</button></div>
      <div class="m-body">${bodyHtml}</div>
      <div class="m-foot"></div>
    </div>`;
  const foot = backdrop.querySelector('.m-foot');
  const close = (value) => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-x]').onclick = () => close();
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${a.kind || ''}`.trim();
    btn.textContent = a.label;
    if (a.danger) btn.classList.add('danger');
    btn.onclick = async () => { if (a.onClick) await a.onClick(close, btn); else close(); };
    foot.appendChild(btn);
  }
  root.appendChild(backdrop);
  if (onOpen) onOpen(backdrop.querySelector('.modal'), close);
  return { el: backdrop.querySelector('.modal'), close };
}

export function confirmModal(title, message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    modal({
      title,
      bodyHtml: `<p>${esc(message)}</p>`,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { close(); resolve(false); } },
        { label: confirmLabel, danger, onClick: (close) => { close(); resolve(true); } },
      ],
    });
  });
}

/* --------------------------- form modal --------------------------- */
/**
 * fields: [{ name, label, type: text|email|password|number|textarea|select|checkbox|static,
 *            options: [{value,label}] | fn(values), required, help, value, min, max, step, placeholder, rows }]
 * Resolves with collected values, or null when cancelled.
 */
export function formModal({ title, fields, values = {}, submitLabel = 'Save', wide = false }) {
  return new Promise((resolve) => {
    const id = (n) => `fm-${n}`;
    const html = fields.filter((f) => f.type !== 'static').map((f) => {
      const v = values[f.name] ?? f.value ?? '';
      const req = f.required ? ' <span class="req">*</span>' : '';
      if (f.type === 'textarea')
        return `<label class="f"><span class="lbl">${esc(f.label)}${req}</span><textarea name="${esc(f.name)}" id="${id(f.name)}" rows="${f.rows || 3}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>${esc(v)}</textarea>${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</label>`;
      if (f.type === 'select') {
        const opts = (typeof f.options === 'function' ? f.options(values) : f.options) || [];
        return `<label class="f"><span class="lbl">${esc(f.label)}${req}</span>
          <select name="${esc(f.name)}" id="${id(f.name)}">
            ${f.allowEmpty !== false ? `<option value="">— select —</option>` : ''}
            ${opts.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</label>`;
      }
      if (f.type === 'checkbox')
        return `<label class="check" style="margin-bottom:13px"><input type="checkbox" name="${esc(f.name)}" id="${id(f.name)}" ${(values[f.name] ?? f.value) ? 'checked' : ''}/> <span>${esc(f.label)}</span></label>`;
      return `<label class="f"><span class="lbl">${esc(f.label)}${req}</span>
        <input type="${f.type || 'text'}" name="${esc(f.name)}" id="${id(f.name)}" value="${esc(v)}"
          ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.step !== undefined ? `step="${f.step}"` : ''}
          ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}/>${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</label>`;
    }).join('');

    modal({
      title, wide, bodyHtml: `<form id="fm-form">${html}</form>`,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { close(); resolve(null); } },
        {
          label: submitLabel,
          onClick: async (close, btn) => {
            const form = document.getElementById('fm-form');
            const out = {};
            for (const f of fields) {
              if (f.type === 'static') continue;
              const input = form.elements[f.name];
              if (!input) continue;
              if (f.type === 'checkbox') out[f.name] = input.checked;
              else if (f.type === 'number') out[f.name] = input.value === '' ? null : Number(input.value);
              else out[f.name] = input.value;
              if (f.required && (out[f.name] === '' || out[f.name] === null)) {
                input.focus();
                toast(`"${f.label}" is required`, 'error');
                return;
              }
            }
            btn.disabled = true;
            close();
            resolve(out);
          },
        },
      ],
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

/** Simple data table. cols: [{label, render(row), cls}] */
export function dataTable(cols, rows, rowKey = (r) => r.id) {
  return `<table class="data"><thead><tr>${cols.map((c) => `<th class="${c.cls || ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr data-key="${esc(rowKey(r))}">${cols.map((c) => `<td class="${c.cls || ''}">${c.render(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
