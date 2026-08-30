# ECOD Architecture Decisions

## 1. Transport-agnostic business logic
Handlers are plain async functions over a context `{store, auth, params, query, body}`
returning `{status, body}`. The **same** `createApp(store)` is wrapped by:
- `server.mjs` (local dev: static files + `/api/*`), and
- `netlify/functions/api.mjs` (serverless on Netlify).

Consequence: the platform logic is not welded to Netlify — it can later be re-hosted on
Express/Fastify/Cloudflare/Hono or folded into a custom application with zero rewrites.

## 2. Storage adapter layer (Airtable now, database later)
Every persistence call goes through five methods: `list/get/insert/update/remove`
against named tables with *equality filters only*. Three adapters ship today:

| Adapter            | Use for                                   | Env                                  |
| ------------------ | ----------------------------------------- | ------------------------------------ |
| `json-file`        | local dev, demos, unit/integration tests  | `STORAGE=json` (default)              |
| `airtable`         | the MVP production backend                | `STORAGE=airtable` + key + base id   |
| `netlify-blobs`    | zero-config persistence on Netlify        | `STORAGE=blobs`                       |

A future Postgres/Supabase adapter is a single new file implementing the same contract —
the business logic, RBAC and UI are untouched. `tests/airtable-adapter.test.mjs` doubles
as the contract test any new adapter should pass (its mock server is ~80 lines).

Structured fields (question options, snapshots, reports, answers) are declared in
`src/storage/schema.mjs`; the Airtable adapter transparently serializes them as JSON in
long-text columns, while file/blobs adapters keep them native.

## 2b. Assessment length is an allocation-time decision
An admin may cap an assessment at **1–50 questions** instead of serving the whole bank.
The cap is applied *once*, when the snapshot is built (`buildSnapshot(store, roleId,
{ questionLimit })`), so the served set is frozen into the assessment alongside the
role, competencies and framework. The full-bank option remains available when an admin
explicitly chooses it. Scoring, gap mapping and the report card then operate on exactly
the questions the candidate saw — no downstream code needed changing.

Selection lives in `src/core/question-selection.mjs` (pure, unit-tested). X seats are
apportioned across competencies **in proportion to their weight** using the
largest-remainder method with iterative capping, which guarantees:
exactly `min(X, bank)` questions; no competency drawn beyond its stock; and every
competency represented while X allows (so nothing silently scores 0%). Within each
competency, a capped allocation samples questions randomly so repeated candidates do
not always see the same items. The selected IDs are frozen in the immutable snapshot,
which makes each sitting auditable. `GET /admin/roles/:id/question-plan?limit=X`
runs the same quota code so the admin UI previews the split that allocation will use.

The effective ceiling is always `min(cap, active bank size)`: a 21-question bank can
never serve a 50-question assessment. Because a workspace can lag the published
catalogue (an older seed, or a deployment with no CLI), the published bank is also
served by the app itself: `GET /admin/content/catalogue` reports what is missing and
`POST /admin/content/sync` tops the track up from inside the Admin UI. The allocation
dialog surfaces the same information inline — when the bank is below the cap it
explains why and offers the one-click top-up — so the cap is never silently smaller
than the configured 50. Sync semantics live in `src/api/catalogue-service.mjs` and
mirror `npm run seed`: match the track by key, insert only prompts that are absent,
never touch existing records or snapshots.

## 2c. Question Bank v1.2 — module → family → question

The finalized bank (`src/content/rsa-question-bank.mjs`, 348 questions) is organised
**MODULE → FAMILY → QUESTION** and drives a *fixed-shape* paper, rather than the
weight-proportional apportionment described in 2b:

| Group | Modules | Served per module |
| ------ | ------- | ----------------- |
| Mandatory | `M00` | 1 question, **always**, pinned first |
| Technical | `T01`–`T10` | 3 objective + 1 open |
| Consulting & Client Skills | `C01`–`C04` | 1 open |
| Professional & Communication | `P01`–`P04` | 1 open |
| Foundation & Integrated Judgment | `F01`–`F02` | 1 open |

Every generated test is therefore **51 questions**: 1 mandatory + 30 technical
objective + 10 technical open + 10 non-technical open. Selection lives in
`src/core/test-generation.mjs` (pure, `rng` injectable): questions are sampled at
random inside each module while the structure above is held exactly.

The paper shape is stated **once**, as per-module quotas in
`MODULE_TEST_STRUCTURE` (`src/core/constants.mjs`); `TEST_BLUEPRINT` derives the
paper-wide totals from it. Watch the units — `technical_objective` is *3 per
module* in the former and *30 per paper* in the latter.

**The mandatory question belongs to `M00`.** The source PDF authors it under
`F01`, but the module that serves it is also the module that owns it, so the
build relocates it (keeping `origin_module`/`origin_family` for provenance).
Otherwise `M00` would advertise a family it holds no questions for — the module
would render as empty in Admin while still appearing on every paper, and `F01`
would report one fewer open question than it actually has. The generator still
keys off the `mandatory` flag on the question, never off the module id, so the
pinning survives any future re-grouping.

**Optional pool.** The retired 115-question competency catalogue is re-shaped by
`src/content/rsa-optional-bank.mjs`: each retired competency becomes a `Legacy - …`
family inside its closest v1.2 module, tagged `optional: true`, so it appears in the
same module → family tree without competing with the curated families. Optional questions are **never** drawn while a module can satisfy
its quota from the primary bank; they are only used to cover a shortfall (highest
`optional_priority` first), which keeps a paper at full length even if an admin
deactivates part of the bank. Shortfalls that cannot be covered are reported as
warnings rather than silently under-filling.

**Families are module-scoped.** A family name is not unique on its own — *Advanced
Technical Judgment* appears in all ten technical modules, *Customer Solutioning* in
nine non-technical ones — so the addressable unit is the compound id
`<MODULE>:<family-slug>` (e.g. `T05:cost-finops`). Every question carries a
`family_id`, which is what pins a newly authored question to one family in one
module. `MODULES[].families` nests them; `FAMILIES` / `findFamily(id)` flatten them
for lookup. Both files are generated by `scripts/build-question-bank.py`, so the
grouping is reproducible rather than hand-maintained.

Admin endpoints: `GET /admin/question-bank/modules` (modules with nested families),
`GET /admin/question-bank/families/:id` (one family's questions),
`GET /admin/question-bank/plan` (per-module readiness) and
`POST /admin/question-bank/preview` (draw a sample paper). The **Modules & Families**
admin screen renders all three.

The bank is extracted from the source PDF by `scripts/extract-question-bank.py`. The
exporter clips long MCQ options inside fixed-height table cells, so the correct
answer is restored from the Expected Evidence column and any item still missing a
distractor is flagged `needs_option_review` for an admin to complete.

## 3. Everything domain-specific is data
Roles, competencies (weights, target levels, enrichment hints), the question bank and the
scoring framework (readiness bands, level thresholds, gap severity) are stored records
edited in the Admin UI. The code contains **no RSA-specific logic**; the Databricks RSA
track is published catalogue content (`src/content/rsa-catalogue.mjs`, re-exported for
CLI seeding via `scripts/seed-content.mjs`) the domain team replaces.

## 4. Immutable assessment snapshots
At allocation, the assessment stores a deep copy of role + competencies + questions +
framework. Submission auto-scoring, assessor scoring and the final report all compute
against the snapshot — admin can safely edit configuration without corrupting in-flight
assessments.

## 5. Compartmentalization by construction
- **Route guards**: every route declares allowed roles (`src/api/router.mjs`).
- **Ownership lookups**: assessors/candidates access `own()`-style loaders returning `404`
  for anything that isn't theirs — existence itself is not leaked.
- **Projections**: handlers return fixed audience-specific shapes
  (`src/api/projections.mjs`): assessors never receive contact details/notes/source;
  candidates never receive correct answers, rubrics, assessor identity or per-question
  assessor feedback; validators/trainers have no data access until their modules land.
- Users are **provisioned by admins only** (no self-registration).

## 6. Scoring & gap mapping (pure functions — `src/core/scoring.mjs`)
- `mcq_single` / `mcq_multi`: full points on exact match (multi-select is strict, no
  partial credit — explainable to candidates); zero otherwise.
- `scale 1–5`: linear to points (self-assessment signal).
- `text`: manual assessor score 0–points against the rubric.
- Competency % = earned/max over its questions → **level 1–5** via framework thresholds.
- Overall % = competency-weighted blend → **readiness band** from framework thresholds.
- Gap = `target_level − observed_level` per competency; severity cutoffs from the
  framework; report = band + per-competency table + ordered areas to improve + strengths.

## 7. Intentional v1 limits (honest list)
- JSON/blobs persistence is single-writer; fine at MVP scale, size up via Airtable/Postgres.
- No email notifications yet (assessor/candidate see state in-portal).
- Enrichment & Validation are roadmap modules — roles/constants prepared, no data access yet.
- Reports are immutable once finalized (correction path = new assessment) by design.
