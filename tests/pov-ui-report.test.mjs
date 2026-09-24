/**
 * Report card UI (public/js/views/report.js), the one renderer admins,
 * assessors and candidates all read. Pins the "Assessment weight mix" panel to
 * what the overall score actually blends (computeReport in src/core/scoring.mjs):
 *  - the legend shows each competency's normalised share, not its raw weight
 *    with a "%" after it (custom weights 50/50/50 used to read "50%" x3);
 *  - a competency the capped paper never reached gets no slice and reads
 *    "not assessed", because the overall score excludes it;
 *  - the published tracks (weights summing to 100, all assessed) read exactly
 *    as before;
 *  - a single slice is drawn as a full disc (a one-arc path whose endpoints
 *    coincide renders nothing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, SKIP } from './helpers/jsdom.mjs';
import { computeReport } from '../src/core/scoring.mjs';

const comp = (name, weight, score_pct, extra = {}) => ({
  name, category: 'x', weight, score_pct,
  observed_level: score_pct == null ? null : 3, target_level: 4,
  gap: score_pct == null ? null : 1, status: score_pct == null ? 'untested' : 'below',
  earned: score_pct == null ? 0 : 3, max: score_pct == null ? 0 : 4, breakdown: [], ...extra,
});

function report(competencies, overall = 70) {
  return {
    overall_pct: overall, band: { tone: 'amber', label: 'Developing' }, framework_name: 'F',
    role: { name: 'Track' }, generated_at: '2026-09-24T10:00:00.000Z',
    competencies, areas_to_improve: [], strengths: [],
    not_assessed: competencies.filter((c) => c.score_pct == null).map((c) => ({ competency: c.name, weight: c.weight })),
  };
}

async function render(rep, audience = 'admin') {
  const dom = new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>', {
    url: 'http://localhost:3000/', pretendToBeVisual: true,
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const { renderReport } = await import(`../public/js/views/report.js?pov=${Math.random()}`);
  renderReport(document.getElementById('view'), {
    candidate: { name: 'Pat Doe', current_title: 'Engineer' }, report: rep, assessor_name: 'Priya', audience,
  });
  const legend = [...document.querySelectorAll('.report-legend li')].map((li) => ({
    name: li.querySelector('.report-legend-name').textContent.trim(),
    value: li.querySelector('b').textContent.trim(),
    untested: li.classList.contains('is-untested'),
  }));
  const slices = [...document.querySelectorAll('.report-pie path')].map((p) => p.getAttribute('d'));
  return { dom, legend, slices };
}
const close = (dom) => { dom.window.close(); delete globalThis.window; delete globalThis.document; };

test('custom weights are shown as their share of the score, not as raw percentages', { skip: SKIP }, async () => {
  const { dom, legend, slices } = await render(report([comp('Alpha', 50, 80), comp('Beta', 50, 60), comp('Gamma', 50, 70)]));
  try {
    assert.deepEqual(legend.map((l) => l.value), ['33.3%', '33.3%', '33.3%']);
    assert.equal(slices.length, 3);
  } finally { close(dom); }
});

test('a competency the capped paper never reached has no slice and reads "not assessed"', { skip: SKIP }, async () => {
  const { dom, legend, slices } = await render(report([comp('Arch', 60, 84), comp('Advisory', 40, 80), comp('FinOps', 20, null)]));
  try {
    assert.deepEqual(legend.map((l) => [l.name, l.value, l.untested]), [
      ['Arch', '60%', false], ['Advisory', '40%', false], ['FinOps', 'not assessed', true],
    ]);
    assert.equal(slices.length, 2, 'only assessed competencies are slices');
  } finally { close(dom); }
});

test('the legend matches the overall blend computeReport produced', { skip: SKIP }, async () => {
  // 30/30/40 configured; the paper reached only the first two, so the blend
  // is 50/50 of those two. The legend must say so.
  const competencies = [comp('One', 30, 100), comp('Two', 30, 50), comp('Three', 40, null)];
  const blended = (100 * 30 + 50 * 30) / 60;
  const { dom, legend } = await render(report(competencies, blended));
  try {
    assert.deepEqual(legend.map((l) => l.value), ['50%', '50%', 'not assessed']);
    const shares = legend.filter((l) => !l.untested).map((l) => parseFloat(l.value) / 100);
    const recomposed = shares[0] * 100 + shares[1] * 50;
    assert.equal(Math.round(recomposed * 10) / 10, Math.round(blended * 10) / 10, 'shares x scores = the overall score');
  } finally { close(dom); }
});

test('weights of a published track (sum 100, all assessed) read exactly as configured', { skip: SKIP }, async () => {
  const weights = [18, 18, 14, 14, 12, 12, 12];
  const { dom, legend, slices } = await render(report(weights.map((w, i) => comp(`C${i}`, w, 70))));
  try {
    assert.deepEqual(legend.map((l) => l.value), weights.map((w) => `${w}%`));
    assert.equal(slices.length, 7);
  } finally { close(dom); }
});

test('all-zero weights fall back to equal shares, as the scoring blend does', { skip: SKIP }, async () => {
  const { dom, legend, slices } = await render(report([comp('A', 0, 70), comp('B', 0, 50), comp('C', 0, 90), comp('D', 0, 10)]));
  try {
    assert.deepEqual(legend.map((l) => l.value), ['25%', '25%', '25%', '25%']);
    assert.equal(slices.length, 4);
  } finally { close(dom); }
});

test('one competency carrying the whole score is drawn as a full disc, not an empty arc', { skip: SKIP }, async () => {
  const { dom, legend, slices } = await render(report([comp('Only', 60, 70), comp('Skipped', 40, null)]));
  try {
    assert.deepEqual(legend.map((l) => l.value), ['100%', 'not assessed']);
    assert.equal(slices.length, 1);
    const arcs = slices[0].match(/A /g) || [];
    assert.equal(arcs.length, 2, `a full disc is two half arcs: ${slices[0]}`);
    // Both arc endpoints differ from their start points, so the disc paints.
    assert.match(slices[0], /^M 50 8 A 42 42 0 1 1 50 92 A 42 42 0 1 1 50 8 Z$/);
  } finally { close(dom); }
});

test('the candidate copy of the report shows the same shares', { skip: SKIP }, async () => {
  const { dom, legend } = await render(report([comp('Arch', 50, 80), comp('Advisory', 25, 60), comp('Ops', 25, null)]), 'candidate');
  try {
    assert.deepEqual(legend.map((l) => l.value), ['66.7%', '33.3%', 'not assessed']);
  } finally { close(dom); }
});

test('computeReport and the legend agree on a real framework run', { skip: SKIP }, async () => {
  // Drive the real scorer: three equally weighted competencies, and the
  // paper covers only two of them.
  const snapshot = {
    competencies: [
      { id: 'c1', name: 'Design', weight: 50, target_level: 4 },
      { id: 'c2', name: 'Delivery', weight: 50, target_level: 4 },
      { id: 'c3', name: 'Cost', weight: 50, target_level: 4 },
    ],
    questions: [
      { id: 'q1', competency_id: 'c1', type: 'mcq_single', prompt: 'Q1', points: 4 },
      { id: 'q2', competency_id: 'c2', type: 'mcq_single', prompt: 'Q2', points: 4 },
    ],
  };
  const real = computeReport(snapshot, { q1: { auto_score: 4 }, q2: { auto_score: 2 } });
  assert.equal(real.overall_pct, 75, 'the blend is 50/50 over the two assessed competencies');
  const { dom, legend } = await render({ ...real, role: { name: 'T' } });
  try {
    const byName = Object.fromEntries(legend.map((l) => [l.name, l.value]));
    assert.deepEqual(byName, { Design: '50%', Delivery: '50%', Cost: 'not assessed' });
  } finally { close(dom); }
});
