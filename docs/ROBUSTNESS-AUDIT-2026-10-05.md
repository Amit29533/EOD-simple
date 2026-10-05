# ECOD robustness audit — 5 October 2026

## Outcome

Risk-focused source inspection and a complete automated test run found two reproducible defects in the shared browser API client. Both are fixed, with regression tests. This audit does not establish that every code path or browser/device combination is bug-free.

### Fixes

1. **Stale authentication failures could clear a newer session.** A request sent using an old token could return 401 after another account signed in. The client previously cleared whatever token was present at response time. A failed anonymous login could also erase a session established in another tab. Requests now retain their original token and clear the session only when that same token is still current. Current-session expiry still triggers the existing cleanup and sign-in flow.
2. **Malformed successful responses could acknowledge saves.** A truncated JSON response or an HTML response with HTTP 200 previously resolved to `null`. Save callers could proceed without a valid acknowledgement. Successful responses with invalid JSON now raise a retryable error; intentional HTTP 204 remains supported. This does not imply a failed response means the server did not commit: existing retry protections remain necessary.

Also replaced an unconditional `assert.ok(true)` in the authentication integration test with checks that unknown usernames and wrong passwords return identical failures and create no session.

## Inspection scope

Reviewed shared request/session handling, API routing and role guards, candidate answer validation and recording references, exam clocks and expiry, assessor scoring and recording loading, allocation/snapshot wiring, question intake/quality checks, Netlify request boundaries, storage consistency and row/shard layout, recovery links, retention, and permanent deletion planning. Existing tests exercise candidate, assessor and admin views and workflows, ownership isolation, malformed input, retries, storage failures, concurrency, imports and report generation. This was a risk-focused inspection; it was not a claim of manually reviewing every line of generated question content or every implementation file.

## Validation

- Full suite after API-client fixes: **813 tests, 811 passed, 2 skipped, 0 failed**. The two skipped checks require the absent `SAMA Question bank 1.2.xlsx` source workbook; the published SAMA bank and allocation tests ran.
- The subsequent authentication-test correction passed its complete **20-test** integration file.
- Disposable local HTTP suites: smoke passed; **237/237** feature checks and **76/76** gauntlet checks passed. No production candidate records were created, scored or deleted for these suites.
- Question-bank audit: **863 records** checked across shipped catalogues/module banks; no normalized duplicate prompts or structural errors within the audited banks. These representations overlap; 863 is not a count of globally distinct questions. Structural checks do not certify every technical answer's subject-matter accuracy.
- `npm audit` and `npm audit --omit=dev`: **0 known vulnerabilities** reported for the installed dependency tree at audit time. This is not a comprehensive application security assessment.
- Isolated real Chromium MediaRecorder capture with a synthetic microphone: two seconds passed; **120 seconds passed**, producing 250,018 bytes / 333,360 base64 characters against the 1,600,000-character limit. Decoded duration 119.82 seconds; native duration 119.760843 seconds. This tests the browser capture/encoding path, not physical microphone quality or a live candidate upload.
- Historical saved SAMA files: both playback metadata repairs produced finite native durations (**28.1475 and 29.575 seconds**) and **sample-identical decoded PCM** before/after repair. The historical RSA comparison file remained unchanged, with native duration 67.680367 seconds. Private candidate media remained outside the repository.
- Cross-role API recording workflows, including draft, lock, submit and retrieval, pass in the full suite; large WebKit-sized payload persistence and immutable recording race tests ran.

## Open findings and practical limits

1. **One historical RSA recording still fails native playback.** Read-only production review reproduced the failure for question 7 in assessment `rec_7623de7915e395db2d`, including Retry. The browser's error alone cannot establish whether the cause is codec compatibility, corruption or incomplete capture. Its encoded bytes were not available through the observed asset inventory, so this audit did not decode that clip or repair it. The earlier cross-exam report records the wider live review: 203 healthy RSA players, one failed clip and 44 unanswered open questions across 14 papers. Healthy means finite loaded metadata with no media error, not that every response was manually listened to.
2. **Historical transcript-only SAMA responses are not recoverable from text.** Existing clips are preserved and duration repair does not recreate recordings that were never stored. Transcripts do not prove that complete audio was uploaded.
3. **Fresh Safari/WebKit capture remains unverified.** The audit used actual historical WebKit files for playback and tested payloads matching their observed sizes. It did not make a fresh two-minute recording in Safari on a physical device. The tested Chromium capture must not be described as that test.
4. **No live submitted AI/BI paper was available to the signed-in assessor.** AI/BI allocation and recording persistence pass automated workflow tests; live playback of an actual submitted AI/BI exam remains unverified.
5. **Production load and operations need separate evidence.** Local concurrency/fault tests and Blobs adapter doubles do not establish production latency, capacity or service recovery at an unspecified concurrent candidate count. Login throttles and several workflow locks are per function instance; the Blobs adapter uses conditional writes for supported mutations, but that is not a general transaction across all linked records. Deployment-scale abuse protection, backup restore drills and cross-instance administrative mutation races merit explicit operational testing.

## Follow-up priority

First obtain and decode the one failing historical RSA clip without rewriting stored evidence. Then exercise a fresh two-minute Safari/WebKit submission and a live AI/BI paper end to end. Before increasing candidate volume, establish the expected concurrency and run controlled staging load and recovery tests against Netlify Blobs.
