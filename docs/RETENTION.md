# Answer-sheet retention, post-report assessor review, manual recording delete

**Status: implemented** (`tests/retention.test.mjs`, plus the assessor/admin POV suites and the
black-box suites). This file is the design of record; where the code went a different way it
records what actually shipped, and why.

## What was asked

1. The answer sheet, recordings and transcripts must stay available to the **assessor** even
   after the exam is done and the report is generated.
2. An **admin setting** to adjust the automatic deletion of answer sheets and recordings,
   **default 30 days**.
3. An option in the **assessor portal** to delete a recording manually.

## What the code does today (verified — see `docs/DATA-MAP.md`)

- The API already serves the answers after finalisation: `GET /assessor/assessments/:id`
  refuses only `assigned`/`in_progress` and returns `questions`, `responses` (transcript + text)
  and `report` for `scored`/`validated` papers. The per-question clip endpoint works too.
- **The gap is the UI**: `public/js/views/assessor.js` → `assessmentView()` short-circuits a
  finalized paper into `renderReport(...)`, so the answer sheet is unreachable once scored.
- Nothing is deleted today except by an explicit admin delete (pre-submission) or a candidate
  delete (refused once a report exists). There is no retention policy and no settings table.
- Clip removal precedent: `dropRecordings()` in `src/api/handlers/candidate.mjs`; paper/row
  deletion precedents: the admin cascades; locks: `withLock('assessment:<id>')`.

## Design

### 1. Availability (fix the report-only screen)

The report stays the **landing screen** for a finalized paper (`#/assessments/:id`), exactly as
it was — the pinned POV test "a finalized paper opens as its report" still holds — with one
added action: **Answer sheet & recordings** → `#/assessments/:id/answers`.

`answersView` is a **read-only review of the same screen** the assessor scored on:

- score inputs render disabled with the recorded scores, "needs your score" chips become a
  scored chip, the Finalize button is not rendered;
- with the next retention sweep, the API marks what was removed, so the screen says
  "answer sheet deleted by the retention policy on <date>" instead of pretending the candidate
  left it blank, and a deleted clip shows a note instead of a failing player + retry;
- the retention window is stated on the page ("records are deleted automatically on <date>").

`GET /assessor/assessments/:id` gains `retention` (state / due date / days left / purge record
/ the settings in force) and, per answer, `answer_deleted` (+ `_at`, `deleted_by`,
`deleted_reason`) and `recording_deleted` (+ `_at`) flags, read from the answer marker.
`has_recording` keeps its current meaning. (The plan said `*_purged`; the implemented names are
the ones above — the marker key is `retention`.)

### 2. Retention setting (admin)

New `settings` table (key/value rows; key `retention`), new `src/core/retention.mjs` (pure
policy) and `src/api/retention-service.mjs` (I/O):

```jsonc
{ "key": "retention",
  "days": 30,                        // 0–3650; 0 = delete at the next cleanup
  "scope": "all" | "open",           // 'open' keeps objective answers
  "auto_delete_answer_sheets": true,
  "auto_delete_recordings": true,
  "updated_at": "…", "updated_by": "<user id>" }
```

Defaults (no row, or unreadable row): **30 days, scope `all`, both toggles on** — i.e. something
is deleted only after 30 days, exactly as asked. `/admin/settings/retention` (GET) returns the
effective settings, the untouched `defaults`, the counts (`finalized_papers`, `due_now`,
`purged_papers`, `next_due_at`) and never 500s on an unprovisioned backend; PUT validates and
upserts (admin only, audited `retention_settings_updated`).

The GET on this screen deliberately does **not** fire the opportunistic sweep (the dashboard,
the assessments list and the assessor workspace do): it is the screen an admin opens to decide
the policy, and it must report what is due rather than act on it — never clearing a paper under
the policy the admin is halfway through changing. The button below runs it explicitly.

Admin UI: new **Settings** page (`#/settings`, new nav entry under *Governance*) with the
period, the two toggles, the scope selector, a plain-words summary of what the policy currently
means ("keeping evidence for 30 days, then deleting answer sheets + recordings"), a live
"N finalized papers · M due now · next cleanup <date>" line and a **Run cleanup now** button
(`POST /admin/retention/run`, behind a confirm that names the window). The admin Assessments
list shows a per-row **Evidence** column (days left / due for cleanup / deleted / kept) and the
admin report card carries the same retention note as the assessor's.

### 3. The cleanup itself

- The clock starts when the report is generated (`scored_at`); `due_at = scored_at + days`.
- Runs on demand (admin button) and opportunistically on the admin dashboard / assessments list
  / settings and the assessor workspace (fire-and-forget, never awaited, never breaking a
  request) — there is no scheduler in this deployment, matching the audit-log trim precedent.
  It is idempotent, re-checks under the assessment lock, and caps at 25 papers per run so it can
  never become a long request.
- Per due paper, under `withLock('assessment:<id>')`:
  1. `recordings` rows for the paper are removed (when `auto_delete_recordings`);
  2. every response row is re-written in **one batch**: `answer` is cleared per scope
     (`all` → every question; `open` → only `type === 'text'`), with the scores
     (`auto_score` / `assessor_score` / `final_score`) kept, and a marker
     `answer.retention = { at, by, reason:'retention', sheet, recording }` left in the row;
  3. `assessments.retention_json` records `{ purged_at, by, reason, scope, sheet_rows, clips }`
     so the admin list/report can say what happened without reading responses;
  4. `audit_log` gets `assessment_data_purged`.
- Report cards are **never** touched: `report_json` keeps every prompt, mark and comment, so an
  assessment stays auditable after the raw material is gone.
- Papers awaiting scoring are never swept.

Two interactions worth stating, because both are easy to get wrong:

- **A clip the policy keeps must stay playable.** When `auto_delete_answer_sheets` is on but
  `auto_delete_recordings` is off, the purge strips the notes and the transcript but **keeps the
  `audio_ref` / `audio_b64` reference** on the row — it is the only thing pointing at the
  recording object, so dropping it would make the retained clip unreachable. `purgeAnswer` now
  carries the reference through that branch (and the recording-only manual delete still strips
  it, since the clip itself is going).
- **A purged answer is never re-scored live.** The live auto-score is computed from the stored
  answer; with the answer gone that would read as 0. Purged rows keep the `auto_score` that was
  written at submit time instead (`answerRetention(r.answer)` is the guard).

### 4. Manual recording delete (assessor)

`DELETE /assessor/assessments/:id/recordings/:question_id` — own paper only, submission onwards,
under the assessment lock:

- removes the `recordings` row and clears `audio_ref` / legacy inline `audio_b64`;
- leaves text + transcript alone, and marks `answer.retention = { at, by, reason: 'manual',
  recording: true }` (an earlier `sheet` note is kept);
- audits `assessment_recording_deleted`; idempotent (a repeat reports `already_deleted` and is
  not audited again);
- 404 for someone else's paper or an unknown question, 409 before submission, 403 for other
  roles;
- UI: a "Delete recording" button beside each player on the answer-sheet screen (while scoring
  and while reviewing), behind a confirm that says the recording is the only copy, repainting
  the slot afterwards — the notes and transcript stay on screen.

### 5. Storage / compatibility

- `src/storage/schema.mjs`: `settings` table (`flags: ['auto_delete_answer_sheets',
  'auto_delete_recordings']` so Airtable round-trips an unchecked box as `false`) and
  `assessments.json += 'retention_json'`.
- `scripts/airtable-setup.mjs`: provision the `settings` table + `assessments.retention_json`,
  and extend its "add these columns to an older base" note (the parity test pins them).
- No change to `recordings` / `responses` layouts, so no migration and no new files on disk;
  `/meta/bootstrap` is untouched.

### 6. Verification (as shipped)

- `tests/retention.test.mjs` — 14 tests: policy pure functions (defaults, clamping, due maths,
  scope, `purgeAnswer` branches incl. the sheet-off/keep-clip case), availability regression
  (answers + transcripts + `has_recording` after finalize; clip readable), settings GET/PUT
  validation, RBAC and provenance, manual delete (own/other/unsubmitted/missing-clip/
  idempotent/audit), sweep semantics (0-day idempotence, scope `open` vs `all`, either toggle
  off, both off, report + scores untouched, batches, opportunistic sweep from a listing), the
  admin delete cascade on an already-cleaned paper, and the whole sweep on the Netlify Blobs
  adapter.
- `tests/pov-ui-assessor.test.mjs` — the finalized paper still opens as its report; the answer
  sheet renders the notes, transcript and clip players read-only with a disabled score; the
  manual delete flow (confirm → DELETE → slot repainted, audit written); a purged paper explains
  itself and offers no player.
- `tests/pov-ui-admin.test.mjs` — the Settings page shows the 30-day default, saves a changed
  policy to the store (audited), repaints "what the policy means", reports a rejected value
  without writing; "Run cleanup now" clears only the due paper and repaints the counts.
- Full `npm test` (713 tests, 711 pass, 2 pre-existing skips for a missing source workbook) and
  the black-box `tests/smoke.py` / `tests/features.py` against a live seeded server.
- Docs: this file, README, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DATA-MAP.md` (§7).
