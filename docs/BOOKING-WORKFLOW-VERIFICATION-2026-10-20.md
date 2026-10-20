# Booking workflow verification — 20 October 2026

Repository: Amit29533/EOD-simple. Local branch: main, based on
`41a9c89051a6439b11d064f371f385ed31f1e5bf`. Environment: Windows,
Node v24.21.0, JSON storage and disposable synthetic candidate data.
No GitHub push, deployment, email delivery, or production database changes.

## Result

All runnable automated checks passed after the three fixes below. The final
Node run completed in 133.95 seconds: **838 tests, 836 passed, 0 failed,
2 skipped**. The skips are the missing SAMA source-workbook checks described
under Verification limits. HTTP regression suites also passed.

## Workflow coverage

| Area | Verified behavior |
| --- | --- |
| Invitations | Admin-only creation, optional exam restriction, hashed token storage, invalid/expired/revoked links, one successful candidate per link, competing submissions, unchanged retries. |
| Candidate form | Required name, email, phone, exam, date/time in IST, password and confirmation; malformed dates, past slots, invalid phone/password and unavailable exams rejected before consumption. |
| Provisioning | Exactly one linked candidate, candidate-role login and frozen selected assessment; correct target track and Assessment stage; no credential hash or question-key disclosure in public/admin booking responses. |
| Recovery | Failures before profile creation, lost acknowledgements after candidate/user/exam writes, original credentials required on retry, safe dashboard repair, duplicate-email protection while provisioning is unfinished. |
| Main dashboard | New booking appears in Upcoming tests with profile linkage; setup failures stay visible; cancelled and expired windows leave the upcoming list. |
| Scheduled access | Direct exam and write APIs reject early access; no question delivery or clock start before opening; exact opening/closing boundaries; late arrival receives only remaining time. |
| Expiry | Fixed two-hour deadline anchored to the booked start; refresh and login cannot extend it; never-opened exams expire; saved answers survive; further answer/phase/advance/submit requests are refused. |
| Cancellation/deletion | Cancellation blocks an existing candidate session and keeps invitations consumed; permanent profile deletion includes the booking and prevents repair from recreating the person. |
| Authentication/ownership | Email and generated-username login, candidate role restrictions, another candidate denied access, logout invalidates the old session, sign-in resumes the same assessment cursor. |
| Exam timers | MCQ: 30 seconds; open-question review: 30 seconds; open-question answer: 60 seconds. Repeated phase requests cannot reset the answer clock. |
| Complete track journeys | Public booking through exam completion and assessor scoring for SAMA (30 questions, 5 open), RSA (50, 20 open), and AI/BI Genie (50, 20 open). |
| Recordings/reports | Synthetic audio saved as a draft, recovered on reload, retained on lock and submission, retrieved byte-for-byte by the assessor; scoring releases a candidate report which remains accessible after the booked window closes. |
| HTTP/persistence | Real local HTTP server serves the booking module, accepts anonymous booking requests, enforces single use and early-access rejection, survives restarts, preserves answers, and expires the exam after the stored deadline. |
| UI | Real frontend modules exercised in jsdom against the application API: form submission/receipt, retry retention, link creation/revocation, dashboard entry, candidate future-slot gate and scheduled exam rules. |
| Storage concurrency | Existing JSON/storage regression suite plus independent mocked Blobs adapters competing to consume the same invitation. |

Clock-dependent tests advance the test clock or move a disposable fixture's
schedule. They do not wait two real hours. Published-track journeys use the real
allocator, candidate API, recording storage, assessor API and report scorer.

## Issues reproduced and fixed

Each issue was demonstrated with a failing regression test before the fix.

1. **Interrupted signup could lose its email identity.** A second invitation
   could register the same email after the first slot committed but before its
   user existed. Committed automated bookings now reserve their email until
   recovery or cancellation. A second link stays unused when refused.
2. **Review timeout could cross the final deadline.** A delayed `/next` request
   could switch review into a fresh answer phase after the exam closed. The
   conditional transition now checks the global deadline and materializes expiry
   instead of opening an answer window.
3. **A provisioning failure could break the dashboard.** Continued failure to
   create one profile made the entire dashboard and booking list return 500.
   Per-booking repair failures now keep the slot visible as Setup pending,
   preserving the admin controls and allowing recovery on a later request.

Regression sources:

- `tests/booked-exam-automation.test.mjs`
- `tests/booked-track-journey.test.mjs`
- `tests/booked-workflow-http.test.mjs`
- `tests/test-bookings.test.mjs`
- `tests/test-bookings-ui.test.mjs`

## Commands and evidence

- `node --test --test-concurrency=4 tests/*.test.mjs` — final result recorded above.
- `npm run test:http` — smoke suite passed, feature checks **237/237**,
  final gauntlet **76/76**, all against disposable stores.
- `npm run bank:audit` — **863 pass, 0 fail**.
- `npm audit --audit-level=moderate` — **0 vulnerabilities reported**.
- `git diff --check` and syntax checks for changed handlers/new tests — passed.

Raw verification logs are retained locally under
`.probe/booking-verification-20261020/` (ignored by Git).

## Verification limits

- Two existing SAMA workbook tests cannot run because
  `SAMA Question bank 1.2.xlsx` is absent. Published SAMA allocation, exams,
  recordings and scoring were exercised successfully using the checked-in bank.
- The browser tool rejected observation of the saved preview tab under its URL
  policy. This run therefore provides HTTP and automated DOM/UI evidence, not a
  fresh live-browser visual or physical-microphone/playback check. Audio fixtures
  verify storage/recovery and retrieval, not real microphone permissions/codecs.
- No live Netlify/Blobs or Airtable environment was changed or tested. Mocked
  concurrency checks do not certify multi-instance provisioning or Airtable's
  weaker conditional-write behavior. This remains local feature verification.
- Email is intentionally manual, so no delivery was tested. Localhost links are
  usable only on the host computer until a reachable environment is provided.
- Expiry is enforced from the stored timestamp and materialized on access; it
  does not rely on a background scheduler running at the exact closing second.
