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
An admin may cap an assessment at **X questions** instead of serving the whole bank.
The cap is applied *once*, when the snapshot is built (`buildSnapshot(store, roleId,
{ questionLimit })`), so the served set is frozen into the assessment alongside the
role, competencies and framework. Scoring, gap mapping and the report card then operate
on exactly the questions the candidate saw — no downstream code needed changing.

Selection lives in `src/core/question-selection.mjs` (pure, unit-tested). X seats are
apportioned across competencies **in proportion to their weight** using the
largest-remainder method with iterative capping, which guarantees:
exactly `min(X, bank)` questions; no competency drawn beyond its stock; every competency
represented while X allows (so nothing silently scores 0%); and a deterministic,
reproducible set for a given bank and X. `GET /admin/roles/:id/question-plan?limit=X`
runs the same code so the admin UI previews precisely what allocation will produce.

## 3. Everything domain-specific is data
Roles, competencies (weights, target levels, enrichment hints), the question bank and the
scoring framework (readiness bands, level thresholds, gap severity) are stored records
edited in the Admin UI. The code contains **no RSA-specific logic**; the Databricks RSA
track is seed content (`scripts/seed-content.mjs`) the domain team replaces.

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
