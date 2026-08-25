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
