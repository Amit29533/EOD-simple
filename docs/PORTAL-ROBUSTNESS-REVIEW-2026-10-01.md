# ECOD reliability and role workflow review

Review date: 1 October 2026. Repository: EOD-simple. Hosting target: Netlify with Netlify Blobs.

## Scope and evidence

Reviewed the shared API, candidate exam state transitions, assessor scoring and reports, account administration, storage adapters, question selection, published banks, and Netlify transport/configuration. Exercised the existing candidate, assessor, administrator, access-control, UI, HTTP, and storage test suites. Added targeted failure tests for the fixes below.

This is a source and local synthetic-data review. It does not inspect the production Blobs database, certify live question content, test a real microphone, establish a supported concurrent-candidate capacity, or verify the live deployment. Local Blobs test doubles exercise conditional writes but cannot prove the platform's deployment behavior.

## Architecture and workflow

The browser is a JavaScript-module SPA. The local HTTP server and Netlify function call the same transport-independent API. Role guards and ownership checks sit in the API rather than relying on hidden UI controls. Assessments save a frozen question/framework snapshot; editing a role or bank later should not change a candidate's existing exam. Reports use weighted competencies and a saved scoring framework.

Candidates receive allocated assessments, follow the server's question/phase cursor and clock, save drafts, lock answers when advancing, and submit for review. Assessors review assigned submitted papers, score open responses, listen to recordings, and finalize reports. Administrators manage roles, question banks, users, allocations, validation, retention, and password-gated person deletion.

Blobs storage splits response shards, recordings, and heavy paper/report columns out of the main tables. Conditional writes protect supported table/shard changes. Application locks are process-local; they do not provide a transaction across multiple function instances or multiple objects.

## Fixes and features implemented

| Perspective | Problem | Result |
| --- | --- | --- |
| Assessor | UI treated a changed mark as saved before the request succeeded. Failed requests left no persistent recovery control. | Visible saving/failed/saved status and retry without retyping. Finalization requires successful saves. |
| Assessor | Score and comment requests could arrive out of order and overwrite newer marks. | Serialized immutable request snapshots; finalization waits for the queue, including edits queued during an earlier save. |
| Assessor | Editing could race with finalization; leaving could discard failed saves. | Inputs lock during finalization; pending/failed saves warn on page unload and clicked navigation/sign-out. Browser history/hash changes are not a guaranteed navigation blocker. |
| Candidate | A late draft could write an old `assigned` state back as `in_progress` after another request had changed the assessment. | Status initialization uses a conditional read of the current assessment state. |
| All roles | Generated credentials had no self-service replacement workflow. | Change password in the account sidebar, requiring the current password and confirmation. Other sessions are revoked; the current session remains usable. |
| Admin/security | Password reset and deactivation relied on best-effort session-row deletion. Storage failure could leave old tokens usable. | Rotating user/session generation invalidates old tokens independently of physical row cleanup. Legacy accounts/sessions work until their first rotation. Login and credential changes share the identity lock within an instance. |
| All roles | Malformed or missing session expiry could be accepted because an invalid date compared false. | Invalid and expired session dates are rejected. |
| All roles | Logout swallowed storage failures and presented success. | Failed server revocation is surfaced and sign-out can be retried. |
| All roles | Request deadlines ended when response headers arrived, allowing body reads to hang. Most requests had no application deadline. | Default 20-second deadline covers fetch and body parsing; callers can override it. Mutations are not automatically retried because a timed-out write may already have committed. |
| Scoring | Finalization trusted persisted manual scores without validating bounds and scalar type. | Invalid, empty, negative, non-finite, structured, or excessive scores block report generation. |
| Netlify/security | Users could come from a five-second cache during authorization. | Users join sessions and exam state in uncached strong-read requests. The adapter's existing eventual-consistency fallback remains a deployment risk. |

Airtable provisioning now includes session generation and session update timestamps. An existing Airtable deployment must run its normal schema setup before using these changes. JSON and Blobs require no manual schema migration.

## Question banks and allocation

The source bank audit passes all 863 records across six pools:

| Track | Published catalogue | Module bank | Default automatic allocation |
| --- | ---: | ---: | ---: |
| RSA | 115 | 348 | 50 |
| AI/BI & Genie | 100 | 100 | 50 |
| SAMA | 100 | 100 | 30 (25 objective, 5 open) |

These are separate pools, not 863 unique exam questions. The audit detects duplicate prompts and structural errors within the published pools. It does not establish subject-matter correctness or detect every semantic paraphrase.

The module-test preview and actual assessment allocation use separate selection models. AI/BI's module blueprint totals 31 while its role's automatic assessment default is 50. This is an admin consistency gap: consolidate the preview onto the actual allocation engine before using it to promise an exam's shape. Existing saved exams should retain their snapshot.

Some banks reuse generic distractors, and RSA single-answer positions are uneven. Prioritize a subject-matter review of answer options, explanations, difficulty, and open-response rubrics. Do not automatically delete questions merely because they assess related controls. The earlier live SAMA count of 140 cannot be reconciled with the published 100 without inspecting its production rows.

## Remaining production priorities

### 1. Storage correctness across function instances

Recording rows still use a mutable `(assessment, question)` object. A losing draft can replace audio before the response's conditional write rejects it. The initial locked-response check narrows the race but cannot close it. Use immutable recording revisions referenced by the committed answer, then garbage-collect abandoned revisions with a grace period. Include races between draft/next/submit/deletion and migration of old recordings in the rollout tests.

Detached paper/report columns also use mutable object keys written before the parent table update. A parent failure or competing writer can expose a mismatched column, and warm-instance column caches can retain old content. Version these objects and commit their reference with the parent row; preserve old markers during migration. Scoring/finalization and onboarding affect several objects and need durable operation IDs, resumable steps, or a transactional database to provide stronger guarantees.

The Blobs adapter falls back to eventual reads when strong reads are unavailable, and compatibility paths can make writes unconditional when metadata/CAS support is absent. Production should validate and require these capabilities rather than assume test-double success establishes correctness.

### 2. Account protection and recovery

The requested first-name plus four-digit generated-password pattern is easy to guess; preserve the requested UI pattern for now but offer stronger random temporary credentials and first-login replacement before broad public use. Add invitations/recovery with expiring single-use tokens and an administrator MFA workflow. Login throttling currently lives in memory per warm function instance, so it is not a distributed limit. Apply durable/shared limits or a platform gateway policy.

### 3. Operational recovery

Use a separate store/site for previews and production. The adapter currently names its store `ecod`; deployment credentials and context determine what it can access. Verify isolation before granting preview writes. Add scheduled encrypted backups, tested restore procedures, operational error alerts, and a support workflow for interrupted exams. Exercise a failed deletion/retention sweep and resume it without resurrecting accounts or removing another person's data.

### 4. Candidate fairness and accessibility

Add explicit per-assessment time accommodations, keyboard/screen-reader acceptance testing, and documented support for unsupported speech-recognition browsers. Keep typed-response fallbacks and microphone permission/error guidance visible. Define how administrators handle an interrupted exam, exceptional retake, or invalidated attempt, with an audit trail and clear candidate status.

### 5. Assessor quality and administrative consistency

Add moderation/second review for borderline outcomes, reusable rubric anchors, and an explicit reassignment handover that preserves saved feedback. Consolidate exam preview and actual allocation. Audit CSV onboarding and other multi-step operations for retry-safe partial completion. Show allocation shortfalls before inviting a candidate rather than allowing an administrator to infer readiness from the bank's total count.

### 6. Capacity and deployment verification

Run staging load tests with realistic audio sizes, concurrent candidates, autosaves, assessor requests, and imports. Measure latency, write conflicts, function payload ceilings, storage cost, and recovery after forced failures. Local HTTP benchmarks do not establish Netlify capacity. Verify deployment smoke tests and monitor a complete synthetic candidate-to-report workflow after releases.

## Validation

Baseline before changes: 741 tests, 738 passed, 3 skipped, zero failures. Final suite: **750 tests, 747 passed, 3 skipped, zero failures**, in approximately 104 seconds. New regression coverage exercises ordered saves, superseded failures, explicit retry, stalled response bodies, failed session deletion, invalid expiry, logout failure, self-service password change across all roles, and invalid persisted scores. Skipped tests retain their existing environment constraints. An earlier run hit the existing local concurrency timing assertion at 81.99 ms against an 80 ms limit, with all 50 requests succeeding; the final full run passed without relaxing the threshold. The published-bank audit also passed.

No production candidates, accounts, assessments, or recordings were deleted or changed during this review. Passing checks establish the covered behavior; the storage and operational risks above remain work before a production-readiness claim.
