/** Printable report renderer test: branding and inline charts must remain present in the PDF view. */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const REPORT = {
  overall_pct: 82.5,
  band: { tone: 'green', label: 'Enterprise Ready', description: 'Ready for enterprise engagements.' },
  framework_name: 'ECOD Readiness Framework v1',
  role: { name: 'Resident Solutions Architect' },
  generated_at: '2026-08-25T10:00:00.000Z',
  competencies: [
    {
      name: 'Architecture', category: 'architecture', weight: 60, score_pct: 84,
      observed_level: 4, target_level: 4, gap: 0, status: 'met', earned: 42, max: 50,
      breakdown: [{ prompt: 'Design the platform', type: 'text', difficulty: 'advanced', score: 5, points: 6, scored_by: 'assessor' }],
    },
    {
      name: 'Advisory', category: 'advisory', weight: 40, score_pct: 80,
      observed_level: 4, target_level: 4, gap: 0, status: 'met', earned: 40, max: 50,
      breakdown: [{ prompt: 'Lead the workshop', type: 'mcq_single', difficulty: 'foundation', score: 4, points: 4, scored_by: 'auto' }],
    },
  ],
  areas_to_improve: [],
  strengths: [{ competency: 'Architecture', score_pct: 84 }],
};

test('report view includes Anthroprime branding and print-safe SVG charts', { skip: SKIP }, async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>', {
    url: 'http://localhost:3000/', pretendToBeVisual: true,
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    const { renderReport } = await import(`../public/js/views/report.js?report-test=${Date.now()}`);
    renderReport(document.getElementById('view'), {
      candidate: { name: 'Test Candidate', current_title: 'Platform Architect' },
      report: REPORT,
      assessor_name: 'Priya Nair',
      audience: 'admin',
    });

    assert.match(document.querySelector('.report-brand-copy strong').textContent, /Anthroprime/);
    assert.equal(document.querySelectorAll('.report-donut').length, 2, 'cover and visual summary donuts render');
    assert.equal(document.querySelectorAll('.report-pie path').length, 2, 'weight pie contains one slice per competency');
    assert.equal(document.querySelectorAll('.report-bar-row').length, 2, 'performance graph contains one bar per competency');
    assert.match(document.querySelector('.report-footer').textContent, /Anthroprime ECOD/);
    assert.match(document.querySelector('.report-stat-strip').textContent, /Questions evaluated/);
  } finally {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('a competency the capped paper never reached renders as "not assessed", never as 0%', { skip: SKIP }, async () => {
  const partial = JSON.parse(JSON.stringify(REPORT));
  partial.overall_pct = 100;
  partial.competencies.push({
    name: 'Cost Governance', category: 'finops', weight: 20, score_pct: null,
    observed_level: null, target_level: 4, gap: null, status: 'untested', earned: 0, max: 0,
    breakdown: [], recommended_focus: 'Unit economics of compute.',
  });
  partial.not_assessed = [{ competency: 'Cost Governance', competency_id: 'c3', weight: 20, target_level: 4, recommended_focus: 'Unit economics of compute.' }];
  partial.strengths = [{ competency: 'Architecture', score_pct: 84 }, { competency: 'Advisory', score_pct: 80 }];

  const dom = new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>', {
    url: 'http://localhost:3000/', pretendToBeVisual: true,
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    const { renderReport } = await import(`../public/js/views/report.js?report-test=${Date.now()}`);
    renderReport(document.getElementById('view'), {
      candidate: { name: 'Capped Candidate', current_title: 'Engineer' },
      report: partial, assessor_name: 'Priya Nair', audience: 'admin',
    });

    const text = document.getElementById('view').textContent;
    assert.match(text, /Not covered by this paper/, 'the coverage section is shown');
    assert.match(text, /Competency weight 20/);
    assert.equal(document.querySelectorAll('.report-bar-row').length, 3, 'still one row per competency');
    const untestedRow = [...document.querySelectorAll('.report-bar-row')].find((r) => /Cost Governance/.test(r.textContent));
    assert.ok(untestedRow.querySelector('.report-bar-fill') === null, 'no filled bar for an untested competency');
    assert.match(untestedRow.textContent, /not covered by this paper/i);
    assert.match(document.querySelector('.report-stat-strip').textContent, /2 of 3/, 'the stat strip states the coverage');

    // The breakdown table keeps a neutral cell rather than a red zero, for the
    // same reason: an unasked question is not a failed one.
    const row = [...document.querySelectorAll('tbody tr')].find((r) => /Cost Governance/.test(r.textContent));
    assert.ok(row, 'the competency still appears in the breakdown table');
    assert.match(row.textContent, /not assessed/i);
    assert.doesNotMatch(row.textContent, /\b0%/, 'no fabricated 0% score in its row');
    assert.match(row.cells[3].textContent.trim(), /—/, 'observed level is an em dash, never level 0');
  } finally {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  }
});
