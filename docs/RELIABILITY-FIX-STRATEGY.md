# ECOD fixing strategy

Implementation progress and rollout requirements: [Reliability implementation](RELIABILITY-IMPLEMENTATION.md). The continuous expiry fix is shipped; the next implementation adds immutable evidence, retry support, allocation previews, account recovery, optional MFA, and storage isolation. The implementation report explicitly lists the remaining portions of stages 2–6.

## Delivery order

1. **Continuous two-hour exam window — implemented in this change.** Enforce expiry in the API using the first exam-hall entry time; preserve saved responses and close the attempt for review. Show the rule before entry, remaining exam time during the exam, and a clear expired state on return. Validate boundary conditions, reopening, direct API calls, and assessor access.
2. **Immutable recordings and paper/report columns.** Introduce versioned objects referenced by the committed response/assessment. Preserve compatibility with old objects. Test competing draft/lock/finalize writes and failed parent commits against two independent Blobs adapters. Add delayed orphan cleanup and ensure full-person deletion removes all revisions. Ship this as a separate migration after the expiry change.
3. **Retry-safe operations.** Add durable operation identifiers for onboarding, allocation, submission/finalization, and person deletion. Persist progress and return a completed result on retry. Verify failure after each step, cross-instance replay, and resumed cleanup without duplicate users or papers.
4. **Consistent allocation preview.** Use the actual assessment-selection engine for previews and CSV/account onboarding. Keep existing assessment snapshots unchanged. Verify RSA/AI-BI defaults of 50 and SAMA's 25 objective + 5 open composition.
5. **Account and operational recovery.** Add expiring invitation/recovery tokens, stronger temporary credentials, shared throttling, administrator MFA, production/preview isolation, and backup/restore monitoring. Keep rollout configuration explicit and test restoration before claiming readiness.
6. **Fairness and quality.** Add approved timing accommodations, retake/support audit trails, scoring moderation, keyboard/screen-reader checks, and subject-matter review of generic distractors and rubrics. Run realistic staging load tests and a deployed synthetic candidate-to-report smoke test.

Each stage should have a small reviewable change, failure-path tests, a migration/rollback note where data format changes, and a full regression run before release. The existing robustness review contains the detailed risks and rationale.

## Two-hour expiry policy

- The server starts the window when the exam-hall request first changes the assessment from `assigned` to `in_progress`, after the browser rules acknowledgment. Viewing My Journey or reading the rules does not start it.
- Deadline is `started_at + 2 hours`, irrespective of browser closure, sign-out, tab switching, network failure, or a different device. Reopening never changes a valid start timestamp. Per-question timers continue to apply within this overall window.
- At or after the deadline, the API refuses further candidate answer/phase/advance/submit changes and returns no current question. The attempt becomes `submitted` with an expiry marker in its quiz state, keeping saved responses for assessor review. Unanswered questions remain unanswered and the assessor still scores open responses; expiry does not invent answers or marks.
- State is materialized on candidate access or administrator/assessor assessment listings/detail access. No browser-close beacon or scheduler is required to deny continuation. If no request occurs at the deadline, the stored status may remain `in_progress` until the next access; its effective deadline has already passed.
- Existing in-progress attempts with a valid start time use that original time, so attempts already older than two hours close on next access. Legacy attempts with no valid start recover it from their question clock on opening where available; otherwise a start is established on that opening. Assigned and already finalized attempts are unaffected.
- A new attempt requires administrator allocation; logging in again does not grant another window. Changing start times/resetting expired attempts is not exposed through the candidate API.

## Deployment and verification

The expiry marker uses the existing `quiz_state` JSON field and the deadline uses existing `started_at`; no Blobs schema migration is required. Deploy both API and browser modules together. Final regression run: **756 tests, 753 passed, 3 skipped, zero failures** (approximately 102 seconds). Six new tests cover the absolute boundary, first-entry/reopening behavior, saved-answer preservation, direct API bypass attempts, assessor access, and the expired candidate UI. Live Netlify behavior, background mass-expiry throughput, and network/device behavior require staging verification; no production attempts were edited for testing.

The existing multi-object write risks remain relevant to requests already in flight at the deadline. Immutable revisions and durable operations in stages 2–3 address those broader concurrency guarantees; the expiry boundary blocks requests arriving after the deadline independently of the client.
