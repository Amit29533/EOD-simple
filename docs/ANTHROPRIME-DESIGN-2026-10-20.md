# Anthroprime visual alignment — 20 October 2026

## Design

Both https://anthroprime.com/ and https://anthroprime.ai/ were inspected in the browser. ECOD now uses their shared visual language:

- Warm ivory (`#f5f4f1`) and paper surfaces (`#faf9f7`), navy navigation and indigo actions (`#2e4080`), with muted gold accents.
- Cormorant Garamond for page headings and brand typography; DM Sans for working content and controls; DM Mono for timers and small technical labels. System fallbacks remain available.
- Fine warm borders, consistent small corner radii, quieter surfaces and steady controls. The existing AP vector logo is preserved.
- A corresponding dark palette with readable action text, selections and report chart colours. Print uses the light palette.

The shared stylesheet applies the treatment to sign-in, public booking, administration, candidate journeys, assessments, assessor work and reports. Assessment questions remain in sans-serif. This pass does not change scoring, schedules, exam timing, account permissions or API contracts.

## Layout fixes found during review

1. The modal backdrop's implicit grid track could let a 640px dialog exceed a phone viewport. Its track now permits shrinking; headers and actions stay visible while long form contents scroll.
2. The question bank's nested tables could widen the whole page or become clipped inside module cards. They now scroll within their own containers; module table regions are keyboard reachable.
3. Report identity and status competed for width on small phones. They now stack, with readable status text and a flexible readiness summary.
4. Dark theme primary actions, selected controls and chart surfaces now use appropriate foreground and background tokens.
5. Print could sample intermediate screen-theme transition colours. Print now disables transitions and animations, including the body transition.
6. Dashboard panels no longer inherit the height of a taller neighbouring column. Empty states use less space.

## Browser verification

Checks used an isolated synthetic JSON store at `http://127.0.0.1:3130/`, separate from the normal local application data.

- All nine admin destinations: dashboard, candidates, assessments, bookings, roles, question bank, users, audit and settings.
- Desktop at 1280px; mobile at 390px; all nine admin pages additionally checked at 768px and 320px in dark mode. No page-wide horizontal overflow remained. Wide tables retain intentional internal scrolling.
- Candidate journey, rules gate and live MCQ selection; timer readability and navigation hiding checked. The existing 30-second MCQ / 30-second open review / 60-second open recording rules remain intact.
- Public booking form at desktop and 320px, and booking invitation creation from the mobile admin interface.
- Assessor workspace, finalized report and answer-sheet/recording navigation at tablet width.
- Report at 320px and 768px; print-media computed colours verified from dark mode: white page, light report surfaces, navy ink, light chart tokens, zero transition duration.
- Reduced-motion preference disables heading and metric entrances. No browser console errors or warnings were captured during the final review.
- Temporary viewport and print/motion emulation were cleared after review.

The contrast spot checks inspect visible text against solid ancestor backgrounds. They are a useful diagnostic, not a complete accessibility certification or a substitute for assistive-technology testing.

## Automated verification and evidence

Results and screenshots are saved locally under `.probe/anthroprime-design-20261020/` (ignored by Git).

- The focused UI/theme suite passed all 56 tests.
- `npm run test:http`: smoke suite passed; feature checks 237/237; gauntlet checks 76/76.
- Final full suite: **856 tests, 854 passed, 0 failed, 2 skipped** (`node --test --test-concurrency=1 tests/*.test.mjs`, 499.6 seconds). The two skips concern unavailable SAMA source-workbook checks.
- An initial concurrent full run passed 853 tests, skipped two, and failed one latency threshold while other test suites were running. The unchanged performance suite then passed all 11 tests in isolation, and the final serial full run passed that benchmark too. No performance threshold was relaxed.
- Syntax checks passed for the touched runtime JavaScript modules; `git diff --check` passed.

Useful visual evidence: `login-desktop.png`, `candidate-modal-mobile.png`, `exam-mobile.png`, `report-320-dark.png`, and `admin-dashboard.png`.

Everything remains local. No deployment or Git push was performed.

## Alignment follow-up

The Question Bank track selector and Import/Add/Preview actions now live in a separate toolbar, aligned along their control bottoms instead of competing with the page description.

At the user's request, the user-table actions were restored to their original single-line layout. The table scrolls horizontally when extra buttons need more room, with a larger horizontal scrollbar. The fixed column widths and stacked action groups were removed. Shared actions are left-aligned within the action cell so Edit, Reset password and Recovery link occupy the same positions for every account, even when the protected admin has fewer actions. Browser keyboard scrolling and matching button positions across all five demo accounts were verified; all seven user-view/theme checks passed.

Verified at 1280px and 390px. Track switching, the Import dialog and the admin Edit dialog still work. The 25 user/admin/theme tests and 22 module-view tests passed (47 total). Screenshots are in `.probe/alignment-fixes-20261020/`.
