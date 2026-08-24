import { esc, fmtDateTime, badge, gapBadge, levelPips, progressBar, pct } from '../ui.js';

/**
 * Shared "report card" renderer.
 *  audience: 'admin' | 'assessor' | 'candidate'
 *  payload: { candidate:{name,current_title}, report, assessor_name? }
 * Candidate reports arrive pre-projected by the API (no breakdown/comments);
 * the renderer simply honours the audience anyway.
 */
export function renderReport(view, { candidate, report, assessor_name, audience }) {
  const band = report.band || {};
  const tone = band.tone === 'green' ? 'green' : band.tone === 'amber' ? 'amber' : 'red';
  const conic = `conic-gradient(var(--${tone === 'green' ? 'green' : tone === 'amber' ? 'amber' : 'red'}) ${report.overall_pct * 3.6}deg, #e3e9ee 0deg)`;
  const fullDetail = audience !== 'candidate';

  view.innerHTML = `
    <div class="card no-print" style="padding:12px 18px">
      <div class="row between">
        <a href="${audience === 'admin' ? '#/assessments' : audience === 'assessor' ? '#/workspace' : '#/journey'}" class="btn ghost sm">← Back</a>
        <button class="btn secondary sm" onclick="window.print()">🖨️ Print / Save PDF</button>
      </div>
    </div>

    <div class="card report">
      <div class="row between" style="align-items:flex-start">
        <div>
          <div class="small muted" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">Anthroprime EOD Capability Report</div>
          <h1 style="margin:6px 0 2px">${esc(candidate?.name || 'Candidate')}</h1>
          <div class="muted">${esc(candidate?.current_title || '')}${candidate?.current_title ? ' · ' : ''}${esc(report.role?.name || '')}</div>
          <div class="small muted" style="margin-top:6px">
            Assessed ${esc(fmtDateTime(report.generated_at))}${fullDetail && assessor_name ? ` · Reviewed by ${esc(assessor_name)}` : ''}
            · Framework: ${esc(report.framework_name)}
          </div>
        </div>
      </div>
      <hr class="hr"/>
      <div class="report-hero">
        <div class="score-ring" style="background:${conic}">
          <div class="inner"><div><div class="val">${esc(report.overall_pct)}%</div><div class="cap">Overall</div></div></div>
        </div>
        <div style="flex:1;min-width:260px">
          <div style="margin-bottom:8px">${badge(band.label || 'Not graded', tone)}</div>
          <h3 style="margin:0 0 4px">Readiness: ${esc(band.label || '—')}</h3>
          <p class="muted" style="margin:0">${esc(band.description || '')}</p>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Competency breakdown</h2>
      <table class="data">
        <thead><tr><th>Competency</th><th style="width:70px">Weight</th><th style="width:150px">Score</th><th style="width:170px">Observed level</th><th style="width:110px">Target</th><th style="width:150px">Verdict</th></tr></thead>
        <tbody>
          ${(report.competencies || []).map((c) => `<tr>
            <td><b>${esc(c.name)}</b>${c.category ? `<div class="small muted">${esc(c.category)}</div>` : ''}</td>
            <td>${esc(c.weight)}</td>
            <td><div class="row" style="gap:8px">${progressBar(c.score_pct, 70)}<b>${esc(c.score_pct)}%</b></div></td>
            <td>${levelPips(c.observed_level)} <span class="small muted">L${esc(c.observed_level)}</span></td>
            <td><span class="small muted">L${esc(c.target_level)}</span></td>
            <td>${gapBadge(c)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    ${(report.areas_to_improve || []).length ? `
    <div class="card" style="border-left:4px solid var(--amber)">
      <h2>🎯 Areas to improve</h2>
      <p class="muted small" style="margin-top:-4px">Ordered by gap severity and role weight. These become your enrichment focus for the next phase.</p>
      ${report.areas_to_improve.map((g, i) => `
        <div style="padding:13px 0;${i ? 'border-top:1px solid var(--line)' : ''}">
          <div class="row between">
            <b>${i + 1}. ${esc(g.competency)}</b>
            <span>${g.severity === 'critical_gap' ? badge(`Critical gap · L${g.observed_level} → L${g.target_level}`, 'red') : badge(`Gap · L${g.observed_level} → L${g.target_level}`, 'amber')}</span>
          </div>
          <div class="small muted" style="margin:4px 0">Current score ${esc(g.score_pct)}% · competency weight ${esc(g.weight)}</div>
          ${g.recommended_focus ? `<div class="small" style="background:var(--amber-bg);border-radius:8px;padding:9px 12px"><b>Recommended focus:</b> ${esc(g.recommended_focus)}</div>` : ''}
        </div>`).join('')}
    </div>` : ''}

    ${(report.strengths || []).length ? `
    <div class="card" style="border-left:4px solid var(--green)">
      <h2>💪 Demonstrated strengths</h2>
      <div class="pill-row" style="margin-top:6px">
        ${report.strengths.map((s) => `<span class="chip" style="background:var(--green-bg);color:var(--green)">${esc(s.competency)} · ${esc(s.score_pct)}%</span>`).join('')}
      </div>
    </div>` : ''}

    ${fullDetail ? renderBreakdown(report) : ''}
  `;
}

function renderBreakdown(report) {
  return `
    <div class="card">
      <h2>Question-level detail <span class="badge grey" style="margin-left:6px">internal</span></h2>
      ${(report.competencies || []).map((c) => `
        <h3 style="margin-top:16px">${esc(c.name)} <span class="muted small">· ${esc(c.earned)}/${esc(c.max)} pts</span></h3>
        <table class="data">
          <thead><tr><th>Question</th><th style="width:120px">Type</th><th style="width:90px">Score</th><th>Assessor feedback</th></tr></thead>
          <tbody>${(c.breakdown || []).map((b) => `<tr>
            <td>${esc(b.prompt)}</td>
            <td><span class="chip">${esc(b.type)}</span>${b.difficulty ? ` <span class="small muted">${esc(b.difficulty)}</span>` : ''}</td>
            <td><b>${esc(b.score)}</b>/${esc(b.points)}</td>
            <td class="small muted">${esc(b.assessor_comment || (b.scored_by === 'auto' ? 'Auto-scored' : '—'))}</td>
          </tr>`).join('')}</tbody>
        </table>`).join('')}
    </div>`;
}
