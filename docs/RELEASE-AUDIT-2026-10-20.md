# Netlify test-release audit — 20 October 2026

The test deployment is https://deploy-preview-49--anthroprimeeod.netlify.app/ on the existing `anthroprimeeod` Netlify project. Source changes are in PR https://github.com/Amit29533/EOD-simple/pull/49, branch `codex/release-audit-20261020`. Its runtime is explicitly bound to the isolated `ecod-preview-49` Blobs store. Production remains on its existing deployment and store.

This is a follow-up to the local-only audit documented in `WHOLE-APP-AUDIT-2026-10-20.md`; this follow-up includes GitHub pushes and actual Netlify deployment testing.

## Live verification

Three complete candidate journeys ran against the deployed API, including public invitation lookup, form validation, single use and replay recovery, linked profile/login/assessment IDs, early-entry refusal, a scheduled two-hour deadline, assessor assignment, question progression, recording autosave and restoration, logout/login recovery, duplicate requests, submission, scoring and report release.

| Track | Questions answered | Recordings stored and retrieved |
| --- | ---: | ---: |
| SAMA | 30 | 5 |
| RSA | 50 | 20 |
| AI/BI & Genie | 50 | 20 |
| Total | 130 | 45 |

The main live journey made 487 verified API requests. The longest measured response was 4,051 ms from this client; this is an observation, not a load-capacity guarantee. Ten concurrent health requests also succeeded. A further ten simultaneous registrations against one invitation produced exactly one fully provisioned booking and nine 409 rejections. Synthetic recordings were valid one-second WAV files; byte equality was checked after retrieval. The browser decoded all five SAMA clips with duration 1 second and no media error, and native playback ran to its end.

The owner also submitted a physical microphone test. The deployed API retained its WebM/Opus clip. Its transcript was empty, matching the owner's report that captions did not appear. The owner repeated the test in regular Chrome and confirmed live captions appeared. The final Chrome answer was submitted successfully with its WebM/Opus recording (17,606 bytes) and an 81-character transcript, verified through the assessor API. Browser speech remains optional, and its service was unreachable in the in-app browser. The owner chose to retain browser captions rather than add a server transcription provider.

The preview was redeployed during the journeys; sessions, allocated snapshots and recordings persisted.

## Bugs fixed in this release follow-up

- Final speech results could arrive after the answer was locked. Capture now waits for the speech service's end event, with a bounded timeout, alongside final audio-chunk completion; stale callbacks are detached.
- Practice-recorder stop exceptions could skip microphone release. Cleanup now always releases tracks and leaves an actionable retry.
- Netlify build context did not reliably reach the Lambda runtime. A generated, non-secret deployment manifest now binds runtime storage to the deployment's context and review ID. Preview initialization refuses production/shared-store overrides.
- A real simultaneous same-email submission through two different invitations produced one success and one stranded provisioning request. The email reservation is now checked inside the same table-level compare-and-swap that claims the booking. Independent-adapter regression coverage exercises a CAS retry. Three repeated live races each produced one complete booking, a 409 for the other, and a still-usable losing invitation without an orphan profile.
- Mobile navigation remained keyboard-focusable while translated off screen. Closed navigation is now hidden; Escape closes an open menu and returns focus to its toggle. The deployed browser verified the next Tab target is the visible menu toggle, rather than an off-screen logo.
- Question Bank text incorrectly described the role catalogue as the source of all current exams. It now distinguishes RSA/AI/BI module allocation from SAMA/custom-role catalogue allocation.
- Caption-service failures lost their explanation when the audio recording stopped. A separate persistent caption status now explains unsupported browsers, denied speech permission, service/network failures and missing caption output while preserving audio capture.

The earlier booking lifecycle, deletion, storage-integrity, timer, authentication and design fixes are described in the linked local audit and booking verification documents.

## UI and persona checks

The deployed browser verified administrator login and navigation, dashboard bookings, aligned single-line user actions with internal table scrolling, the Question Bank toolbar, import dialog, and light/dark themes. Phone checks used 390 × 844; desktop checks used 1280 × 850. The booking inputs use 16 px text, and the booking form and report had no document-level horizontal overflow. The import dialog fit inside the phone viewport. Candidate reports hid private assessor comments. The assessor queue omitted candidate contact details; the finalized answer sheet showed stored recordings and transcript evidence.

Relevant screenshots and logs are retained in the ignored local folder `.probe/release-audit-20261020/`. They include `live-dashboard.png`, `live-bank-dark.png`, `live-import-mobile.png`, `live-candidate-report-mobile.png` `live-assessor-evidence-mobile.png` and `chrome-live-captions.png`. Local generated account credentials are also ignored; only salted hashes for isolated synthetic preview accounts are committed. Build logs do not print passwords.

## Validation

- Final complete serial regression after the concurrency/caption changes: 862 tests, 860 passed, 2 skipped, 0 failed (454 seconds).
- Recording/microphone focused checks: 32 passed after the initial recording fixes.
- Deployment-storage/function checks: 17 passed.
- Catalogue UI checks: 22 passed.
- Mobile shell/styles checks: 4 passed.
- Email reservation, booking, independent storage-instance and HTTP workflow checks: 34 passed.
- Candidate caption and UI checks: 18 passed.
- All real local HTTP suites passed, including 237 feature and 76 gauntlet checks.
- Published bank audit: 863 records, no duplicate prompts or structural errors.
- npm audit: zero reported vulnerabilities.
- Windows and Ubuntu GitHub checks passed for deployed revision `0c0cbc4`; Netlify deployment, redirects and headers succeeded.
- Final local HTTP suites also passed after the booking/caption changes.

## Acceptance limits

Real live captions passed in regular Chrome, with both recording and transcript retained after submission. The in-app browser reported that its speech service could not be reached. The application uses the browser's optional Web Speech recognition service, so caption availability still depends on browser support, permissions and service connectivity: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition . The owner selected browser captions and a regular-Chrome retest; no server transcription provider was added. Caption text is machine-generated and can misrecognize words.

Two workbook-source checks skip because `SAMA Question bank 1.2.xlsx` is absent; generated SAMA bank and complete SAMA journeys were tested. Exact two-hour expiry is covered using controlled clocks and real local HTTP restart tests, rather than a two-hour live waiting test. Physical Safari/Firefox/mobile microphone coverage, capacity limits, and backup/restore operations are not certified by these results. Trainer and validator portals remain labelled planned features. No test run can establish that every possible bug is absent.
