# ECOD whole-app audit and persona verification

20 October 2026 · Windows · Node 24.21.0 · local branch `main`, based on
`41a9c89051a6439b11d064f371f385ed31f1e5bf`.

## Assessment

The assessment product has a working candidate → exam → assessor → report
journey. This audit found and fixed data-preservation, cancellation, deletion,
authentication, recovery, navigation and UI problems that the previous passing
happy-path runs did not expose. The scope includes the earlier uncommitted booking
changes. Nothing was pushed to GitHub or deployed.

This is not a claim that the app is perfect or that every possible execution has
been verified. The trainer/independent-validator modules and several scheduling
and production-operational capabilities below are still incomplete or unverified.

## Scope and method

- Reviewed the application structure, shared API and its **85 registered routes**,
  auth/MFA/recovery, audience projections, allocation/scoring, candidate exam state,
  bookings, deletion, retention, storage adapters, HTTP/Netlify wrappers, browser
  views, UI helpers, stylesheet behavior and CI configuration.
- Inspected previous audit findings against current source rather than treating
  old reports as the current result. Generated banks were checked separately.
- Exercised real handlers with disposable JSON stores, storage failure injection,
  timing boundaries, retry/recovery, concurrency fixtures and complete published
  track journeys. Added 18 automated regression tests and strengthened existing
  assessor, HTTP, route-guard and shell tests.
- Expanded the route/role matrix to **admin, assessor, candidate, trainer and
  validator**, alongside anonymous callers. With the current router this checks
  390 authenticated route/role combinations plus anonymous denial checks.
- Used a real browser against a separate demo store on localhost:3130. Production
  candidates, accounts, recordings and cloud storage were not accessed or changed.

## Problems fixed

P1 means a material data, access or workflow-integrity risk. P2 affects ordinary
functionality or recovery. P3 is misleading copy or presentation.

| Priority | Finding | Fix and evidence |
| --- | --- | --- |
| P1 | A corrupt local database started as an empty writable store, allowing a later operation to replace it. | Fail startup with `STORE_CORRUPT`; preserve original bytes. Tests cover truncated JSON, null/array roots, malformed tables and records. |
| P1 | Unreadable answer shards or recording files looked like absent evidence. A subsequent write could replace them. | Refuse reads/writes on corruption; validate response-shard shape for both JSON and Blobs paths. Tests restore the original fixture and confirm evidence remains readable. |
| P1 | A cancelled booking left its exam assigned/in progress. It could later expire into the scoring queue and block a replacement. | Add a terminal Cancelled assessment state, close it under the exam lock, repair interrupted cancellation on access and refuse assessor review/finalization. |
| P2 | Deleting a booked exam left its slot advertised with a dead exam link. | Cancel its booking before removing the attempt; dashboard repair cannot recreate it. |
| P1 | An invalid booked start time could silently fall back to an unscheduled attempt. | Fail closed, keep the attempt unopened and show an unavailable-schedule state. |
| P2 | Submitted/scored exams remained in Upcoming tests until their scheduled closing time. | Project the linked assessment status, remove finished attempts immediately and show them in completed history with their real status. |
| P1 | Ordinary candidate deletion could remove a report finalized after its initial read. | Reuse the guarded person-cleanup service, acquire the relevant identity/allocation/exam locks and recheck finalized status before deletion. |
| P1 | Failure during ordinary deletion could leave an active login and allow new allocations while cleanup was incomplete. | Mark the candidate deleting and disable accounts before cleanup; a retry safely completes the removal. Ordinary deletion still protects finalized reports and retains audit history. |
| P2 | Shared form handling stripped leading/trailing password characters, breaking password changes for valid booked accounts. | Preserve password input exactly; real account-security UI/API regression verifies the resulting credentials. |
| P2 | Admin accepted email addresses longer than 100 characters, but email sign-in truncated them to 100. | Match the supported 200-character limit without truncation; reject oversized identifiers. |
| P2 | Failed availability refresh rejected without recovery and replaced the journey with a loading screen. | Retain the existing journey, show the error and re-enable refresh. |
| P2 | Refreshing the journey could remove microphone-practice controls while leaving capture active. | Dispose the old practice recorder/stream and unregister cleanup before replacing the panel. |
| P2 | Future and cancelled attempts were counted as ready to enter. | Separate upcoming from ready counts, exclude blocked states and adapt the responsive summary grid. |
| P2 | Invalid scheduling dates crashed booking tables and candidate screens. | Share a safe IST formatter that displays a missing-date marker rather than throwing. |
| P2 | A failed request after entering the exam gate could leave an unhandled rejection and no recovery control. | Await entry, restore the acknowledgement and provide Retry exam entry. Explain that a request may already have started the server clock. |
| P2 | Some prompts and microphone guidance still promised two minutes despite the new 60-second answer window. | Adapt only the old open-answer timing directive at serve time and update guidance. Scenario facts, objective questions, raw banks and saved snapshots are preserved. |
| P2 | Immediate finalization omitted the link to the answer sheet/recordings, though reopening the scored report included it. | Use one assessor report renderer in both paths; regression checks immediate evidence access. |
| P2 | Skip to content changed the SPA route to `#view`, sending keyboard users home. | Prevent route navigation and focus the current main content. Reproduced and verified in both browser and shell tests. |
| P2 | Unversioned JavaScript/CSS could remain cached for an hour, so reloads displayed an old UI against the updated API. | Require revalidation for code/styles, retaining ETags and 304 responses. Apply the policy locally and in Netlify configuration; real HTTP regression covers 200/304 headers. |
| P3 | Placeholder portals implied an admin could enable functionality that does not exist yet; offline copy promised all work was saved. | Clearly label planned portals and unsaved-work limitations. Correct empty-upcoming and cancellation guidance. |

Functional regressions were demonstrated failing before their fixes. Copy/layout
corrections were checked through the relevant existing UI/browser tests rather
than adding tests that merely repeat their implementation.

## Candidate point of view

Real-browser checks:

1. Opened a newly generated invitation without signing in; available dropdown
   offered RSA/AI-BI/SAMA and excluded the empty Senior Consultant bank.
2. Entered synthetic details. A password mismatch retained the form and did not
   consume the invitation. Correcting it created the profile, login and SAMA paper.
3. Signed in with the new email. The direct exam URL showed the future window and
   refused early entry. My Journey displayed one upcoming exam and zero ready ones.
4. Moved only this disposable fixture's schedule into the present. Entered through
   the acknowledgement gate, answered and locked an MCQ, then refreshed on question
   two. The same question and remaining clock were restored.
5. Completed the remaining paper through the real API using synthetic answers and
   audio, then returned to the UI for scoring/report verification. This portion
   was not a physical-microphone candidate sitting.
6. After assessor finalization, signed back in as the candidate. The report became
   available, the pipeline moved to Gap Mapping and internal assessor/question
   details stayed hidden.
7. Checked journey and report at a 390-pixel browser viewport; document width did
   not exceed the viewport. Restored the browser viewport afterward.

Automated checks additionally cover both email/generated-username login,
ownership, early/direct API access, saved drafts, spoken-answer fallbacks,
duplicate locks, failed uploads/saves, clock boundaries, late entry, never-opened
expiry, logout/relogin, submission and post-window report access. Full published
journeys run for SAMA (30 questions / 5 open), RSA (50 / 20) and AI/BI (50 / 20).

## Assessor/tester point of view

- The browser queue showed assigned work, prioritized the submitted synthetic
  paper and offered no scoring action on an unsubmitted one.
- Opened the paper, filtered to open questions, entered five scores and confirmed
  `5/5 open questions scored` and `All changes saved`.
- Five synthetic one-second WAV recordings loaded and decoded with duration 1,
  readyState 4 and no media errors. This verifies real browser retrieval/decoding;
  it is not proof of speech quality or physical-microphone capture.
- Finalized through the confirmation dialog. The sample report showed 31.7%,
  reflecting deliberately synthetic answers rather than a real person's outcome.
- Reopened the evidence link: score controls were disabled, finalization was
  absent and recordings remained accessible. Current served timing instructions
  matched the 60-second answer budget.
- Automated suites exercise out-of-range marks, failed/out-of-order saves,
  retry, finalization gating, retained evidence, playback-error recovery,
  reassignment, ownership and retention behavior.

## Administrator point of view

Loaded all nine main browser screens: Dashboard, Candidates, Assessments,
Test bookings, Roles & Frameworks, Question Bank, Users & Access, Audit Log and
Settings. Created a single-use invitation, checked booking/profile linkage and
verified the finished attempt moved from Upcoming tests to Scored history.
The final browser check confirmed Skip to content preserves the bookings route
and focuses `#view`. Browser error/warning inspection returned no entries for the
checked final report journey.

Automated admin/API/UI checks additionally cover CRUD, imports/dry runs,
allocation previews and frozen papers, assessor assignment, user protections,
password changes/recovery/MFA, retention, guarded deletion, audit history,
pagination, malformed requests and cross-role/cross-person denials.

## Essential-feature inventory

| Capability | Current assessment |
| --- | --- |
| Intake, linked candidate accounts, manual-email single-use booking | Present and exercised. |
| Target-exam selection, automatic frozen allocation, scheduled two-hour access | Present and exercised, including invalid/early/expired requests. |
| Timed exams, answer autosave/locking, recording recovery, submission | Present and exercised. Physical-device acceptance remains outstanding. |
| Assessor allocation, scoring, finalization, candidate-safe reports | Present and exercised. |
| Admin configuration, question authoring/import, candidate import, audit and retention | Present; covered by UI/API/HTTP regressions. |
| Session revocation, password change, admin-issued recovery and optional MFA | Present. MFA requires its server encryption configuration. |
| Dedicated rescheduling UI, existing-account public rebooking, formal retake/accommodation policy | Partial. Existing-account manual allocation exists; these scheduling/support workflows are not implemented as a complete self-service feature. |
| Trainer/enrichment and independent-validator portals | Not implemented; currently explicit planned-module placeholders. Manual pipeline stage changes are not those modules. |
| Automatic invitation/reminder email delivery | Not implemented; manual email remains the requested design. |
| Backups/restoration, live deployment isolation, monitoring and exam-cohort capacity | Not certified by a local audit; require staging/operational evidence. |

The core assessment MVP is present. The entire advertised seven-stage talent
journey is not yet an implemented end-to-end product. Building those modules
requires workflow/acceptance decisions rather than relabeling placeholders.

## Code quality and stability

Strengths include a shared transport-independent API, centralized role/ownership
guards, safe audience projections, frozen papers, pure scoring/selection logic,
shared storage primitives and broad failure/concurrency regressions. This audit
also removed duplicated ordinary-deletion logic and consolidated schedule/report
formatting so behavior cannot drift as easily.

The admin handler and admin/candidate view modules remain large. Future changes
would benefit from extracting feature services/views with explicit lifecycle
ownership rather than adding more responsibilities to those files. A full
framework rewrite is not necessary to fix the demonstrated bugs and was not
performed as part of this audit.

Important remaining boundaries:

- Process-local locks and multi-record workflows are not a distributed database
  transaction. Mocked Blobs CAS tests do not certify all separate-instance
  registration, finalization, reassignment and deletion interleavings. Airtable
  lacks equivalent conditional-write guarantees.
- Login/rate budgets are process-local. Real deployed limits, concurrent exam
  uploads and failure/recovery behavior require an isolated staging/load run.
- Source/bank validation does not establish the domain accuracy of every answer
  key or rubric. Content-owner review remains necessary.
- Physical microphones, mobile device recording, Safari/Firefox, permission
  prompts and assistive-technology acceptance were not certified. No physical
  microphone permission was granted during this browser audit.
- Two SAMA extraction/regeneration checks require the missing
  `SAMA Question bank 1.2.xlsx`; checked-in SAMA exam workflows do run.
- Clients holding the previous one-hour code cache can require one hard refresh
  to discard it. The final browser verification used a one-time hard refresh;
  no persistent browser security/cache setting was disabled.

## Verification results

The final full run on the completed changes passed: **856 tests, 854 passed,
zero failed, two skipped**, in **142.00 seconds**. The two skips require the
missing SAMA source workbook. The final real HTTP smoke/feature/gauntlet run
also passed after the static-cache correction.

Already verified:

- Baseline: 838 Node tests, 836 passed, two skipped, zero failures.
- Final full regression, including the static-cache and keyboard fixes:
  856 tests, 854 passed, two skipped, zero failures.
- Latest static-cache/transport/performance regressions: 49 passed, zero failed.
- HTTP smoke passed; feature suite 237/237; gauntlet 76/76.
- Published-bank audit: 863 records passed without structural failures.
- `npm audit --audit-level=moderate`: zero reported vulnerabilities.
- Syntax checks: all 89 runtime/frontend/function/script modules passed;
  `git diff --check` passed.

New regression files are `tests/audit-storage-integrity.test.mjs`,
`tests/audit-booking-lifecycle.test.mjs`, `tests/audit-candidate-deletion.test.mjs`,
`tests/audit-ui-workflows.test.mjs`, `tests/audit-exam-instructions.test.mjs` and
`tests/audit-login-identifiers.test.mjs`. Existing route, shell, assessor and HTTP
tests were strengthened as well.

Logs and screenshots are retained locally in
`.probe/whole-app-audit-20261020/` (ignored by Git). Examples:

- [Candidate receipt](../.probe/whole-app-audit-20261020/candidate-booking.png)
- [Scheduled-access gate](../.probe/whole-app-audit-20261020/candidate-scheduled-gate.png)
- [Live exam](../.probe/whole-app-audit-20261020/candidate-live-exam.png)
- [Candidate report](../.probe/whole-app-audit-20261020/candidate-report.png)
- [Mobile report](../.probe/whole-app-audit-20261020/candidate-report-mobile.png)
- [Final bookings/history screen](../.probe/whole-app-audit-20261020/admin-bookings-fixed.png)

No live candidate data, emails, GitHub commits/pushes or deployments were part
of this audit. The local preview uses a separate synthetic database.
