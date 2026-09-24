# ECOD API (summary)

Base: `/api` · Auth: `Authorization: Bearer <token>` (from `POST /api/auth/login`) · Errors: `{ "error": "…" }`

> **Request shape.** A JSON body must be an object — an array, string or number that parses as valid
> JSON is a 400 (`Request body must be a JSON object.`), never an "empty body". Query parameters reach
> handlers as strings only. A record id or `role_key` that names an `Object.prototype` member
> (`__proto__`, `constructor`, `toString`, …) is simply "no such record" (404 for ids, 400 for keys).

> **Concurrent creates.** Uniqueness rules (role `key`, `username`, one portal user per candidate, one
> question per prompt within a role, one role per published track, one login per imported person) are
> enforced under a per-key lock, so N identical requests in flight together yield exactly one record —
> the first gets its normal 201/200, the rest get the same 409 they would have seen sequentially. As a
> backstop for multi-instance deployments, the storage layer refuses to `insert` over an existing id
> and the API answers 409 `That record was created by another request at the same time. Please refresh
> and try again.` — a client should treat that like any other conflict and re-read.

## Auth & meta
| Method | Path                  | Roles        | Notes                                   |
| ------ | --------------------- | ------------ | --------------------------------------- |
| POST   | /auth/login           | public       | {username,password} → {token,user}; throttled per username + client address (429); `503` + `retry-after: 2` when the sign-in line is full |
| POST   | /auth/logout          | any          | ends session                            |
| GET    | /auth/me              | any          | current user + linked candidate         |
| GET    | /meta/bootstrap       | public       | enum config for the UI (static, no user data) |

## Admin
| Method | Path                          | Notes                                             |
| ------ | ----------------------------- | ------------------------------------------------- |
| GET    | /admin/dashboard              | KPIs, pipeline, statuses, activity                |
| CRUD   | /admin/candidates[/:id]       | intake fields, stage, notes, timeline, and the candidate's **`assessor_id`** (an active assessor user, or blank) — the assessor the auto-allocated paper goes to; a PATCH that changes it also moves the candidate's **open** papers (assigned / in progress / submitted) to the new assessor and reports `reassigned_assessments`, while scored reports keep the assessor who scored them (the same rule as Reassign on the Assessments page); an unchanged `assessor_id` / `target_role_id` is never re-validated, so a since-deactivated assessor or track does not block an unrelated edit; a non-assessor or deactivated user is a 400. Listings carry `assessor_name`. `name` is required on create and cannot be blanked by PATCH; `email` is optional but, when given, must look like `name@example.com` (same rule as the bulk import and the users routes). DELETE requires `{password}` (the signed-in admin's password) and cascades the linked portal user, their sessions and open assessments; blocked (409) once a report is finalized |
| POST   | /admin/candidates/assessor    | `{candidate_ids: [...], assessor_id}` — one assessor for many candidates at once (the import dialog's "apply to all imported" step); same rules and paper moves as the per-candidate PATCH; returns `{updated, reassigned_assessments, missing}` |
| GET    | /admin/candidates/import-template | downloadable `.csv` template (Name, Email, Target role, Pipeline stage, Assessor, Username, Password, …) |
| POST   | /admin/candidates/import      | bulk create candidates (+ linked portal users when `create_users: true`); accepts `csv` or base64 `file_base64`, `dry_run: true` validates the whole file (≤ 2000 rows) without writing; blank username derived from email, blank password generated; credentials returned once; each new portal user is auto-allocated a 50-question assessment unless `auto_allocate: false`. The paper's assessor comes from the row's **`Assessor`** column (name, username, email or id of an active assessor; an unknown value rejects the row), else the request's `assessor_id` (the dialog's default selector; an unknown default is ignored), else it is left unassigned; the commit also returns `imported_candidate_ids` so the dialog can set one assessor on everyone it just imported — the dry run's `preview[].assessor` and `default_assessor_name`, and the commit's `auto_allocations[].assessor_id / assessor_name`, say which. **A commit is paged**: send `offset` + `limit` (≤ 200 rows a request; the dialog uses 100) and follow `page.next_offset` until it is `null` — each page validates the whole file, writes only its window and reports its own `imported` / `users_created` / `credentials` / `errors` / `duplicate_rows`; an unpaged commit over 200 rows is refused with 422. Rows already imported by an earlier attempt come back as duplicates, so re-uploading a file after a failed page continues where it stopped |
| CRUD   | /admin/users                  | provision users (admin-only) + reset/deactivate (switching an assessor off returns `open_assessments`, the papers still waiting on them); an invalid `assessor_id` for a candidate user is a 400 before anything is written; candidate users are auto-allocated a 50-question assessment (their target track, else the workspace default; `role_id`/`assessor_id`/`question_count` steer it, `auto_allocate: false` provisions the login only). `name` cannot be blank; `email`, when given, must look like an email; a malformed `question_count` (not a whole number in 1–50) is a 400 on every allocation path (manual, user creation, bulk import) — it is never silently replaced by the default. A PATCH that changes `password` or sets `active: false` revokes every session of that user (an admin changing their own password keeps the session making the change); reactivating never revives revoked tokens |
| CRUD   | /admin/roles[/:id]            | tracks; detail includes competencies + framework  |
| POST/PATCH/DELETE | /admin/competencies[/:id] | weights (0–100), target levels (whole numbers 1–5), enrichment hints; `role_id` is fixed at creation |
| GET/POST/PATCH/DELETE | /admin/questions[/:id] | role/competency question bank, validated per type. Choice questions need ≥2 options with **unique ids** and **distinct labels** (case-insensitive); a typed-but-blank label is reported as `Every answer option needs a label.`; repeated `correct_option_ids` are de-duplicated before the single/multi key rules run and stored de-duplicated |
| GET/POST/PATCH/DELETE | /admin/question-bank/* | module/family question bank (modules, family detail, plan, preview, single add/edit/delete, import) — **scoped by `role_key`** (query or body; the default is the historical RSA bank, `databricks-rsa`; a key without a published bank is a 400). `POST …/import` accepts raw `csv` or base64 `file_base64`, honors `dry_run` before committing, and accepts both the template columns and the published workbook export headers (including `• A) …` inline options) |
| GET/PUT | /admin/frameworks?role_id=   | scoring framework; GET for a `role_id` that does not exist is a 404. PUT validates (422 + `problems[]`): ≥2 bands with unique plain-text `key`/`label` (≤120 chars), unique `min` 0–100 and one band at 0; `level_thresholds` exactly 5 ascending numbers starting at 0; `gap_severity` whole levels with `4 ≥ critical > moderate ≥ 1`. Only those fields (plus optional band `tone`/`description`) are stored — the config is copied into every new assessment snapshot |
| GET    | /admin/roles/:id/question-plan | preview an allocation: `?limit=X` → served total, points and per-competency split (no `limit` = full bank; capped previews are limited to 50). Also returns `max_questions` and, for the published-catalogue track, `catalogue: { total, missing }` |
| GET/POST | /admin/assessments          | allocation builds immutable snapshot; optional `question_count` (1–50, and never more than the track's active bank) serves a random weighted sample of X questions, apportioned across competencies by weight |
| GET    | /admin/content/catalogue     | published-catalogue status: whether a track matches, its bank size vs the catalogue, and how many published questions are missing — `?role_key=` scopes to a track (default RSA) |
| POST   | /admin/content/sync          | add the published questions the matching track is missing (body `role_key` scopes to a track, default RSA; idempotent; never duplicates, reactivates or edits existing records; audited as `catalogue_synced`) |
| GET    | /admin/content/tracks        | every published track (`databricks-rsa`, `databricks-ai-bi-genie`, `senior-consultant`, `technology-risk-sama`) with its install state in this workspace: `installed`, `active`, `role`, `competency_total`, `catalogue_total`, `bank_total`, `missing`, `authoring_only` |
| POST   | /admin/content/tracks        | install a published track that the workspace does not have (body `role_key`, required): creates the role, its default scoring framework, competencies and published questions → 201 + `track_installed` audit event; an installed track is topped up instead (200, same counters as `/sync`); a deactivated track is refused with 409 (reactivate it, never a second role); unknown key → 400. This is what **Roles & frameworks → Published tracks → Add to workspace** and the `npm run seed` migration path call |
| PATCH/DELETE | /admin/assessments/:id    | reassign assessor (unscored; the candidate record's `assessor_id` follows); delete (pre-submit) |
| GET    | /admin/reports/:id            | full report incl. assessor + comments             |
| GET    | /admin/audit                  | audit trail                                       |

## Assessor (own assignments only — everything else is 404)
| Method | Path                              | Notes                                    |
| ------ | --------------------------------- | ---------------------------------------- |
| GET    | /assessor/assessments             | assigned list, limited candidate profile |
| GET    | /assessor/assessments/:id         | answers + rubrics + auto scores (+ report once finalized). Spoken answers carry `has_recording: true` instead of the clip — the payload stays small whatever the paper size |
| GET    | /assessor/assessments/:id/recordings/:question_id | one recorded answer, `{ question_id, audio_b64, audio_mime }`, fetched by the scoring screen per question (two at a time); 409 before submission, 404 when there is no recording (or the paper is not yours) |
| PUT    | /assessor/assessments/:id/scores  | save scores/comments (manual questions)  |
| POST   | /assessor/assessments/:id/finalize | locks scores, computes report, advances stage |

## Candidate (own records only)
| Method | Path                            | Notes                                     |
| ------ | ------------------------------- | ----------------------------------------- |
| GET    | /candidate/assessments          | own list without assessor identity        |
| GET    | /candidate/assessments/:id      | quiz payload — sanitized (no keys/rubrics), first open starts the clock |
| PUT    | /candidate/assessments/:id/answers | autosave a draft for the question **on screen, while its clock runs**; drafts for any other question (passed, not yet served, or expired) are ignored and listed in `ignored_question_ids`. Malformed values are 422 whichever question they name. The exam hall sends one on every change (a choice after 400 ms, typed notes after 1.5 s, a recording as soon as it stops) — it is the answer that gets locked if the lock itself arrives after the window |
| POST   | /candidate/assessments/:id/phase | one-way review → answer transition for open questions (a repeat call is 409, so the timer cannot be reset). The reply carries `screen` — the same payload as `GET …/:id` — so the client paints the answer phase without a second round trip |
| POST   | /candidate/assessments/:id/next  | lock the current answer and advance the cursor. The question left behind is **always** locked: with the posted answer, else with the draft autosaved in time, else as a blank (open blanks carry `source: "skipped"` or `"timed_out"`). A late answer (past the 5 s grace) is not accepted. A successful advance that is not the last one carries `screen` (same payload as `GET …/:id`) for the next question; a duplicate/no-op advance (`duplicate: true`) and the final lock (`complete: true`) carry none |
| POST   | /candidate/assessments/:id/integrity | proctoring event (tab switch, copy attempt, …). Known event names get their own counter, anything else is filed under `other`; the API itself records `spoken_answer_missing` and `time_expired` (a question window that ran out — hard expiry, a review window slept through, a blank auto-advance), which are surfaced as their own tiles on the admin integrity screen |
| POST   | /candidate/assessments/:id/submit | finalises the paper the walk locked; the `answers` body is validated but **never graded** (a question left blank submits as a blank, an unwalked paper is 422 with `missing_question_ids`); auto-scores MCQ/scale; 409 on resubmit |
| GET    | /candidate/reports/:id          | report card after finalization, internal comments withheld |

> **Open-question answer contract** (`src/core/spoken-answer.mjs`): `GET /candidate/assessments/:id`
> projects `audio_required: true` for *every* `type: "text"` question — it is a rule of the question
> type, so a legacy bank row or an already-frozen snapshot cannot lose the microphone. An open answer
> is posted as `{ text, transcript, audio_b64, audio_mime, source }` and counts as answered when it
> carries typed notes, a transcript **or** a recording (an audio-only answer is never treated as
> blank). The clip itself is stored in the `recordings` table (one row per assessment × question,
> `audio: { b64, mime }`) and the stored answer keeps only `audio_ref` + `audio_mime`; a client-sent
> `audio_ref` is ignored. A row written before the recordings table existed (clip inline on the
> response) is still served, and is moved into `recordings` when the paper is submitted.
> A clip travels **once**: an answer that carries no `audio_b64` but `audio_keep: true` keeps the
> recording already stored for that same question (the draft the exam hall autosaved when the
> recording stopped, or the one restored after a reload) instead of dropping it — so note edits and
> the lock do not re-upload a two-minute clip. The reference comes from the store, never from the
> request: with nothing stored, `audio_keep` changes nothing and the answer is flagged `audio_missing`
> as usual. Without `audio_b64` *or* `audio_keep`, the posted answer is the answer and any stored
> recording for the question is dropped.
> The exam UI hard-gates "Lock & continue" on spoken evidence; the API never throws a candidate's work
> away, so a typed-only lock is stored, marked `audio_missing: true`, counted as a
> `spoken_answer_missing` integrity event and audited as `exam_spoken_answer_missing` for the assessor
> and the proctoring view.
