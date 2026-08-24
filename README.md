# ECOD — Enterprise Capability on Demand

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
npm run seed        # seeds RSA track + demo users/candidates (JSON file store)
npm start           # serves the app on http://localhost:3000
npm test            # 21 tests: scoring engine, API/RBAC journey, Airtable adapter contract
```

Full end-to-end suites (need a running, seeded server):

```bash
python3 tests/smoke.py        # 38 checks: one candidate's complete journey + isolation proofs
python3 tests/features.py     # 141 checks: every feature — CRUD, validation, config editing,
                              # immutability, reassignment, scoring math, audit, persistence
```

### Demo sign-ins (seeded)

| User          | Password              | Portal                                                   |
| ------------- | --------------------- | -------------------------------------------------------- |
| `admin`       | `ECOD-admin-2026`     | Admin dashboard — candidates, roles, users, allocation   |
| `priya.nair`  | `ECOD-assessor-2026`  | Assessor workspace (Rohit Verma allocated to her)        |
| `arjun.mehta` | `ECOD-assessor-2026`  | Assessor workspace (scored Neha Kulkarni example)        |
| `rohit.verma` | `ECOD-candidate-2026` | Candidate portal → take the RSA quiz → report card        |

> ⚠️ These are development credentials for the seeded demo. Rotate them before any real use.

**End-to-end demo loop (2 minutes):**
1. Sign in as **rohit.verma** → *Start assessment* → answer the 21-question RSA quiz (autosaves) → *Submit*.
2. Sign in as **priya.nair** → *Score now* → review auto-scored MCQs, score the 7 open answers against the rubric → *Finalize & generate report*.
3. Back as **rohit.verma** → *View report card*: overall %, readiness band, per-competency levels vs targets, **areas to improve** with recommended focus. (Print / Save PDF supported.)
4. As **admin**: dashboard updated, audit trail captured, candidate advanced to *Gap Mapping*.

---

## What's built (v1 scope)

- **Candidate database** — intake fields, pipeline stage, target role, internal notes, timeline.
- **Role/competency configuration** — roles (tracks), competencies with weights/target levels/enrichment hints, scoring framework (readiness bands, level thresholds, gap severity) — all CRUD in the Admin UI.
- **Assessor allocation** — admin allocates an assessment (role) for a candidate to a specific assessor; reassignment until scoring locks.
- **Assessor portal** — sees *only own assignments*: limited candidate profile, answers, rubrics; scores open questions; finalizes → report.
- **Question/assessment engine** — 4 question types (single/multi MCQ, 1–5 scale, open scenario), autosaving quiz, strict submission validation.
- **Automated scoring** — objective items auto-scored at submit; open items assessor-scored against rubrics; competency-weighted blend.
- **Capability gap generation** — score → 1–5 level per competency, vs role target level; severity (moderate/critical), ordered areas to improve with recommended focus, strengths.
- **Admin dashboard** — pipeline distribution, assessment statuses, readiness KPIs, recent activity, audit log.
- **Role-based access & compartmentalization** — enforced server-side (see matrix below).

Deliberately deferred to the next phases (architecture already supports them): Enrichment
module, Independent Validation module, candidate-facing enrichment plan, client/commercial
entities. There are no `clients`/commercial tables anywhere — nobody can stumble into them.

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

Everything below is plain data, editable under **Admin → Roles & Frameworks / Question Bank**:

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
public/            SPA (index.html, styles.css, js/)
src/core/          domain constants, passwords, pure scoring engine
src/storage/       storage contract + json / airtable / netlify-blobs adapters
src/api/           router, handlers, projections, assessment service
netlify/functions/ serverless transport
scripts/           seed (+ RSA seed content), airtable-setup
tests/             scoring unit tests, API/RBAC journey tests, airtable-adapter contract test, smoke
docs/              ARCHITECTURE.md, API.md
```
