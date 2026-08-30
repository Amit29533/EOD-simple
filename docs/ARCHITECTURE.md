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
which makes each sitting auditable.

**Order of a served paper.** `arrange()` puts the `pin_first` question first and
**interleaves** everything after it by answer type (`core/paper-order.mjs`), then
stamps each row with the `position` it will be asked at. A bare Fisher-Yates left
runs of up to 10 same-type questions on a 110-question paper; the interleave spreads
the minority group evenly instead — the smaller group never repeats and the larger
group's longest run is `ceil(major / (minor + 1))` (measured 10 → 3 here, with no two
recorded answers ever adjacent). The stamp is what makes that order survive storage:
`sortedQuestions`
(`api/quiz-session.mjs`) re-reads the snapshot on every request and sorts by position,
so the candidate's cursor, the assessor's list and the scorer cannot disagree about
which question is "next". Snapshots allocated before positions existed carry none and
keep the legacy grouping — re-ordering a paper someone is halfway through would move
questions out from under their cursor. `GET /admin/roles/:id/question-plan?limit=X`
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

## 2c. Question Bank v1.3 — module → family → question

The finalized bank (`src/content/rsa-question-bank.mjs`, 348 questions, generated from
`Question bank 1.3.xlsx_4343.pdf`) is organised **MODULE → FAMILY → QUESTION** and
drives a *fixed-shape* paper, rather than the weight-proportional apportionment
described in 2b:

| Group | Modules | Served per module |
| ------ | ------- | ----------------- |
| Technical | `T01`–`T10` | 3 objective + 1 open |
| Consulting & Client Skills | `C01`–`C04` | 1 open |
| Professional & Communication | `P01`–`P04` | 1 open |
| Foundation & Integrated Judgment | `F01`–`F02` | 1 open |

Every generated test is therefore **exactly 50 questions**: 30 technical objective
+ 10 technical open + 10 non-technical open. Selection lives in
`src/core/test-generation.mjs` (pure, `rng` injectable): questions are sampled at
random inside each module while the structure above is held exactly. **Nothing is
pinned** — every question competes for its module's quota on equal terms, so no
prompt is guaranteed to appear on a paper.

Modules are ordered `T01`–`T10`, `C01`–`C04`, `P01`–`P04`, `F01`–`F02` — a single
`order` field on the module (`module_order()` in the build script: `T`=10+n, `C`=20+n,
`P`=30+n, `F`=40+n) that the API, the admin view and a generated paper's *sections* all
sort by. The **paper itself is then interleaved** by answer type: quotas are filled
module by module and the finished list is passed through `interleave()`
(`core/paper-order.mjs`) with the same injectable `rng`, so a candidate meets
objective and open questions evenly spread rather than 40 MCQs followed by 10 recorded
answers. On a 50-question paper (30 objective / 20 open) the longest same-type run is
**2** and no two open questions are ever adjacent — a plain shuffle measured 4–7.
`sections` keeps module order, which is what the admin preview reports.

The paper shape is stated **once**, as per-module quotas in
`MODULE_TEST_STRUCTURE` (`src/core/constants.mjs`); `TEST_BLUEPRINT` derives the
paper-wide totals from it. Watch the units — `technical_objective` is *3 per
module* in the former and *30 per paper* in the latter.

**Authoring: published content plus an authored overlay.** `rsa-question-bank.mjs`
is generated from the source PDF and is **never written at runtime** — writing to it
would put the file permanently out of step with the script that reproduces it. Admin
additions are rows in the `bank_questions` table instead, and `src/api/bank-service.mjs`
merges them over the published set (`effectiveBank`) on every read. So:

- reads see one bank; `bank_total = published_total + authored_total`,
- only authored ids are mutable — `PATCH`/`DELETE` on a published id is a **404**,
- an authored question that names a new family **creates** that family in its module,
  which is how the taxonomy grows without a rebuild,
- regenerating the published file from the PDF never clobbers authored work.

Validation is shared rather than duplicated per entry point. `src/core/question-intake.mjs`
exposes `validateQuestion` (one question) and `validateBatch` (a sheet), and both the
single-add route and the import route call it, so a hand-typed question and an imported
row are held to identical rules. It dispatches on `Array.isArray(input.options)` to tell a
canonical form object from a flat spreadsheet row — testing for `prompt` would misclassify
the row, which has one too, and silently discard its option columns.

`src/core/sheet-parser.mjs` reads `.xlsx` and `.csv` with no runtime dependency: it
inflates the ZIP members with `node:zlib`, reads member sizes from the **central
directory** (local headers may carry zeroes with a trailing data descriptor), and resolves
the shared-string table. Its cell regex must match both `<c …>…</c>` and the self-closing
`<c … />` Excel emits for a blank styled cell — matching only the former shifts every
later value one column left.

**Optional pool.** The retired 115-question competency catalogue is re-shaped by
`src/content/rsa-optional-bank.mjs`: each retired competency becomes a `Legacy - …`
family inside its closest current module, tagged `optional: true`, so it appears in the
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

Admin endpoints, all admin-only and all reading through `effectiveBank`:

| Endpoint | Purpose |
| -------- | ------- |
| `GET /admin/question-bank/modules` | modules in paper order, families nested, totals split published/authored |
| `GET /admin/question-bank/families/:id` | one family's questions, with tags and an `authored` flag |
| `GET /admin/question-bank/plan` | per-module readiness (availability excludes the optional pool) |
| `POST /admin/question-bank/preview` | draw a sample paper — never persisted |
| `POST /admin/question-bank/questions` | add one — `422 {errors}` invalid, `409` duplicate prompt, `201` created |
| `PATCH`/`DELETE` `…/questions/:id` | edit/remove an authored question — `404` on a published id |
| `POST /admin/question-bank/import` | bulk import; `dry_run` validates and reports without writing |
| `GET /admin/question-bank/import-template` | the starter CSV with the recognised columns |

A `PATCH` re-validates the whole question, so the merge has to drop fields the
patch invalidates: `family_id` is re-derived when the module or family moves, and
a type switch retires the other type's payload. Spreading the stored record over
the body instead lets a stale derived value beat the new input — which made
"move this question to another module" and "turn this into an open question"
impossible rather than merely wrong.

**Counts describe what can actually be served.** `isActive` lives in
`test-generation.mjs` and is used by the bank counts as well as by selection, so
the module tree can never advertise a question the generator will skip;
deactivated rows are reported as a separate `inactive` count instead. The
`/modules` tree and `/plan` readiness are asserted to agree module-by-module.

The **Question Bank** admin screen (`#/modules`) renders all of them, and carries the
role-based *served question set* panel below the tree — the standalone Question Bank
screen was merged into it, and `#/questions` now redirects there. Uploads arrive as base64
inside JSON because the dev server parses JSON only and caps a request at 2 MB; imports
are additionally bounded at 2000 rows to keep request time and memory predictable. The
UI always calls `import` with `dry_run: true` first and only enables the commit once the
server reports at least one accepted row, so an admin never writes a file sight-unseen.

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
