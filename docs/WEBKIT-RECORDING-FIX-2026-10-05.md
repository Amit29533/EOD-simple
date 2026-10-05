# WebKit recording size and playback-duration fix

The direct RSA/SAMA comparison established that both available SAMA recordings were written by WebKit, lacked a WebM Duration element, and used approximately 52 kbps including container overhead. The RSA recordings were written by Chrome, included duration metadata and used approximately 16 kbps. See [comparison](RSA-SAMA-RECORDING-COMPARISON.md).

## Changes

- Client and server now accept up to **1,600,000 base64 characters per clip** (approximately 1.2 MB of binary audio). At the measured WebKit rate, a 120-second answer encodes to about 1,036,000 characters and fits. The recorder still requests 16 kbps; the larger budget accommodates browsers that ignore it. Invalid base64 and oversize requests still fail explicitly. The existing 2 MB ordinary JSON request ceiling remains unchanged, and each clip is stored/retrieved separately.
- The assessor playback path detects an unindexed WebM file missing duration, decodes its actual audio duration locally, and adds a Duration field to an **in-memory playback copy**. Encoded audio blocks remain unchanged; no server recording, transcript, score or original file is rewritten. The field uses the file's TimestampScale as required by the [Matroska element specification](https://www.matroska.org/technical/elements.html).
- Files already carrying duration, including the historical RSA example, are left unchanged. Indexed containers are left unchanged to avoid invalidating seek offsets. Unsupported, malformed, or undecodable files fall back to original native playback. Decoding has a five-second wait limit and preserves the existing view-unmount safeguards.
- Airtable continuation capacity and its provisioning schema also accommodate the larger recording budget. Netlify Blobs needs no schema migration. Existing Airtable deployments, if used, need the additional provisioned audio continuation columns; the user's Netlify backend does not.

The raised clip limit remains below the application's 2 MB request ceiling, which itself is below Netlify's documented [buffered function payload limit](https://docs.netlify.com/build/functions/configuration/). This is a finite budget, not a guarantee that every browser honors the requested encoder profile.

## Verification

- **807 tests: 805 passed, two skipped, zero failed.**
- After the final adapter/schema changes, the affected recording and Airtable suites were rerun: **25 passed, zero failed**.
- All disposable-store HTTP suites passed: smoke, **237/237 feature checks**, **76/76 gauntlet checks**.
- The larger clip regression exceeds the old 400,000-character limit, survives draft save, lock, submission normalization and assessor retrieval with identical bytes, and fits the Netlify handler's request-body cap. Both JSON and Netlify Blobs adapter tests preserve a 780 KB binary fixture outside the main database.
- Private copies of the actual two historical SAMA recordings and the RSA question-2 recording were tested in an isolated Chromium profile. The original SAMA native duration was unknown. With the playback helper, the native player reports **28.1475** and **29.575 seconds**. Both decode to exactly the same audio samples before and after repair. The RSA source is unchanged and retains its native **67.680367-second** duration.
- No candidate audio files, transcripts or credentials are included in this commit. The optional `RECORDING_PLAYBACK_DIR` mode of `scripts/test-browser-recording.mjs` can repeat the private-fixture comparison locally without exporting audio bytes in its output.

## Limits

The three missing historical SAMA clips cannot be recreated from transcripts. The larger budget protects future recordings at the observed rate; it cannot establish what happened to audio absent from the old answer rows. This change was verified against actual WebKit-produced files and measured-rate upload fixtures, not a new two-minute session on a physical Safari microphone. The saved files remain the original assessment evidence.
