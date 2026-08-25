import { esc, fmtDateTime, badge, gapBadge, levelPips, progressBar, pct } from '../ui.js';
import { logoSvg } from '../logo.js';

/**
 * Shared "report card" renderer.
 *  audience: 'admin' | 'assessor' | 'candidate'
 *  payload: { candidate:{name,current_title}, report, assessor_name? }
 * Candidate reports arrive pre-projected by the API (no breakdown/comments);
 * the renderer simply honours the audience anyway.
 *
 * The report is deliberately built from semantic HTML and inline SVG rather
 * than a charting dependency. That keeps the printed version self-contained:
 * browser Print / Save as PDF works offline and charts survive print engines
 * that do not preserve CSS gradients.
 */
const CHART_COLORS = ['#159b96', '#315ca8', '#a36317', '#7553a8', '#d36b56', '#4c8c6b', '#2f708f'];

const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, finite(value)));
const rounded = (value) => Math.round(finite(value) * 10) / 10;

function scoreTone(tone) {
  return tone === 'green' ? 'green' : tone === 'amber' ? 'amber' : 'red';
}

function polar(cx, cy, radius, angle) {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

function piePath(start, end, radius = 42, cx = 50, cy = 50) {
  const first = polar(cx, cy, radius, start);
  const last = polar(cx, cy, radius, end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${first.x.toFixed(3)} ${first.y.toFixed(3)} A ${radius} ${radius} 0 ${large} 1 ${last.x.toFixed(3)} ${last.y.toFixed(3)} Z`;
}

function donutSvg(value, tone) {
  const score = clamp(value);
  const radius = 43;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * (score / 100);
  const color = tone === 'green' ? '#147a57' : tone === 'amber' ? '#a36317' : '#b53a35';
  return `<svg class="report-donut" viewBox="0 0 120 120" role="img" aria-label="Overall score ${rounded(score)} percent">
    <circle class="report-donut-track" cx="60" cy="60" r="${radius}" fill="none" stroke-width="10"/>
    <circle class="report-donut-value" cx="60" cy="60" r="${radius}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" transform="rotate(-90 60 60)"/>
    <text class="report-donut-number" x="60" y="57" text-anchor="middle">${esc(rounded(score))}%</text>
    <text class="report-donut-label" x="60" y="72" text-anchor="middle">OVERALL</text>
  </svg>`;
}

function weightPie(report) {
  const competencies = report.competencies || [];
  if (!competencies.length) {
    return `<div class="report-chart-empty">No competency data available.</div>`;
  }
  const raw = competencies.map((c) => Math.max(0, finite(c.weight)));
  const values = raw.some(Boolean) ? raw : competencies.map(() => 1);
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  let angle = -Math.PI / 2;
  const slices = values.map((value, index) => {
    const next = angle + (value / total) * Math.PI * 2;
    const slice = { color: CHART_COLORS[index % CHART_COLORS.length], d: piePath(angle, next) };
    angle = next;
    return slice;
  });
  return `<svg class="report-pie" viewBox="0 0 100 100" role="img" aria-label="Assessment weight distribution">
    ${slices.map((slice) => `<path d="${slice.d}" fill="${slice.color}" stroke="#ffffff" stroke-width="1.4"/>`).join('')}
    <circle cx="50" cy="50" r="20" fill="#ffffff"/>
    <text class="report-pie-center" x="50" y="48" text-anchor="middle">${competencies.length}</text>
    <text class="report-pie-center-label" x="50" y="59" text-anchor="middle">AREAS</text>
  </svg>`;
}

function renderWeightLegend(report) {
  return (report.competencies || []).map((c, index) => `<li>
    <span class="report-legend-dot" style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>
    <span class="report-legend-name">${esc(c.name)}</span>
    <b>${esc(c.weight)}%</b>
  </li>`).join('');
}

function renderCapabilityBars(report) {
  const competencies = report.competencies || [];
  if (!competencies.length) return `<div class="report-chart-empty">No competency data available.</div>`;
  return competencies.map((c, index) => {
    const score = clamp(c.score_pct);
    const target = clamp((finite(c.target_level, 0) / 5) * 100);
    const color = CHART_COLORS[index % CHART_COLORS.length];
    return `<div class="report-bar-row" role="img" aria-label="${esc(c.name)} score ${rounded(score)} percent, target level ${esc(c.target_level)}">
      <div class="report-bar-label"><span>${esc(c.name)}</span><small>L${esc(c.observed_level)} observed · L${esc(c.target_level)} target</small></div>
      <div class="report-bar-track"><span class="report-bar-fill" style="width:${score}%;background:${color}"></span><i class="report-target-marker" style="left:${target}%" title="Target level marker"></i></div>
      <b class="report-bar-value">${esc(rounded(score))}%</b>
    </div>`;
  }).join('');
}

function reportStats(report) {
  const competencies = report.competencies || [];
  const questionFallback = competencies.reduce((sum, c) => sum + (c.breakdown?.length || 0), 0);
  const earnedFallback = competencies.reduce((sum, c) => sum + finite(c.earned), 0);
  const maxFallback = competencies.reduce((sum, c) => sum + finite(c.max), 0);
  const questions = finite(report.questions_evaluated, questionFallback);
  const earned = finite(report.points_earned, earnedFallback);
  const max = finite(report.points_available, maxFallback);
  return { questions, earned: rounded(earned), max: rounded(max), gaps: (report.areas_to_improve || []).length };
}

export function renderReport(view, { candidate, report, assessor_name, audience }) {
  const band = report.band || {};
  const tone = scoreTone(band.tone);
  const fullDetail = audience !== 'candidate';
  const stats = reportStats(report);

  view.innerHTML = `
    <div class="report-document">
      <div class="card no-print report-actions">
        <div class="row between">
          <a href="${audience === 'admin' ? '#/assessments' : audience === 'assessor' ? '#/workspace' : '#/journey'}" class="btn ghost sm">← Back</a>
          <button type="button" class="btn secondary sm" id="report-print">🖨️ Print / Save PDF</button>
        </div>
      </div>

      <article class="card report report-cover">
        <div class="report-brandbar">
          <div class="report-brand-lockup">
            <span class="report-brand-mark">${logoSvg({ className: 'report-logo', title: 'Anthroprime ECOD' })}</span>
            <span class="report-brand-copy"><strong>Anthroprime</strong><small>ECOD · Enterprise Capability on Demand</small></span>
          </div>
          <div class="report-document-label"><span>CAPABILITY ASSESSMENT</span><b>REPORT CARD</b></div>
        </div>
        <div class="report-header-row">
          <div>
            <div class="small muted report-kicker">Anthroprime ECOD Capability Report</div>
            <h1>${esc(candidate?.name || 'Candidate')}</h1>
            <div class="report-subtitle">${esc(candidate?.current_title || '')}${candidate?.current_title ? ' · ' : ''}${esc(report.role?.name || '')}</div>
            <div class="small muted report-meta-line">
              Assessed ${esc(fmtDateTime(report.generated_at))}${fullDetail && assessor_name ? ` · Reviewed by ${esc(assessor_name)}` : ''}
              · Framework: ${esc(report.framework_name)}
            </div>
          </div>
          <div class="report-status-stamp"><span>STATUS</span><b>${esc(band.label || 'Not graded')}</b></div>
        </div>
        <hr class="hr"/>
        <div class="report-hero">
          <div class="score-ring report-score-ring">${donutSvg(report.overall_pct, tone)}</div>
          <div class="report-readiness-copy">
            <div style="margin-bottom:8px">${badge(band.label || 'Not graded', tone)}</div>
            <h3>Readiness: ${esc(band.label || '—')}</h3>
            <p class="muted">${esc(band.description || '')}</p>
          </div>
        </div>
        <div class="report-stat-strip" aria-label="Assessment summary">
          <div><span>Overall score</span><b>${esc(pct(report.overall_pct))}</b></div>
          <div><span>Competencies</span><b>${esc((report.competencies || []).length)}</b></div>
          <div><span>Questions evaluated</span><b>${esc(stats.questions || '—')}</b></div>
          <div><span>Improvement areas</span><b>${esc(stats.gaps)}</b></div>
        </div>
      </article>

      <section class="card report-visual-summary">
        <div class="report-section-head">
          <div><div class="section-kicker">Visual summary</div><h2>Capability at a glance</h2><p>Weighted assessment signals, presented for a quick executive read.</p></div>
          <span class="report-print-note">Anthroprime ECOD · Confidential</span>
        </div>
        <div class="report-summary-grid">
          <div class="report-chart-panel report-score-panel">
            <div class="report-chart-title"><span>Readiness score</span><small>Weighted overall result</small></div>
            ${donutSvg(report.overall_pct, tone)}
            <div class="report-score-detail"><b>${esc(pct(report.overall_pct))}</b><span>${esc(band.label || 'Not graded')}</span></div>
            <div class="report-earned-line"><span>Points earned</span><b>${esc(stats.earned)} / ${esc(stats.max)}</b></div>
          </div>
          <div class="report-chart-panel report-pie-panel">
            <div class="report-chart-title"><span>Assessment weight mix</span><small>Contribution by competency</small></div>
            <div class="report-pie-layout">
              ${weightPie(report)}
              <ul class="report-legend">${renderWeightLegend(report)}</ul>
            </div>
          </div>
        </div>
        <div class="report-chart-panel report-bars-panel">
          <div class="report-chart-title"><span>Competency performance</span><small>Bars show score · marker shows target level</small></div>
          <div class="report-bars">${renderCapabilityBars(report)}</div>
        </div>
      </section>

      <section class="card report-competency-card">
        <div class="report-section-head compact"><div><div class="section-kicker">Capability map</div><h2>Competency breakdown</h2><p>Observed performance compared with the enterprise-ready target.</p></div></div>
        <table class="data report-table">
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
      </section>

      ${(report.areas_to_improve || []).length ? `
      <section class="card report-improvement-card">
        <div class="report-section-head compact"><div><div class="section-kicker">Next capability moves</div><h2>Areas to improve</h2><p>Ordered by gap severity and role weight. These become the enrichment focus for the next phase.</p></div><span class="report-section-icon amber">↗</span></div>
        ${report.areas_to_improve.map((g, i) => `
          <div class="report-improvement-row" style="${i ? 'border-top:1px solid var(--line)' : ''}">
            <div class="row between">
              <b>${i + 1}. ${esc(g.competency)}</b>
              <span>${g.severity === 'critical_gap' ? badge(`Critical gap · L${g.observed_level} → L${g.target_level}`, 'red') : badge(`Gap · L${g.observed_level} → L${g.target_level}`, 'amber')}</span>
            </div>
            <div class="small muted report-improvement-meta">Current score ${esc(g.score_pct)}% · competency weight ${esc(g.weight)}</div>
            ${g.recommended_focus ? `<div class="report-focus"><b>Recommended focus</b><span>${esc(g.recommended_focus)}</span></div>` : ''}
          </div>`).join('')}
      </section>` : ''}

      ${(report.strengths || []).length ? `
      <section class="card report-strength-card">
        <div class="report-section-head compact"><div><div class="section-kicker">Enterprise-ready signals</div><h2>Demonstrated strengths</h2></div><span class="report-section-icon green">✓</span></div>
        <div class="pill-row report-strength-pills">
          ${report.strengths.map((s) => `<span class="chip">${esc(s.competency)} <b>${esc(s.score_pct)}%</b></span>`).join('')}
        </div>
      </section>` : ''}

      ${fullDetail ? renderBreakdown(report) : ''}

      <footer class="report-footer">
        <span><b>Anthroprime</b> ECOD · Enterprise Capability on Demand</span>
        <span>Confidential assessment report · Generated ${esc(fmtDateTime(report.generated_at))}</span>
      </footer>
    </div>
      `;

  const printButton = view.querySelector('#report-print');
  if (printButton) {
    printButton.onclick = () => {
      const previousTitle = document.title;
      const candidateName = candidate?.name || 'Candidate';
      let restored = false;
      const restoreTitle = () => {
        if (restored) return;
        restored = true;
        document.title = previousTitle;
      };
      document.title = `Anthroprime ECOD Report · ${candidateName}`;
      window.addEventListener('afterprint', restoreTitle, { once: true });
      window.print();
      // Some embedded browsers do not dispatch afterprint. Do not leave the
      // application tab with a report-specific title in that case.
      setTimeout(restoreTitle, 2000);
    };
  }
}

function renderBreakdown(report) {
  return `
    <section class="card report-breakdown-card">
      <div class="report-section-head compact"><div><div class="section-kicker">Internal evidence</div><h2>Question-level detail <span class="badge grey" style="margin-left:6px">internal</span></h2><p>Response evidence and assessor feedback supporting the capability map.</p></div></div>
      ${(report.competencies || []).map((c) => `
        <h3 class="report-breakdown-heading">${esc(c.name)} <span class="muted small">· ${esc(c.earned)}/${esc(c.max)} pts</span></h3>
        <table class="data report-table">
          <thead><tr><th>Question</th><th style="width:120px">Type</th><th style="width:90px">Score</th><th>Assessor feedback</th></tr></thead>
          <tbody>${(c.breakdown || []).map((b) => `<tr>
            <td>${esc(b.prompt)}</td>
            <td><span class="chip">${esc(b.type)}</span>${b.difficulty ? ` <span class="small muted">${esc(b.difficulty)}</span>` : ''}</td>
            <td><b>${esc(b.score)}</b>/${esc(b.points)}</td>
            <td class="small muted">${esc(b.assessor_comment || (b.scored_by === 'auto' ? 'Auto-scored' : '—'))}</td>
          </tr>`).join('')}</tbody>
        </table>`).join('')}
    </section>`;
}
