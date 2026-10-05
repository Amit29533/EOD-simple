# RSA versus SAMA recording comparison

Inspection date: 2026-10-05. This report separates source-code findings, screenshot observations and direct inspection of the historical production files. The user signed in with an authorized assessor account after the initial access limitation, enabling inspection of both answer sheets and all their attached recordings.

## The specific assessments

| Item | RSA | SAMA |
| --- | --- | --- |
| Assessment | `rec_2d3c7c362397b340d8` | `rec_7e9c29bb81afd1f66a` |
| Latest example | Question 2, warehouse-to-lakehouse migration | Question 2, starting a CSF assessment |
| Question type | `text`, recorded answer required | `text`, recorded answer required |
| Transcript | Present | Present |
| Native player | `0:00 / 1:07` | `0:02`, no total length |
| What this establishes | Browser exposes a finite total duration for this clip | Total duration is not displayed for this clip |
| What it does not establish | Entire spoken answer was captured | Recording is complete, truncated, or only two seconds long |

The SAMA assessment ID is unchanged from the earlier screenshots. Its updated caption demonstrates updated answer-sheet rendering; it does not date the original capture or prove which recorder version created it.

## Capture, persistence and playback

1. **Microphone requirement:** `src/core/spoken-answer.mjs` treats all `text` questions as spoken answers. There is no role-specific exception for either track.
2. **Candidate capture:** `public/js/views/candidate.js` enters the same open-answer branch for both. `getUserMedia({ audio: true })`, chunk collection, recorder startup, optional `en-IN` recognition and final blob construction do not branch on RSA/SAMA.
3. **Encoding:** `public/js/exam-audio.js` chooses a supported MIME format from the browser, requests 16 kbps, and retains a bitrate request in its first fallback. This is the same for both tracks. Identical application code does not establish identical historical codecs, bytes or browser behavior.
4. **Timing:** The common open-answer clock is 120 seconds. The role-specific test blueprint changes which questions appear, not the audio encoder. Current SAMA allocation has five open answers; RSA has twenty. No greater SAMA-specific audio volume follows from that structure.
5. **Upload validation:** `src/api/handlers/candidate.mjs` validates canonical base64 and a 400,000-character cap. This validates transport representation, not audio decoding, silence, duration or completeness.
6. **Persistence:** `splitAnswer` separates the recording from text/transcript. `saveRecording` hashes the audio object, writes an immutable recording version and attaches its reference to the response. Netlify Blobs uses the same recording row layout and strong reads for both tracks. Stored recordings are not transcoded by these paths.
7. **Retrieval:** The assessor recording endpoint returns the referenced clip; legacy inline audio is also supported. The same ownership and submission checks apply to both. An inaccessible/missing recording yields 404.
8. **Playback:** `public/js/views/assessor.js` creates the same native `<audio controls preload="metadata">` with the saved MIME and base64 data URL. There is no custom role-specific control set, duration calculation or duration-metadata repair. Browser controls determine the visible duration and menu layout.
9. **Caption:** “Recorded answer with transcript” indicates stored recording presence plus transcript. It does not certify full decoding or correspondence between the whole transcript and the whole clip.

## Verification performed in this comparison

Command: `node --test --test-concurrency=4 tests/sama-recording-workflow.test.mjs tests/exam-audio.test.mjs tests/recordings.test.mjs`

Result: **31 passed, zero failed, zero skipped**.

The cross-role workflow tests retain all five SAMA, twenty RSA and twenty AI/BI recordings through draft save, restored reference, answer lock, submission and assessor retrieval. Returned base64 is identical to the input. These fixtures are synthetic transport bytes, not human recordings; these tests cannot certify the two historical production clips.

Other tests cover final recorder stop/error handling, format fallback, cap reporting, legacy storage, MIME normalization, missing-audio projection, assessor fetch retry and playback cleanup.

## Direct production comparison completed

The user switched to an assessor session with access to both assessments. The loaded native audio elements were inspected without changing answers or scores. Their data URLs were read through the browser's supported DOM APIs and decoded to private temporary local files. No credentials were exported. An initial `downloadMedia` attempt timed out; reading the already-loaded media source succeeded. No production recording bytes were rewritten.

Direct results:

| Measurement | RSA example question 2 | SAMA question 2 | SAMA question 25 |
| --- | --- | --- | --- |
| Stored MIME | audio/webm;codecs=opus | audio/webm;codecs=opus | audio/webm;codecs=opus |
| Container codec ID | A_OPUS | A_OPUS | A_OPUS |
| Writing/muxing application | Chrome | WebKit | WebKit |
| File bytes | 134,532 | 182,317 | 191,414 |
| WebM Duration element | Present, 67.680367 seconds | Absent | Absent |
| Native browser duration | 67.680367 seconds | Infinity | Infinity |
| FFmpeg decoded PCM duration | 67.74 seconds | 28.1475 seconds | 29.575 seconds |
| Last container audio-block timestamp | 67.68 seconds | 28.138 seconds | 29.566 seconds |
| Approximate total file rate | 15.89 kbps | 51.82 kbps | 51.78 kbps |

All **17 RSA** open answers in this historical paper have attached audio. Every file has Chrome as its writing/muxing application and includes a Duration element. All 17 decode with exit code zero and no FFmpeg error messages. This older RSA paper has 17 open answers; it is not an example of the current 20-open-answer allocation blueprint.

Only **2 of 5 SAMA** open answers have attached recordings. Questions **8, 13 and 20** have retained transcripts but no recording slot/reference exposed by the answer sheet, with the explicit missing-recording warning rather than a load/decoder failure. The two available clips have WebKit as their writer, no Duration element, and native duration Infinity. Both decode successfully with exit code zero, but each emits one initial non-monotonic timestamp diagnostic (`-16 >= -16`); this is not evidence of a dropped tail. The EBML inspection found no declared element extending past the available bytes.

This establishes the reason the two players look different: **the saved files have different duration metadata**. The assessor's current Chrome-based player is viewing clips originally produced by different recording implementations. The WebKit tag does not identify the exact device, operating system, browser version or capture build.

The byte-rate difference also provides a specific, plausible explanation for recording loss on the SAMA attempt. Its available clips consume roughly 6.48 KB/second, compared with about 1.99 KB/second in the RSA example. At the observed SAMA rate, the 300 KB decoded-byte ceiling (400,000 base64 characters) is reached at approximately **46 seconds**. At the observed RSA rate it allows approximately **151 seconds**. Thus a longer SAMA answer could exceed the cap even though both exams use the same recording code and 120-second answer window. The older implementation could retain the transcript while dropping oversized audio. This is a supported hypothesis for the missing three, not proof: their original files and candidate-side upload/encoder telemetry are unavailable. They might also have been affected by the previously fixed stop/start bugs.

The two existing SAMA files contain about 28 and 30 seconds of decodable audio; the elapsed-time-only display is not a two-second file. Successful decoding does not prove every word the candidate originally spoke was captured. No comparison with the original microphone signal is available.

## Follow-up implications

- Display a reliable decoded duration for recordings with missing metadata, without modifying the original evidence or inventing a length from the transcript.
- Add a real WebKit recorder/device test: the Chromium test and transport fixtures alone do not verify WebKit's adherence to a requested bitrate.
- Validate actual output size/rate in the microphone readiness test; a 16 kbps request is not proof that a browser honored it. A browser exceeding the storage budget needs a supported alternate encoding path or revised storage budget, rather than merely asking candidates to shorten their required answer.
- The three absent historical recordings cannot be regenerated from transcripts. Storage orphan/back-up checks would require authorized Netlify storage access, which this browser inspection did not provide.

No production scores, assignments or recordings were changed during comparison. The new findings supersede the earlier screenshot-only uncertainty about the missing total duration; uncertainty remains about the exact loss event for the three absent clips.
