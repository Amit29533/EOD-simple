# Adversarial workflow testing — 5 October 2026

## Different approach

The previous audit followed complete role workflows and browser recording.
This pass tests failure boundaries and state invariants instead of only successful
journeys. All tests run against disposable stores; live candidates are untouched.

- Probe the complete private route inventory as signed-out users and as admin,
  assessor, candidate, validator and trainer accounts. All 352 authorization
  probes reject unauthorized access before mutations. Forging privileged fields
  in request bodies does not change authorization. Stored state is unchanged.
- Disable and reactivate a candidate account. Its revoked token stays invalid;
  a fresh login works.
- Commit a recording, response or cursor update, then throw before the caller
  receives acknowledgement. Repeating the lock recovers the exact audio, creates
  one answer and advances exactly once.
- Reopen the JSON store through a fresh application instance. The assessor can
  still retrieve the saved recording. Remove the referenced recording object:
  retrieval fails with 404 rather than returning invented/empty audio, while
  the transcript remains intact.
- Run seeded action sequences (7, 19, 41, 73) containing repeated autosaves,
  triple lock requests, unknown IDs and late replacement drafts. Committed
  answers remain immutable, cursors advance once, and response IDs stay unique.
- Try malformed audio on draft, lock and final-submit paths; verify rejection
  leaves the previous recording and current question intact.

## Defect found and fixed

Client audio validation previously checked the size but not valid base64 shape.
Values such as `====` could be saved as a recording despite decoding to no bytes.
Other malformed uploads could be silently discarded while acknowledging the
answer, replacing a valid earlier recording with transcript-only data.

New client submissions require string, canonical padded base64, with whitespace
normalized and the existing size cap preserved. Bad input returns 422 before
mutations. Stored legacy rows retain lenient submit-time compatibility.

The initial regression failed with 200 for `====`; it now passes for every invalid
input on all three write paths. The retention fixture was also corrected to
encode its bytes once rather than concatenate independently padded fragments.

## Results and limits

The dedicated adversarial suite passes all 10 tests. Targeted retention and
adversarial tests pass 25/25. The HTTP smoke, feature (237/237) and gauntlet
(76/76) suites pass; the published-bank audit passes 863 records.
The final complete suite reports 802 tests: 800 passed, two skipped for the
unavailable source SAMA workbook, zero failures.

This tests data preservation and failure handling, not physical microphone
quality or live Netlify outages. Valid base64 is not proof of a valid audio
codec; assessor playback errors remain visible and retryable. Missing physical
recording objects cannot be recreated from their transcripts. The simulated
lost acknowledgements use the real app and JSON adapter; the full regression
suite separately exercises independent Netlify Blobs adapters and CAS conflicts.
