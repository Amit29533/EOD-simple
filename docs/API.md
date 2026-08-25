# ECOD API (summary)

Base: `/api` · Auth: `Authorization: Bearer <token>` (from `POST /api/auth/login`) · Errors: `{ "error": "…" }`

## Auth & meta
| Method | Path                  | Roles        | Notes                                   |
| ------ | --------------------- | ------------ | --------------------------------------- |
| POST   | /auth/login           | public       | {username,password} → {token,user}; throttled |
| POST   | /auth/logout          | any          | ends session                            |
| GET    | /auth/me              | any          | current user + linked candidate         |
| GET    | /meta/bootstrap       | public       | enum config for the UI (static, no user data) |

## Admin
| Method | Path                          | Notes                                             |
| ------ | ----------------------------- | ------------------------------------------------- |
| GET    | /admin/dashboard              | KPIs, pipeline, statuses, activity                |
| CRUD   | /admin/candidates[/:id]       | intake fields, stage, notes, timeline. DELETE requires `{password}` (the signed-in admin's password) and cascades the linked portal user, their sessions and open assessments; blocked (409) once a report is finalized |
| CRUD   | /admin/users                  | provision users (admin-only) + reset/deactivate   |
| CRUD   | /admin/roles[/:id]            | tracks; detail includes competencies + framework  |
| POST/PATCH/DELETE | /admin/competencies[/:id] | weights, target levels, enrichment hints          |
| GET/POST/PATCH/DELETE | /admin/questions[/:id] | question bank, validated per type               |
| GET/PUT | /admin/frameworks?role_id=   | scoring framework (validated)                     |
| GET    | /admin/roles/:id/question-plan | preview an allocation: `?limit=X` → served total, points and per-competency split (no `limit` = full bank; capped previews are limited to 50) |
| GET/POST | /admin/assessments          | allocation builds immutable snapshot; optional `question_count` (1–50) serves a random weighted sample of X questions, apportioned across competencies by weight |
| PATCH/DELETE | /admin/assessments/:id    | reassign assessor (unscored); delete (pre-submit) |
| GET    | /admin/reports/:id            | full report incl. assessor + comments             |
| GET    | /admin/audit                  | audit trail                                       |

## Assessor (own assignments only — everything else is 404)
| Method | Path                              | Notes                                    |
| ------ | --------------------------------- | ---------------------------------------- |
| GET    | /assessor/assessments             | assigned list, limited candidate profile |
| GET    | /assessor/assessments/:id         | answers + rubrics + auto scores (+ report once finalized) |
| PUT    | /assessor/assessments/:id/scores  | save scores/comments (manual questions)  |
| POST   | /assessor/assessments/:id/finalize | locks scores, computes report, advances stage |

## Candidate (own records only)
| Method | Path                            | Notes                                     |
| ------ | ------------------------------- | ----------------------------------------- |
| GET    | /candidate/assessments          | own list without assessor identity        |
| GET    | /candidate/assessments/:id      | quiz payload — sanitized (no keys/rubrics), first open starts the clock |
| PUT    | /candidate/assessments/:id/answers | autosave drafts                        |
| POST   | /candidate/assessments/:id/submit | requires all answers; auto-scores MCQ/scale; 409 on resubmit |
| GET    | /candidate/reports/:id          | report card after finalization, internal comments withheld |
