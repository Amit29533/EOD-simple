# Where an exam's data actually goes

**Question this answers:** a candidate finishes an exam, an assessor finalizes it, a report is
generated — where are the microphone recordings, the transcripts, the MCQ markings and the
report itself kept?

**Short answer.** All of it lives in the same storage backend (local JSON file, Netlify Blobs
or Airtable), but deliberately in **four different shapes**, so that megabytes of audio never
ride along on the exam's per-request reads:

| Artefact | Table | Stored field(s) | Physical shape (file / blobs) |
| --- | --- | --- | --- |
| MCQ / scale marking | `responses` | `answer`, `auto_score`, `assessor_score`, `final_score` | one object per **assessment** (`shards/responses/<assessment_id>`) |
| Open-answer text + speech transcript | `responses` | `answer.text`, `answer.transcript` | same shard object as above |
| Recorded clip (mic answer) | `recordings` | `audio: { b64, mime }`, referenced by `answer.audio_ref` | one object per **(assessment, question)** (`rows/recordings/<assessment_id>/<question_id>`) |
| Report card | `assessments` | `report_json` + summary columns | one object per row+column (`columns/assessments/<id>/report_json`) |
| Exam trail / integrity | `assessments` | `quiz_state` (cursor, counters, last 200 events) | on the assessment row |
| Who did what, when | `audit_log` | one row per action | table object (trimmed at 2 000 rows) |

The frozen question paper itself (`snapshot_json`) is a fifth detached column on the same
assessment row. Registry: `src/storage/schema.mjs`; layouts: `src/storage/row-tables.mjs`.

---

## 1. The lifecycle, and what each step writes

Nothing waits for the report: **every answer is persisted the moment it is locked**, which is
why finalizing a 110-question paper is one batch write instead of 110.

### 1.1 Allocation — the paper is frozen
`buildSnapshot()` (`src/api/assessment-service.mjs`) copies role + competencies + framework +
the served question set into `assessments.snapshot_json`. From then on the sitting is auditable
against exactly the questions the candidate saw (including their positions).

### 1.2 Draft autosave — `PUT /candidate/assessments/:id/answers`
(`src/api/handlers/candidate.mjs`)

- The exam hall sends a draft **only for the question on screen, while its clock runs**
  (choice after 400 ms, typed notes after 1.5 s, a clip as soon as recording stops).
- A draft **with a clip** is split by `splitAnswer()`: the base64 audio goes to the
  `recordings` table, the response row keeps `audio_ref` + `audio_mime` + `{ text, transcript }`.
- `audio_keep: true` means "you already hold this clip" — the editor saves note edits without
  re-uploading a two-minute recording; the server resolves the reference from the store, never
  from the request (so a client cannot plant evidence).
- Clearing an answer (or losing the clip) deletes the `recordings` row (`dropRecordings()`).

### 1.3 Lock — `POST /candidate/assessments/:id/next`
This is the real "answer is in" event, per question:

- the response row becomes `{ answer, locked: true }` (a locked row is never changed again);
- the clip is written to `recordings` and referenced as `answer.audio_ref`;
- an open answer with neither a clip nor a transcript gets `audio_missing: true`, plus an
  integrity event `spoken_answer_missing` and an `audit_log` row `exam_spoken_answer_missing`;
- the cursor and the integrity counters advance inside `assessments.quiz_state`.

### 1.4 Submit — `POST /candidate/assessments/:id/submit`
- `responses` rows that changed are written in **one batch per table**; a question the walk left
  blank gets a blank row marked `source: 'skipped' | 'timed_out'`.
- **Objective marking happens here**: `autoScore()` (`src/core/scoring.mjs`) writes
  `auto_score` on every MCQ / multi-MCQ / scale row. Multi-select is all-or-nothing.
- Assessment → `status: 'submitted'`, `submitted_at`; audit row `assessment_submitted`.
- The posted answer sheet is validated but **never graded** — only what was locked inside each
  question's window counts.

### 1.5 Assessor scoring — `PUT /assessor/assessments/:id/scores`
- Each open answer gets `assessor_score` (0…points, rounded to 2 dp) and `assessor_comment`
  (≤ 1 500 chars) on its `responses` row.
- The scoring screen reads the transcript from the same payload and fetches each clip on demand
  from `GET /assessor/assessments/:id/recordings/:question_id` (the detail payload carries only
  `has_recording: true` — a whole-bank paper inlined would be ~10 MB, past a serverless cap).

### 1.6 Finalize — `POST /assessor/assessments/:id/finalize`
`finalizeScoring()` (`src/api/assessment-service.mjs`):

1. refuses if any open question is unscored;
2. writes `final_score` on **every** response row (auto score for objective, assessor score for
   open) in one `bulkUpdate` per table;
3. builds the report with `computeReport()` and writes it to **`assessments.report_json`**,
   plus the listing facts on the row: `overall_pct`, `readiness_key`, `readiness_label`,
   `scored_at`, `status: 'scored'`;
4. advances the candidate's stage to *Gap Mapping*;
5. audit row `assessment_scored`.

---

## 2. MCQ markings in detail

Everything lives on the response row — one row per (assessment, question), keyed
`<assessment_id>/<question_id>`:

```jsonc
{
  "assessment_id": "rec_…", "question_id": "rec_…",
  "answer": "a",                 // 'a' | ["a","c"] | 3 (scale) | { text, transcript, … }
  "locked": true,                // set by /next; never written again
  "auto_score": 4,               // at submit (objective only)
  "assessor_score": 4,           // open questions, from the assessor's sheet
  "assessor_comment": "…",
  "final_score": 4               // at finalize; this is what the report sums
}
```

`final_score` is authoritative for the report; `auto_score`/`assessor_score` are retained so an
assessor or admin can see how the mark was arrived at. Score comments are shown to the assessor,
to the admin report (`GET /admin/reports/:id`) and inside the report's per-question `breakdown`
— but **not** to the candidate (`reportForCandidate()` strips them, `src/api/projections.mjs`).

---

## 3. Recordings and transcripts in detail

Two different things, stored in two different places, for a reason:

```jsonc
// recordings table — one row per (assessment, open question)
{
  "assessment_id": "rec_…",
  "question_id":   "rec_…",
  "audio": { "b64": "…up to 400 000 chars (~300 KB, ~2 min at 16 kbps mono)…",
             "mime": "audio/webm" },
  "id": "rec_…/rec_…",           // = <assessment_id>/<question_id>
  "created_at": "…"
}
```

```jsonc
// responses row for the same question — the transcript stays with the answer
{
  "answer": {
    "text": "optional typed notes",
    "transcript": "live speech-to-text of the spoken answer",   // cap 60 000 chars
    "source": "audio" | "typed",
    "audio_ref": "rec_…/rec_…",   // pointer into recordings; the wire form `audio_b64` is dropped
    "audio_mime": "audio/webm",
    "audio_missing": true          // only when a required spoken answer had no clip/transcript
  },
  "locked": true
}
```

- **Transcription is browser-side.** Live speech-to-text comes from `SpeechRecognition` /
  `webkitSpeechRecognition` (`public/js/exam-audio.js`, wired up in
  `public/js/views/candidate.js`); the text is merged into the answer by `buildTextAnswer()`.
  There is **no server-side STT service and no external transcription API** in this repo.
  Where the browser cannot transcribe but can record, the clip alone counts as spoken evidence —
  and vice versa. A typed-only lock is stored but flagged (see §1.3).
- **The clip is never stored on the response row.** That is the whole point of the `recordings`
  table: a whole-bank paper holds ~33 spoken answers (~10 MB per finished candidate); kept
  inline, every exam request re-read the responses table and every unrelated write on the file
  store re-serialised it (an admin login went 5 ms → 210 ms after one candidate), and the
  assessor's detail payload blew past a serverless function's 6 MB response cap.
- **Storage caps** (`src/core/constants.mjs`): clip ≤ 400 000 base64 chars, notes ≤ 20 000,
  transcript ≤ 60 000. The exam records at 16 kbps mono so a full two-minute answer survives.
- Legacy papers that still carry the clip inline (`answer.audio_b64`) are still served by the
  recordings endpoint and are migrated into `recordings` on the next write of that row.

---

## 4. The report: what it contains — and what it does not

`computeReport()` (`src/core/scoring.mjs`) produces `report_json`:

```
role, framework_name, overall_pct, band,
competencies[ { competency_id, name, weight, target_level, observed_level, gap,
                status, score_pct, earned, max, recommended_focus,
                breakdown[ { question_id, prompt, type, difficulty, points,
                             score, scored_by, assessor_comment } ] } ],
areas_to_improve[], strengths[], not_assessed[], generated_at
```

So a finalized report contains **marks, prompts, per-question scores and assessor comments** —
but **no audio and no transcript text**. The verbatim answer material stays in `responses`
(transcript + text) and `recordings` (clip), and both survive finalization unchanged; the report
points at it through `question_id`. Nothing is deleted or archived when the report is generated.

Who sees what:

| Audience | Route | Gets |
| --- | --- | --- |
| Candidate | `GET /candidate/reports/:id` | report stripped of per-question detail, assessor comments and identity |
| Assessor | `GET /assessor/assessments/:id` (+ `…/recordings/:question_id`) | full questions, rubrics, answers, transcript, clips one at a time, and the report once finalized |
| Admin | `GET /admin/reports/:id` | the full `report_json` including the per-question breakdown |

---

## 5. On-disk / on-server layout (verified by walking a real exam)

The shape is identical across adapters — only the medium changes. Keys come from
`src/storage/row-tables.mjs`.

### Local JSON store (`STORAGE=json`, the default; **`data/` is git-ignored**)

```
data/ecod.json                                  ← every table object: users, sessions, candidates,
                                                  roles, competencies, questions, frameworks,
                                                  assessments (heavy columns replaced by
                                                  {"$detached":true} markers), audit_log …
data/ecod.rows/
  rows/recordings/<assessment_id>/<question_id>.json   ← the clip, written once
  shards/responses/<assessment_id>.json                ← every answer + mark of one paper
  columns/assessments/<id>/snapshot_json.json          ← the frozen paper
  columns/assessments/<id>/report_json.json            ← the report card
```

A real run of one 4-question sitting (2 MCQ + 2 open, one spoken, one typed-only):

```
db.json                                     (12 869 B)  ← all tables incl. the assessment row
db.rows/
  columns/assessments/rec_87a6…/report_json.json     (1 958 B)
  columns/assessments/rec_87a6…/snapshot_json.json   (3 349 B)
  rows/recordings/rec_87a6…/rec_ab92….json           (2 013 B) ← the one recording
  shards/responses/rec_87a6….json                    (1 681 B) ← all four answers + marks
```

and the assessment row itself, after finalize:

```jsonc
{ "id": "rec_87a6…", "status": "scored", "submitted_at": "…", "scored_at": "…",
  "overall_pct": 82.2, "readiness_key": "enterprise_ready",
  "readiness_label": "Enterprise Ready",
  "question_count": 4, "total_points": 18, "bank_total": 4, "role_name": "POV Track",
  "snapshot_json": { "$detached": true }, "report_json": { "$detached": true },
  "quiz_state": { "index": 4, "integrity": { …, "spoken_answer_missing": 1 },
                  "events": [ { "event": "spoken_answer_missing", … } ] } }
```

### Netlify Blobs (`STORAGE=blobs`)

Same key strings at the store root: `rows/recordings/<assessment_id>/<question_id>`,
`shards/responses/<assessment_id>`, `columns/assessments/<id>/{snapshot_json,report_json}`,
plus one blob per table.
Writes are compare-and-swap on the blob ETag (many function instances share one store; a lost
write becomes a retryable `STORE_CONFLICT` → 503 rather than a silent overwrite).

### Airtable (`STORAGE=airtable`)

One record per row in the same-named tables (`assessments`, `responses`, `recordings`). Every
text cell caps at 100 000 chars, so the JSON columns are split across continuation cells
(`scripts/airtable-setup.mjs` provisions them): `snapshot_json` over 4, `report_json` over 2,
`quiz_state` over 2, `answer` over 5, `audio` over 5 (a full clip ≈ 400 k chars = 5 cells).

---

## 6. Where the trail of the sitting itself goes

- **Integrity trail** — `assessments.quiz_state`: a counter per event type (`tab_switch`,
  `copy_attempt`, `devtools_key`, `spoken_answer_missing`, `time_expired`, …) plus the last
  **200** full events (`events_dropped` keeps the running total). Read by
  `GET /admin/assessments/:id/integrity`. Counters live on the assessment; the audit log gets
  a *copy* of events up to the 200th, then stops (the exam's own trail stays complete).
- **Audit log** — `audit_log`: `assessment_submitted`, `assessment_scored`,
  `exam_spoken_answer_missing`, `assessment_reassigned`, `assessment_deleted`,
  `candidate_deleted`, … Read by `GET /admin/audit`; trimmed to 2 000 rows (oldest 500 dropped)
  on write by `src/storage/audit-rotation.mjs`.

---

## 7. Retention & deletion

| Event | Effect on recordings / transcripts / marks |
| --- | --- |
| Answer re-recorded or cleared | that one `recordings` row replaced / deleted; transcript in the response row updated |
| Exam submitted | nothing deleted; rows freeze (`locked`) |
| Report finalized | **nothing deleted at that moment** — clips, transcripts and marks are kept alongside the report, and the assessor can still read them (Admin → Settings can put a clock on it, below) |
| **Retention cleanup** (admin setting, default **30 days** after `scored_at`) | removes the `recordings` rows and clears the answer content per scope (`all` answers, or open answers only), keeping **every** score and the whole `report_json`; leaves an `answer.retention` marker on each row and `assessments.retention_json` on the paper, and writes `assessment_data_purged` to the audit log |
| Assessor deleting one recording (`DELETE /assessor/assessments/:id/recordings/:question_id`) | removes that clip and clears its reference; notes, transcript, marks and the report stay; audited as `assessment_recording_deleted` |
| `DELETE /admin/assessments/:id` | allowed only before submission; removes that paper's `responses`, `recordings` and the assessment (also fine after a cleanup, when the recordings are already gone) |
| `DELETE /admin/candidates/:id` | refused if the candidate has a finalized report (reports protect the record); otherwise removes portal login, sessions, and every open paper's `responses` + `recordings` + assessment |
| Audit log | trimmed to the newest 2 000 rows |
| Integrity events | newest 200 kept, counters keep lifetime totals |

So there is still no separate "archive" step, but there is now a **policy-driven cleanup**: after
the report has existed for the configured period, the raw material (answers, transcripts,
recordings) is deleted from the stores, while the report card and every marking — the things a
later audit actually reads — stay queryable for as long as the assessment row exists. Nothing is
swept before a report exists, and the policy (days, scope, which artefact) lives in the
`settings` table under key `retention`; the full design and its verification are in
`docs/RETENTION.md`.

---

## 8. Quick reference — code pointers

| Concern | File |
| --- | --- |
| Table registry, overflow columns, adapter contract | `src/storage/schema.mjs` |
| Row / shard / detached-column layouts and key strings | `src/storage/row-tables.mjs` |
| Exam hall API: autosave, lock, integrity beacons, submit, report | `src/api/handlers/candidate.mjs` |
| Splitting an answer from its clip, saving/dropping recordings | `candidate.mjs` → `splitAnswer` (L146), `saveRecording` (L184), `dropRecordings` (L196) |
| Assessor detail, per-question clip fetch, scores, finalize | `src/api/handlers/assessor.mjs` |
| Report computation, finalize, allocation, snapshots | `src/api/assessment-service.mjs`, `src/core/scoring.mjs` |
| Candidate/assessor/admin projections (compartmentalization) | `src/api/projections.mjs` |
| Mic + speech-to-text client helpers | `public/js/exam-audio.js` |
| Retention policy (pure: defaults, due maths, purgeAnswer) | `src/core/retention.mjs` |
| Retention I/O: settings row, sweep, manual clip delete | `src/api/retention-service.mjs` |
| Retention of the trail | `src/storage/audit-rotation.mjs`, `src/api/quiz-session.mjs` (`MAX_INTEGRITY_EVENTS`) |
