# SAMA recording investigation — 2026-10-05

## Reproduced faults

SAMA and RSA use the same browser recorder. The published SAMA default paper
contains 25 objective and 5 open questions, and all five open questions are
served with `audio_required: true`. The allocation and question types did not
explain the intermittent missing audio.

Two shared client faults were reproduced with regression tests before fixing:

1. Optional speech recognition started before microphone recording, outside
   the recording error handler. A thrown speech-recognition startup error
   prevented MediaRecorder from starting at all.
2. Stopping resolved after 800 ms even if MediaRecorder had not emitted its
   final data. A simulated 1,200 ms final chunk was discarded, leaving no audio
   to lock or upload.

These are confirmed code defects affecting SAMA and other tracks. Without the
affected browser's logs or exact warning, they cannot be tied conclusively to
an individual historical production attempt.

## Changes

- Start actual microphone capture before optional transcription. Transcription
  errors no longer interrupt audio recording.
- Await the recorder's stop event and final chunk. Recorder errors or a 10-second
  timeout show a retryable failure instead of silently discarding the clip.
- Serialize stop/lock operations and ignore duplicate locks while saving.
- On browsers supporting capture, require actual recorded audio to unlock an
  open answer; a transcript alone no longer claims a saved recording.
- Preserve previously saved audio if starting a replacement recording fails.
- Release microphone streams if permission arrives after leaving the exam, and
  stop recording/transcription on view cleanup.

Existing server deadlines, storage limits, historical answer compatibility and
allocation quotas are unchanged. Existing recordings remain readable. Audio
that never reached storage cannot be recovered by this fix.

## Validation

- Regression tests cover transcription startup failure, delayed final chunks,
  locking during recording, duplicate locks, transcript-only drafts, failed
  replacement recording, late microphone permission, recorder errors and timeout.
- A real API workflow creates a published SAMA assessment and exercises all 30
  questions. Each of its five audio-only open answers survives draft saving,
  reload, locking, submission and assessor retrieval with identical stored bytes;
  assessor scoring and finalization also succeed.
- Existing suites cover RSA/AI/BI allocation, exam deadlines, autosave/retry,
  assessor playback and Netlify Blobs storage behavior.
- The question-bank audit passes all 863 published records without duplicate
  prompts or structural errors.
- Final complete run with four test processes: 785 tests, 783 passed, two
  skipped for the unavailable source SAMA workbook, zero failures. The default
  parallel run hit one timing-only concurrency benchmark miss (89.95 ms against
  80 ms); that benchmark passed separately and in the final complete run.
- Disposable HTTP smoke checks, 237 feature checks and 76 gauntlet checks pass.

Tests use simulated browser media and disposable local storage. Actual microphone
hardware and an affected live Netlify attempt have not been tested.
