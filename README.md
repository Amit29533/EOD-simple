# Anthroprime ECOD — Enterprise Capability on Demand

Assess experienced technology professionals against enterprise roles, map their exact
capability gaps, and maintain a pool of **enterprise-ready talent**.

**Journey:** Candidate Intake → Role Mapping → Assessment → Gap Mapping → Enrichment → Independent Validation → Enterprise Ready

This repository contains the working v1 platform: candidate database, configurable
role/competency/question frameworks, assessor allocation, assessor workspace, the
assessment engine, automated scoring, gap generation, admin dashboard and full
role-based access with strict **compartmentalization** between participants.

The first assessment track is **Databricks — Resident Solutions Architect (RSA)**.
New technologies, roles, competencies, questions, weights and scoring frameworks are
**configuration data, managed from the Admin UI — no development required.**

---

## Quickstart (local, zero dependencies)

Requires Node.js ≥ 20. No `npm install` needed for local development.

```bash
npm run seed        # seeds or synchronizes the RSA track + demo users/candidates (JSON file store)
npm start           # serves the app on http://localhost:3000
npm test            # 259 tests: scoring engine, question apportionment, API/RBAC journey,
                    #           exam session & open-question microphone contract, full exam
                    #           lifecycle (phases/timers/audio/scoring/report), the exam
                    #           answer screen (jsdom), admin validation, question-bank
                    #           authoring (add/edit/import), bulk candidate + portal-user
                    #           import (API + jsdom dialog), Airtable adapter contract,
                    #           sign-in view, app shell, the allocation dialog and the
                    #           published-catalogue sync
                    #           (jsdom is optional; installed for the UI suites)
```

Two black-box suites run against a **live server** and are not part of `npm test`:

```bash
npm run seed:fresh && npm start   # in one shell (restart the server after reseeding)
npm run test:smoke                # candidate -> assessor -> report lifecycle + compartmentalization
npm run test:features             # 202 checks across every admin/candidate/assessor feature
```

Both consume seeded records as they go (submitting, scoring, deleting a demo candidate), so
they are **not idempotent** — reseed and restart between runs or a second pass reports false
failures. Override the target with `BASE=http://host:port/api`.

`npm run seed` is idempotent for an existing store: it adds newly published RSA seed
questions, repairs the spoken-question contract flags (`question_set`, `pin_first`,
`audio_required`) on existing copies, and restores the microphone requirement on every
open question — without recreating users, overwriting admin customizations or changing
existing assessment snapshots. Use
`npm run seed:fresh` only when you intentionally want to reset the local JSON store.

Full end-to-end suites (need a running, seeded server):

```bash
python3 tests/smoke.py        # 39 checks: one candidate's complete journey + isolation proofs
python3 tests/features.py     # 202 checks: every feature — CRUD, validation, config editing,
                              # immutability, reassignment, scoring math, audit, persistence,
                              # password-gated candidate deletion, capped question allocation,
                              # integrity trail, and published-catalogue sync
                              # (both honour BASE=http://…/api)
```

**End-to-end demo loop (2 minutes):**
1. Sign in as **rohit.verma** → *Start assessment* → answer the full-bank RSA quiz (autosaves) → *Submit*.
2. Sign in as **priya.nair** → *Score now* → review auto-scored MCQs, score the open answers against the rubric → *Finalize & generate report*.
3. Back as **rohit.verma** → *View report card*: overall %, readiness band, per-competency levels vs targets, **areas to improve** with recommended focus. (Print / Save PDF supported.)
4. As **admin**: dashboard updated, audit trail captured, candidate advanced to *Gap Mapping*.

---

## What's built (v1 scope)

- **Candidate database** — intake fields, pipeline stage, target role, internal notes, timeline. Deletion is admin-password-gated and cascades the linked portal login, its sessions and any open assessments (finalized reports protect the candidate).
- **Bulk onboarding from Excel** — Admin → *Candidates* (or *Users & access*) → *Import from Excel* takes an `.xlsx` or `.csv` and creates all the candidate records **and**, in the same pass, their linked candidate-role portal logins. Same dry-run-first contract as the question import (ready / rejected / duplicate with reasons), blank usernames derived from email and made collision-free, blank passwords generated and shown once.
- **Role/competency configuration** — roles (tracks), competencies with weights/target levels/enrichment hints, scoring framework (readiness bands, level thresholds, gap severity) — all CRUD in the Admin UI.
- **Assessor allocation** — admin allocates an assessment (role) for a candidate to a specific assessor; reassignment until scoring locks.
- **Configurable assessment length** — at allocation the admin serves either the full question
  bank or **1–50 questions**. The X are apportioned across competencies *in proportion to their
  weight* (largest-remainder, capped per competency), so a shorter sitting still covers every
  competency and scores on the same weighted basis as the full bank. Questions within each
  competency are sampled randomly for each capped allocation. The dialog offers presets through
  50, previews the split before you commit, and the served set is frozen into the assessment
  snapshot. The effective ceiling is `min(50, active bank)` — when the bank is smaller than the
  cap the dialog says so and offers a one-click **published-catalogue top-up** (the same sync
  `npm run seed` performs, available in-app for deployments with no CLI). The seeded RSA track
  contains **115 published questions (105 standard across 7 competencies + 10 spoken
  customer-advisory items)**. Every paper includes the pinned common spoken question
  first and **at most 5 spoken questions**, so a capped allocation can sample a broad,
  weighted set without over-representing the oral set. The spoken-question contract is
  enforced at every layer: a question is recognized as the same published prompt even when
  its wording differs only by typography or a leading label (so it is never served twice),
  admin edits preserve the microphone requirement, the serve path restores the contract
  from the published catalogue even for already-frozen papers, and both sync paths repair
  legacy rows instead of duplicating them. The pinned common question carries no label —
  the retired "COMMON QUESTION —" prefix is dropped from the catalogue and removed from
  legacy rows by the sync, while already-frozen papers are de-labeled at serve time.
- **Open questions are spoken** — `src/core/spoken-answer.mjs` holds the one rule: *every*
  open / scenario question (not only the published spoken set) is answered with a **recorded
  microphone answer**, and the text box beside the recorder is **optional** supporting notes.
  The exam renders the record control for all of them and keeps "Lock & continue" disabled
  until the candidate has actually spoken — a stored clip *or* a live transcript, since
  browsers support one or the other — while the 60-second review window offers a microphone
  pre-check so the permission dialog never eats answer time. A browser that cannot capture
  audio at all is never hard-locked: it may type, and the answer is flagged. The API keeps
  the truth of it: an audio-only answer is a real answer (never discarded as blank), and a
  typed-only lock is stored but marked `audio_missing` and logged as `spoken_answer_missing`
  in the proctoring trail, the audit log and the assessor's paper.
- **Assessor portal** — sees *only own assignments*: limited candidate profile, answers, rubrics; scores open questions; finalizes → report.
- **Question/assessment engine** — 4 question types (single/multi MCQ, 1–5 scale, open scenario answered by microphone recording), autosaving quiz, strict submission validation, optional per-assessment question count.
- **Automated scoring** — objective items auto-scored at submit; open items assessor-scored against rubrics; competency-weighted blend.
- **Capability gap generation** — score → 1–5 level per competency, vs role target level; severity (moderate/critical), ordered areas to improve with recommended focus, strengths.
- **Admin dashboard** — pipeline distribution, assessment statuses, readiness KPIs, recent activity, audit log.
- **Brand mark** — the AP monogram whose crossbar is a handshake, as a scalable SVG.
  `public/js/logo.js` is the single source used by the sidebar and sign-in screen: it paints
  in `currentColor` and punches its gaps with `--logo-cut`, so one mark works on any surface
  in either theme. Static files in `public/brand/` cover the favicon (simplified so it stays
  legible under 32px), the app/touch icon and the social preview image.
- **Animated sign-in + light/dark theming** — glass, blur and motion on the Anthroprime ECOD login; a segmented
  *Auto / Light / Dark* switch there and a toggle in the topbar. The choice is persisted in `localStorage`
  (`anthroprime-ecod-theme`) and applied before first paint, so there is no flash. Every colour is a CSS token
  in `:root` with a `[data-theme="dark"]` override, and all motion is disabled under `prefers-reduced-motion`.
- **Role-based access & compartmentalization** — enforced server-side (see matrix below).

Deliberately deferred to the next phases (architecture already supports them): Enrichment
module, Independent Validation module, candidate-facing enrichment plan, client/commercial
entities. There are no `clients`/commercial tables anywhere — nobody can stumble into them.

## Question Bank v1.4 — modules, families and test generation

The finalized bank ships as published content (`src/content/rsa-question-bank.mjs`),
generated from the published source workbook (`Question bank 1.4.xlsx`):
**348 questions across 20 modules**, organised **module → family → question**, and
listed module by module: `T01`–`T10`, `C01`–`C04`, `P01`–`P04`, `F01`–`F02`.

```
MODULE                                    FAMILY (where a question is added)
T05  Delta Lake, Performance & Cost   ├─ T05:advanced-technical-judgment   10 objective
                                      ├─ T05:delta-lake-physical-design    13 open
                                      ├─ T05:spark-performance-internals   13 open
                                      └─ … 5 more
```

Families are **scoped to their module**. The same family name recurs elsewhere —
*Advanced Technical Judgment* exists in all ten technical modules — so each is
addressed by the compound id `<MODULE>:<family-slug>`. That is what makes
"add this question to that family" unambiguous: a question carries a `family_id`
and belongs to exactly one family inside one module.

| Group | Modules | Served per module |
| ----- | ------- | ----------------- |
| **Technical** | `T01`–`T10` | 3 objective + 1 open |
| **Consulting & Client Skills** | `C01`–`C04` | 1 open |
| **Professional & Communication** | `P01`–`P04` | 1 open |
| **Foundation & Integrated Judgment** | `F01`–`F02` | 1 open |

Every generated test contains **exactly 50 questions**: 30 technical objective +
10 technical open + 10 non-technical open. Questions are picked at **random** from
each module's families while that structure is held exactly — nothing is pinned, and
no question is guaranteed to appear. The paper is then **interleaved** by answer
type, so MCQs and open questions never arrive in blocks; `sections` still reports the
per-module structure in module order (`T01`→`F02`) for the admin preview.

Browse it under **Admin → Question Bank** — one screen for every question in the
platform: the module/family tree, and below it the role-based *served question set*
(what allocation actually puts in front of a candidate today). Each module expands to
its families, any family opens to the questions a new one would join, and the screen
previews a freshly generated paper. The former standalone *Question Bank* screen is
gone; `#/questions` redirects here.

### Adding questions

The published bank is **read-only** — it is generated from the source workbook and is
never written to at runtime. Additions live alongside it in the `bank_questions` table
and are merged over the published set on read, so the bank grows without the generated
file drifting from its source. Only these authored rows can be edited or deleted.

- **One at a time** — *Add question*, or *+ Add a question to `<MODULE>`* on any module
  card. The form follows the answer type: objective questions collect 2–8 options and a
  single correct answer, open questions collect a rubric and probes. Family suggestions
  are scoped to the chosen module, and **typing a name that does not exist creates that
  family** inside the module.
- **In bulk** — *Import (.xlsx / .csv)* accepts an `.xlsx` or `.csv` (first row =
  header, up to 2000 rows). Every upload is **validated as a dry run first**: the dialog
  reports what is ready, what was rejected and why, and which rows already exist, before
  anything is written. Import stays disabled until at least one row is valid. Column
  headers are matched by alias (`Option A`/`A`/`opt_a`/`choice_a` all work), and the
  published Question Bank export is accepted as-is: objective questions whose options are
  embedded as `• A) … • B) …` inside the question cell are split automatically, and the
  correct answer is read from `Correct answer: A` in the probes/evidence cell. A starter
  CSV template is downloadable from the dialog.

Both paths run the same validation as the API, so a question added by hand and one
imported from a sheet are held to identical rules: known module, resolvable family,
a prompt of real length, and a type-appropriate answer key. Duplicate prompts are
rejected against the whole effective bank.

**Optional pool.** The previous 115-question competency catalogue is no longer part
of a generated test. Each retired competency becomes a `Legacy - …` family inside its
closest module, so it stays visible in the same tree without diluting the curated
families. Optional questions are **never** served while a family can fill its
module's quota — they are drawn only to cover a shortfall.

> **Not yet wired to allocation.** The 50-question generator currently backs the admin
> *Preview a test* screen only. Allocating a real assessment
> (`POST /admin/assessments`) still builds its snapshot from the legacy
> competency-weighted bank via `core/question-selection.mjs`, so a candidate today sits
> the **110-question** legacy paper, not the 50-question module paper. Switching the
> candidate journey over means pointing `buildSnapshot` at `generateTest` and teaching
> `core/scoring.mjs` to weight by module instead of `competency_id` — the report card
> still apportions marks per competency, which the fixed per-module structure does not
> supply. Tracked as the next step rather than silently half-done.

### Question order: MCQ and open are interleaved, not shuffled into luck

A plain shuffle leaves long runs of one answer type — measured on this platform:
runs of 4–7 on the 50-question module paper and **10** on the 110-question served
paper. So ordering is an **interleave**, not a coin flip (`core/paper-order.mjs`,
shared by both builders):

- The **smaller** group never appears twice in a row.
- The larger group's longest run is bounded by `ceil(major / (minor + 1))`.
- Which group is "smaller" is decided by count, not by the caller's predicate — a
  paper with more open than objective questions is spaced just as correctly.

Applied in two places:

- **Module bank** (`core/test-generation.mjs`): quotas are filled module by module,
  then the finished paper is interleaved by answer type. Longest run **2**; with
  20 opens among 50 questions, no two opens are ever adjacent.
- **Role-based served set** (`core/question-selection.mjs`): the pinned opening
  question still comes first, everything after it is interleaved, and each row is
  stamped with the `position` it will be asked at — so the candidate's cursor, the
  assessor's review list and the scorer all read the identical order back from the
  snapshot (`sortedQuestions` in `api/quiz-session.mjs`). On the 110-question
  legacy paper that took the longest same-type run from **10 → 3** and never puts
  two recorded answers back to back.

`tests/paper-order.test.mjs` pins the permutation, the determinism per seed and both
bounds; `tests/features.py` re-checks them black-box on a served paper.

Snapshots allocated **before** positions existed carry no positions and keep the
order they were allocated with: re-ordering a paper someone is halfway through would
move questions out from under their cursor.

The bank is regenerated from the published workbook (or an equivalent CSV export) with:

```bash
npm run bank:rebuild
# or, step by step:
node   scripts/extract-question-bank-from-xlsx.mjs "Question bank 1.4.xlsx" data/bank.json
python3 scripts/build-question-bank.py data/bank.json src/content/rsa-question-bank.mjs 1.4
```

Unlike the older PDF export, the v1.4 workbook contains **all four option texts** and
the correct answer inline in `follow_up_probes`, so the generated bank no longer
flags published objective items `needs_option_review` (0 of the 201 objective items
in v1.4). The old PDF extractor (`scripts/extract-question-bank.py`) is retained only
for historical migration.

## Bulk candidate & user onboarding (from Excel)

Admin → **Candidates** or **Users & access** → *Import from Excel* provisions a whole
cohort in one pass. The upload is an `.xlsx` or `.csv`, first row = header, up to 2000
rows; a starter template downloads from the dialog. The workflow mirrors the question
bank import:

1. **Dry run first** — the file is validated and the dialog reports, per row, what is
   ready, what was rejected and why, and what is a duplicate (already in the directory,
   or repeated earlier in the same sheet). Nothing is written until the admin presses
   Import, and the button stays disabled until at least one row is valid.
2. **One checkbox: "Create linked portal users"** (on by default) — every accepted row
   also gets a `candidate`-role portal login linked to its candidate record.

| Column | Required | Behaviour |
| ------ | :------: | --------- |
| `Name` | ✅ | Creates (or is, for a user) the display name |
| `Email`, `Phone`, `Current title`, `Location`, `Source`, `Notes` | | Profiles the candidate; email also seeds a blank username |
| `Years of experience` | | 0–50, numeric |
| `Target role` | | Matched by role **name, key or id**; blank = no track |
| `Pipeline stage` | | Matched by stage **key or label** (Intake, Role Mapping, …) |
| `Username` | | Portal login; blank → derived from email (fallback: name) and numbered on collision (`jane`, `jane2`…) |
| `Password` | | Min 8 chars; blank → generated (`Ecod-…`) |

**Credentials are returned exactly once** — after a successful import the dialog lists
every created login and password (only the scrypt hash is stored), with a
*Download credentials (.csv)* button, so the admin can hand them out. Duplicate
emails, names and usernames are reported rather than overwritten, and re-uploading the
same sheet imports nothing new. The whole batch lands as one
`candidates_bulk_imported` audit event.



## Compartmentalization matrix

| Capability                              | Admin | Assessor            | Candidate | Validator / Trainer |
| --------------------------------------- | :---: | :-----------------: | :-------: | :-----------------: |
| Full candidate pool & PII               |   ✅  | ❌ (assigned only, no contacts/notes) | ❌ (self) |          ❌          |
| Question rubrics & correct answers      |   ✅  | ✅ (assigned, after submission) |     ❌     |          ❌          |
| Score / finalize assessments            |   👁 view | ✅ (assigned only)   |     ❌     |          ❌          |
| Report card                             | full detail | full detail      | own, without assessor identity/comments | ❌ |
| Users & access provisioning             |   ✅  |         ❌          |     ❌     |          ❌          |
| Roles / competencies / framework config |   ✅  |         ❌          |     ❌     |          ❌          |
| Audit log                               |   ✅  |         ❌          |     ❌     |          ❌          |

Cross-participant isolation is by construction: handlers return fixed **projections**
(`src/api/projections.mjs`) and ownership lookups return `404` (existence itself is hidden).

## Configuration (no-code content management)

Everything below is plain data, editable under **Admin → Roles & Frameworks** and
**Admin → Question Bank** (served question set panel):

- **Add a role/track** (any technology): name, slug, technology → a default scoring framework is created automatically.
- **Competencies**: name, category, description, **weight** (100 across a role is a guideline; blends normalize either way), **target level 1–5**, **recommended focus** hint (used in the report's Areas to Improve), order, active flag.
- **Question bank**: 4 types with per-question **points**, difficulty, options + correct answers (auto types), and **assessor rubric** (required for open questions).
- **Scoring framework** per role: readiness bands (label + min overall %), level thresholds (→ 1–5), gap severity cutoffs.

**Immutability of in-flight assessments:** at allocation the platform stores a full
**snapshot** of role + competencies + questions + framework on the assessment. Admin edits
never corrupt ongoing scoring; they apply to the *next* allocation.

## Architecture (and the no-rebuild migration path)

```
public/                       Static SPA (no build step) — Login, Admin, Assessor, Candidate portals
netlify/functions/api.mjs     Netlify Function transport (thin wrapper)
server.mjs                    Local dev transport (static + /api/*), mirrors netlify.toml

src/api/                      Transport-agnostic application  ← business logic lives here
  app.mjs / router.mjs        Session resolution, role guards, routing
  handlers/                   auth, admin, assessor, candidate, meta
  projections.mjs             Audience-specific response shapes (compartmentalization)
  assessment-service.mjs      Snapshot builder, auto-scoring, finalization

src/core/                     Pure, framework-free domain logic (unit-tested)
  scoring.mjs                 autoScore, pctToLevel, readinessBand, computeReport

src/storage/                  Storage adapter layer — ONE 5-method contract:
  json-file.mjs               list/get/insert/update/remove  (dev, demo, tests)
  airtable.mjs                same contract over the Airtable REST API (MVP backend)
  netlify-blobs.mjs           zero-config persistence inside Netlify runtime
  index.mjs                   STORAGE=json | airtable | blobs
```

Select the backend with environment variables — **nothing else changes**:

```bash
STORAGE=json                 # default, local JSON file (data/ecod.json)
STORAGE=airtable             # Airtable MVP backend
AIRTABLE_API_KEY=pat…        # PAT with data.records read/write
AIRTABLE_BASE_ID=app…
STORAGE=blobs                # Netlify Blobs (inside Netlify runtime)
```

**Migrating later** (e.g. Postgres): write one more adapter exposing the same five methods,
select it in `src/storage/index.mjs`. Handlers, scoring, RBAC and the SPA are untouched.
The adapter contract is documented in `src/storage/schema.mjs`; `tests/airtable-adapter.test.mjs`
(mock Airtable server) shows how to verify any new adapter against the contract.

### Using Airtable as the MVP backend

1. Create a base (e.g. `ECOD MVP`) and a Personal Access Token with `data.records:read`,
   `data.records:write` (+ `schema.bases:write` for automatic setup).
2. Provision tables: `AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=… npm run airtable:setup`
   (without the schema scope it prints the exact table/field list to create manually).
3. Seed: `STORAGE=airtable npm run seed`
4. Deploy/run with the three env vars set.

## Deploy to Netlify (anthroprime.com)

This repo is a complete Netlify site (see `netlify.toml`; publish `public/`, functions
`netlify/functions/`):

1. **New site from Git** → pick this repository. No build command needed.
2. Set **Environment variables**: either `STORAGE=airtable` + `AIRTABLE_API_KEY` +
   `AIRTABLE_BASE_ID`, or `STORAGE=blobs` for zero-config persistence.
3. Deploy, then run the seed once (locally, pointing at the same backend):
   `STORAGE=airtable … npm run seed` or via Netlify CLI.
4. **Attach to anthroprime.com** — two clean options:
   - *Subdomain (recommended):* add `ecod.anthroprime.com` as the site's custom domain in Netlify DNS.
   - *Path on the main site:* in the anthroprime.com site's `netlify.toml`:
     ```toml
     [[redirects]]
       from = "/ecod/*"
       to   = "https://<your-ecod-site>.netlify.app/:splat"
       status = 200
       force = true
     ```

## Security notes

- Passwords: **scrypt** salted hashes (Node crypto); constant-time verification.
- AuthN: opaque 256-bit bearer tokens, 12 h sessions, stored server-side; deactivation is immediate.
- AuthZ: route-level role guards + per-resource ownership checks; existence hiding (404 ≠ 403).
- Login throttling (per-username), payload size cap, input validation on every mutation.
- No self-registration anywhere: **accounts are created by admins only**.
- Before production: rotate seeded credentials, serve only via HTTPS (Netlify default),
  and treat `DATA_FILE`/Airtable PATs as secrets (Netlify env vars, never in Git).

## Roadmap hooks (already designed-in)

- `validator` / `trainer` roles exist with zero data access — their modules land next without model changes.
- Enrichment: `competencies.enrichment_hint` already feeds report recommendations; an enrichment-plan entity slots into the same storage contract.
- Validation: `assessments.status = validated` and the independent-validator projection are queued for phase 2.
- New question types: add to `QUESTION_TYPES` + one `autoScore` case (documented in `src/core/constants.mjs`).

## Repo layout

```
server.mjs · netlify.toml · package.json
public/            SPA (index.html, styles.css, js/, brand/ logo assets)
src/core/          domain constants, passwords, pure scoring engine
src/storage/       storage contract + json / airtable / netlify-blobs adapters
src/api/           router, handlers, projections, assessment service
netlify/functions/ serverless transport
scripts/           seed (+ RSA seed content), airtable-setup
tests/             scoring unit tests, API/RBAC journey tests, airtable-adapter contract test, smoke
docs/              ARCHITECTURE.md, API.md
```
