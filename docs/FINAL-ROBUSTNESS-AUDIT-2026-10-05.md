# Robustness audit — 5 October 2026

## Scope and evidence

Reviewed the candidate recording lifecycle, autosave acknowledgements, answer
locking and retry, exam deadlines, recording references and storage commits;
assessor ownership checks, playback, scoring and cleanup; admin allocation,
imports, account operations, permanent deletion and retention; authentication,
session revocation, request validation and Netlify transport/storage behavior.
The automated suites exercise these paths from candidate, assessor and admin
perspectives, including unauthorized cross-account access and storage failures.

This is a risk-focused code and workflow review, not a claim that every line or
every possible bug has been exhaustively verified. Generated bank content is
checked separately by the structure/duplicate audit.

## Problems fixed

| Problem | Change | Evidence |
| --- | --- | --- |
| Re-recording could retain the previous take's transcript | Clear the transcript only after replacement capture successfully starts | Regression failed before the fix and passed afterward |
| A transcript-only answer could conceal missing audio from the assessor | Project missing audio independently of transcript presence; show truthful answer labels | API regression verifies transcript remains available while missing recording is flagged |
| Audio could continue after leaving the assessor screen | Keep player cleanup active after the fetch queue finishes; pause and detach sources on unmount, report finalization and deletion | Unmount regression failed before the fix and passed afterward |
| Decoder/playback errors left a silent broken player | Show a playback error and a per-recording retry | Error-event regression failed before the fix and passed afterward |
| MIME fallback unnecessarily discarded the low-bitrate profile | Retry with speech bitrate and browser-selected MIME before plain fallback | Constructor regression verifies bitrate is retained |

The prior fix for speech-recognition startup failure and delayed final recorder
chunks remains covered. No historical responses or recordings are rewritten.

## Automated results

- Baseline: 785 tests, 783 passed, two skipped, zero failures.
- Final: 792 tests, 790 passed, two skipped, zero failures, using four test processes.
- The two skips require the unavailable source SAMA workbook.
- HTTP smoke suite passed; feature suite 237/237 and gauntlet 76/76 passed.
- Syntax checks passed for 86 runtime/script files.
- Published question-bank audit passed all 863 records without duplicate prompts
  or structural errors.
- Complete published-role API workflows create 30-question SAMA and 50-question
  RSA/AI/BI papers. All 45 open-answer recordings (5 + 20 + 20) survive draft
  saving, reload, lock, submission and assessor retrieval with identical bytes.
  Scoring/finalization succeeds for each role.
- Fault tests cover delayed chunks, failed transcription, duplicate locks,
  failed replacement capture, late microphone permission, recording stop errors,
  missing-audio flags, playback errors, retry, retention and access boundaries.
- Isolated Chrome: real MediaRecorder, synthetic microphone plus continuous
  calibration tone, 120-second capture. Audio decodes to 119.82 seconds; native
  duration is 119.759734 seconds. The 250,018-byte file encodes to 333,360 base64
  characters, below the 400,000 limit; no clip was dropped. A short 2-second
  browser check also passes. The reusable command is
  `node scripts/test-browser-recording.mjs`; set `RECORDING_TEST_MS=120000` for
  the complete answer window and `CHROME_PATH` if automatic discovery fails.

The initial direct fake-device capture had a 119.94-second native timeline but
114.6 seconds of decoded samples, failing the first wall-clock comparison. The
calibrated continuous-input check above passes and verifies the encoder/final
chunk path. This discrepancy does not establish the completeness of a physical
microphone recording; actual device/input-clock behavior remains outside these
automated fixtures. No production workaround was added on that assumption.

## Limits

The role workflows use synthetic recording bytes; a separate Chromium check
exercises real MediaRecorder encoding/decoding with a synthetic microphone.
Physical microphones, Safari/Firefox, mobile devices and the live Netlify data
were not inspected. Existing missing recordings cannot be recreated from a
transcript. Network loss, denied microphone access, unsupported capture and
intentional retention/deletion can still leave an answer without stored audio;
the UI must describe that accurately rather than promise recording success.
