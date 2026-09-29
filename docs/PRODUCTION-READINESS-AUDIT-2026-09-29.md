# ECOD production-readiness audit

Date: 29 September 2026
Target: Netlify SPA + Functions + Netlify Blobs
Scope: admin, assessor, candidate, storage, authentication, assessment lifecycle, deployment, recovery, and missing product controls.

## Decision

ECOD is suitable for controlled internal pilots after the launch blockers below are closed. It is not ready for high-stakes or high-concurrency production exams yet. The assessment logic and automated coverage are substantial, but storage isolation, audio concurrency, multi-record consistency, authentication operations, recovery, and deployment gates still need work.

The current suite contains 725 tests: 722 pass, 3 are intentionally skipped, and none fail. The affected production paths changed in this audit pass 93 focused tests.

## Fixed in this worktree

### Per-role allocation policy

- Added a role-owned default allocation policy.
- Kept RSA and AI/BI at 50 questions.
- Set SAMA to exactly 30 questions: 25 objective and 5 open.
- Wired the same policy into manual allocation, automatic allocation, CSV import, catalogue defaults, the admin editor, and API validation.

### Exam cursor integrity

- Replaced stale whole-assessment writes in exam opening, integrity beacons, manual phase changes, and automatic review expiry with conditional mutations against the latest stored row.
- Added the current question ID to phase requests so a delayed Q1 request cannot change Q2 or restart Q2's timer.
- Integrity events are now attached to the question that is current when the event commits.

### Corrupt Netlify Blobs data

- A malformed table blob now fails closed with `STORE_CORRUPT` and an HTTP 503 response.
- The original blob remains untouched for recovery. A request can no longer silently replace malformed persisted data with an almost-empty table.

### Deployment baseline

- Changed Netlify and `package.json` from Node 20 to Node 24. Node 20 reached end of life on 24 March 2026.
- Made `@netlify/blobs` a required runtime dependency and `jsdom` a development dependency.

### Test reliability

- Fixed a Windows URL/path conversion in the Airtable schema test.
- Marked the Unix directory-permission simulation as unsupported on Windows instead of reporting a false failure.
- Corrected a flaky SAMA spacing assertion: an unconstrained 50-question sample can contain a majority of open questions, so the test now verifies the mathematically shortest possible runs for the selected mix. The invariant passed ten additional randomized runs.

## Launch blockers

### 1. Deploy Previews can modify production data

`src/storage/netlify-blobs.mjs` opens `getStore('ecod')`. Netlify documents `getStore` as site-wide and available to every deploy context. A branch or Deploy Preview can therefore read, update, or delete the same candidates, sessions, answers, and reports as production.

Use a separate Netlify project for staging, or disable data-changing previews and give preview contexts a separate store/site. This must be verified in Netlify configuration, not only in application code.

Reference: https://docs.netlify.com/build/data-and-storage/netlify-blobs/#getstore

### 2. A losing audio draft can replace the locked recording

`saveRecording` in `src/api/handlers/candidate.mjs` updates one deterministic recording row before the response CAS decides whether the response is already locked. A concurrent `/next` can lock answer A while a delayed autosave replaces its audio with B and then loses the response update.

Store recordings as immutable revisions. Publish the winning recording ID inside the same conditional response mutation, then garbage-collect unreferenced revisions asynchronously.

### 3. Scoring finalization is not atomic or resumable

`finalizeScoring` updates response scores, the assessment/report, and the candidate stage in separate writes. A timeout or storage failure can leave a partially finalized assessment. Similar multi-object risks exist in allocation/import and detached report persistence.

Introduce an idempotent finalization state machine with a job ID and checkpoints. The endpoint should be safe to retry and should expose `pending`, `complete`, or `failed` status. Longer term, move relational exam state to a transactional database.

### 4. Session revocation failures are reported as success

Logout, password reset, and user deactivation swallow some session-deletion failures. A browser may appear signed out while the bearer token remains valid on the server.

Make revocation failure visible, retry it, record it in the audit trail, and fail password reset/deactivation until all target sessions are revoked. Store only token hashes server-side.

### 5. Authentication protection is instance-local

The login throttle is held in process memory. Netlify can run several function instances, and cold starts reset the counters. There is no MFA, account recovery, invitation flow, or administrator recovery procedure.

Move throttling and lockout state to a shared store or identity provider. Add expiring invitations, password recovery, administrator MFA, token rotation, and security-event alerts.

### 6. Recovery and operational health are missing

`/health` proves that the function can execute, but it does not read storage. There is no scheduled backup, restore command, recovery drill, alerting, or documented recovery objective.

Add a storage-integrity readiness probe, structured error reporting, scheduled exports to separate durable storage, a tested restore tool, and alerts for corruption, CAS exhaustion, login anomalies, submission failures, and finalization failures.

### 7. Confidential assessment material is shipped with the application source

Question banks include correct answers and assessor rubrics. If the repository or client/deployment artifact is public or shared broadly, the assessment is compromised even though the API does not send answer keys to candidates.

Keep source question banks in a private content repository or protected authoring store. Publish versioned, server-only assessment packages and rotate any bank that has already been exposed.

### 8. Deploys are not reproducible or gated

There is no committed dependency lockfile and no CI workflow. Netlify therefore resolves dependency versions at deploy time, and a deployment can publish without the automated suite passing.

Commit a lockfile, use `npm ci`, and add CI checks for syntax, unit/integration tests, question-bank validation, dependency audit, and a Netlify preview smoke test. Require those checks before merging to the production branch.

## Important hardening after the blockers

- Bearer tokens are stored in browser `localStorage`, and there is no Content Security Policy. Move sessions to `Secure`, `HttpOnly`, `SameSite` cookies, add CSRF protection, remove inline script requirements, and enable a restrictive CSP.
- Strong Blobs reads fall back to eventual consistency when the SDK rejects the option; writes also fall back to unconditional behavior when an ETag is unavailable. Production should fail closed when concurrency guarantees are unavailable.
- Netlify Blobs is a key/value store intended for simple unstructured data. ECOD models linked users, candidates, attempts, answers, recordings, reports, and audit events, while several adapters still rewrite or scan large logical tables. Establish load targets and migrate exam state to a transactional database before significant concurrency.
- The audit log is capped, has no external sink, and is editable through the same operational boundary as application data. Export append-only security and scoring events to a separate destination with a retention policy.
- Accessibility has automated DOM coverage but no documented keyboard, screen-reader, zoom, color-contrast, or microphone-denied acceptance run in real browsers.
- Candidate monitoring and microphone capture need an explicit privacy notice, consent record, retention period, deletion process, and jurisdiction-specific review.

References:

- Netlify Blobs consistency and storage model: https://docs.netlify.com/build/data-and-storage/netlify-blobs/#consistency
- Netlify storage comparison: https://docs.netlify.com/build/data-and-storage/overview/#comparing-netlify-database-and-blobs-storage
- Node release status: https://nodejs.org/en/about/previous-releases

## Missing features by role

### Candidate

- Password recovery and expiring first-login invitation.
- Clear exam window, due date, attempt number, retake policy, and submission receipt.
- Approved accommodations such as extra time, breaks, alternate audio handling, and accessible delivery.
- Consent and privacy controls for microphone recordings and integrity events.
- A support/recovery path for lost connectivity, microphone failure, or interrupted submission.

### Assessor

- Workload, due dates, service-level status, and reassignment history.
- Moderation or second marking for high-stakes decisions.
- Score revision with mandatory reason and an immutable before/after history.
- Calibration samples and rubric-version visibility.
- Structured candidate feedback and release approval.

### Admin

- Assessment scheduling, open/close windows, attempt limits, accommodations, and retake controls.
- Immutable role/question-bank versions with publish, retire, compare, and rollback.
- Import dry-run, impact preview, idempotency key, progress status, and rollback.
- Operational dashboard for storage, queue/finalization failures, backups, and active incidents.
- Retention, export, deletion, and legal-hold controls for candidate data and recordings.
- Email/notification delivery with templates, retry state, and delivery history.

### Validator and trainer

The roles exist, but their pages are placeholders and have no data workflow. Either remove them from account creation until implemented or build validation queues, disagreement resolution, enrichment plans, and completion tracking before presenting them as supported roles.

## Delivery plan

### Phase 1: controlled pilot gate

1. Isolate preview/staging data from production.
2. Implement immutable audio revisions and idempotent finalization.
3. Make revocation reliable and move login throttling to shared state.
4. Add backup/restore, storage readiness checks, monitoring, and incident alerts.
5. Commit a lockfile and require CI before Netlify production deploys.
6. Run real-browser journeys for candidate, assessor, and admin, including refresh, duplicate clicks, two tabs, offline/reconnect, expired timers, denied microphone access, and storage failures.

### Phase 2: production operations

1. Add scheduling, attempts, retakes, accommodations, invitations, recovery, and notifications.
2. Add immutable bank versions and scoring-change history.
3. Add moderation/validation and controlled report release.
4. Complete accessibility, privacy, retention, and recovery evidence.

### Phase 3: scale

1. Define concurrency, latency, storage, and recovery targets.
2. Load-test with realistic 30- and 50-question exams, recordings, autosaves, and integrity events.
3. Move relational state to a transactional database when the pilot load approaches the tested Blobs limit.
4. Keep object storage for large immutable recordings and exports.
