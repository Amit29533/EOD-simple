# ECOD Architecture Decisions

## 1. Transport-agnostic business logic
Handlers are plain async functions over a context `{store, auth, params, query, body, headers, ip}`
returning `{status, body}` (`ip` is the client address the transport resolved — the login
throttle keys on it — so the handlers never read a socket or an `x-forwarded-for` header). The **same** `createApp(store)` is wrapped by:
- `server.mjs` (local dev and self-hosting: static files + `/api/*`), and
- `netlify/functions/api.mjs` (serverless on Netlify).

Request budgets belong to the transport, not the handlers. `server.mjs` uses
`src/api/rate-limit.mjs`, which budgets **per client** (a bearer token's own budget for
authenticated API calls, a per-address budget for anonymous ones, high per-address ceilings
for everything) because an exam room is many candidates behind one NAT address — a
per-address budget was full at a dozen seats. A token earns its own budget only once the app
has accepted it (`createApp` marks each result with a non-enumerable `authenticated` flag for
this purpose); the public routes are always anonymous traffic. The Netlify transport relies on
the platform. Password verification itself is gated process-wide in the login handler
(`src/core/gate.mjs`), because scrypt shares the libuv threadpool with every static-file read.

Consequence: the platform logic is not welded to Netlify — it can later be re-hosted on
Express/Fastify/Cloudflare/Hono or folded into a custom application with zero rewrites.

## 2. Storage adapter layer (Airtable now, database later)
Every persistence call goes through five methods: `list/get/insert/update/remove`
against named tables with *equality filters only*. Adapters may additionally expose
`insertMany`/`updateMany`/`removeMany` (one write per batch instead of one per row); handlers
reach them through the `bulkInsert`/`bulkUpdate`/`bulkRemove` helpers, which fall back to a loop
when an adapter does not implement them — so batching is an optimization, never a requirement.
All three shipped adapters implement all three (Airtable in chunks of ten, its per-request cap).

Batching is not optional on the exam's write paths, though: every adapter rewrites a *whole*
table per single-row write (the file store re-serialises the entire database, the blob store
re-uploads the table blob), so a loop that writes one row per question is a loop that rewrites
the whole store per question. A 110-question submit did exactly that and cost ~1 GB of JSON
locally and a serverless timeout in production — the candidate's *"stuck on Submitting your
assessment…"* panel. The rule that came out of it: **write only the rows that changed, and write
them in one batch per table** (compare with `stableJson` from `api/helpers.mjs` so an equivalent
value with a different key order does not count as a change).

Three adapters ship today:

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

**What lives outside the table objects.** The file and blobs adapters keep each table as one
id-keyed object and rewrite it whole on every write — fine for rows of a few kilobytes,
ruinous for anything that grows with every candidate. `src/storage/row-tables.mjs` declares
three layouts the two adapters share (the same key strings: a file `<store>.rows/<key>.json`,
a blob `<key>`; Airtable already stores records individually and needs none of this):

- **Row tables** (`recordings`, sharded by `assessment_id`, keyed by `question_id`): **one row
  per object** at `rows/<table>/<shard>/<id>`, ids minted as `<shard>/<key>` so a
  `get`/`update`/`remove` needs no index and the per-question lookup the lock and the assessor
  make is a single object read. A two-minute clip is ~320,000 base64 characters and a
  whole-bank paper holds 33 of them, ~10 MB per finished candidate; none of it is ever moved
  by another request. The stored open answer keeps only `audio_ref` (+ `audio_mime`); the
  assessor detail projects that as `has_recording` and the scoring screen fetches clips one
  question at a time from `GET /assessor/assessments/:id/recordings/:question_id`.
- **Shard tables** (`responses`): **one object per assessment** at `shards/<table>/<shard>`
  holding that paper's rows, same id scheme. Every read of `responses` filters by
  `assessment_id`, and an exam step must not carry — or collide with — every other candidate's
  answers. Rows a previous version left in the whole-table object are folded into their shard
  whenever it is read and removed from the old object.
- **Detached columns** (`assessments.snapshot_json`, `report_json`): the frozen paper (~90 KB)
  and the report (~40 KB) are write-once, so they live at `columns/<table>/<id>/<column>` and
  the row keeps a marker; `get` and `list` put them back (cached per instance), `list(t, filter,
  { detached: false })` returns the small columns only for listings, which read the paper facts
  allocation stores on the row instead (`question_count`, `total_points`, `question_limit`,
  `bank_total`, `role_name` — `paperSummary`/`paperFacts` in `assessment-service.mjs`).

Both halves of an id are validated (they become path segments); an unsafe filter value
matches nothing. With this, an exam step at 300 allocated papers moves ~150 KB instead of
26 MB, and the database file of the JSON store grows by rows only.

**Compare-and-swap on Netlify Blobs.** A deploy runs many function instances behind one
store and the adapter's lock is per process, so two instances mutating one object used to lose
one of the writes (two candidates locking answers at once, two cursor advances, two logins).
Every whole-object write — table blobs and shard objects alike — now reads the blob's ETag
(`getWithMetadata`, strong) and writes with `onlyIfMatch` (or `onlyIfNew` for a blob that does
not exist yet; `@netlify/blobs ≥ 10.7.12`); a refused write re-reads and re-applies the
mutation (ids and timestamps fixed before the first attempt), with jittered pauses up to ten
attempts, then `STORE_CONFLICT` → a retryable **503**. A backend without ETags (the SDK's local
`BlobsServer` under `netlify dev`, older SDKs) degrades to the unconditional write.

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

## 2c. Question Banks — module → family → question

**One bank per published track.** `src/content/module-banks.mjs` is the registry:
each published track (role key) maps to its generated bank (modules, families,
questions, version, optional pool, authored-id prefix). The RSA bank is the
historical default — every unscoped read and call resolves to it, which keeps
single-track workspaces (and existing clients) byte-for-byte as before. The
AI/BI & Genie bank (`src/content/ai-bi-genie-question-bank.mjs`, 100 questions
across 10 modules, generated from `AI BI G Question bank 1.1.xlsx` with the same
`extract → build` pipeline: `scripts/extract-ai-bi-bank-from-xlsx.mjs` +
`scripts/build-question-bank.py` + `scripts/ai-bi-bank-config.json`) is a
first-class entry: its own tree, plan, preview, import and authoring. The
Technology Risk Consultant - SAMA bank (`src/content/sama-question-bank.mjs`, 100
questions across 10 modules, generated from `SAMA Question bank 1.1.xlsx` by
`scripts/extract-sama-bank-from-xlsx.mjs` + `scripts/sama-bank-config.json`; its
served catalogue is `src/content/sama-catalogue.mjs`, authored ids `TRC-…`) is
registered the same way. All
`/admin/question-bank/*` routes accept `role_key` (query or body); authored
`bank_questions` rows and published-visibility overrides carry a `role_key`
column (legacy rows without it belong to the default RSA bank), so the banks
can never bleed into each other. The per-track paper shape is derived from the
bank's own module list (`blueprintFor()` in `core/test-generation.mjs`) — RSA
computes 50 questions as before, AI/BI & Genie 31 (21 technical objective +
7 technical open + 3 consulting open), SAMA 30 (20 risk & control objective +
4 risk & control open + 5 reporting objective + 1 reporting open: 25 objective + 5 open).

The finalized RSA bank (`src/content/rsa-question-bank.mjs`, 348 questions, generated from
the published `Question bank 1.4.xlsx` workbook) is organised **MODULE → FAMILY →
QUESTION** and drives a *fixed-shape* paper, rather than the weight-proportional
apportionment described in 2b:

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
is generated from the published workbook (or an equivalent CSV export) and is **never
written at runtime** — writing to it would put the file permanently out of step with
the script that reproduces it. Admin additions are rows in the `bank_questions` table
instead, and `src/api/bank-service.mjs` merges them over the published set
(`effectiveBank`) on every read. So:

- reads see one bank; `bank_total = published_total + authored_total`,
- authored ids are fully mutable; a published id only accepts visibility changes —
  `DELETE` removes it from circulation (an override row, restorable via
  `PATCH { active: true }`), any other write is **400**, an unknown id **404**,
- an authored question that names a new family **creates** that family in its module,
  which is how the taxonomy grows without a rebuild,
- regenerating the published file from the workbook never clobbers authored work.

Validation is shared rather than duplicated per entry point. `src/core/question-intake.mjs`
exposes `validateQuestion` (one question) and `validateBatch` (a sheet), and both the
single-add route and the import route call it, so a hand-typed question and an imported
row are held to identical rules. It dispatches on `Array.isArray(input.options)` to tell a
canonical form object from a flat spreadsheet row — testing for `prompt` would misclassify
the row, which has one too, and silently discard its option columns.

Question *identity* is shared the same way. `core/prompt-key.mjs` holds the one "is this the same
question?" rule — NFKC, leading labels stripped, curly quotes/dashes normalised, whitespace
collapsed, and spaces around punctuation dropped — and the authoring route, the spreadsheet import,
the published-catalogue sync and the serve-time dedupe all call it. That matters because the layers
must agree: a row the importer accepts as distinct is later merged (and therefore never served) by
the allocator, and a copy the dedupe cannot recognise is served as a second question on the same
paper. The rule is deliberately conservative in the other direction too — it must never merge two
different questions — and `tests/question-selection.test.mjs` pins that against the published
catalogue. Both question banks enforce it: the module bank and the role's competency bank
(`POST/PATCH /admin/questions`, which is what allocation draws a paper from: `409` on a duplicate,
scoped to the role so the same prompt can be reused in another role's bank).

`src/core/sheet-parser.mjs` reads `.xlsx` and `.csv` with no runtime dependency: it
inflates the ZIP members with `node:zlib`, reads member sizes from the **central
directory** (local headers may carry zeroes with a trailing data descriptor), and resolves
the shared-string table. Its cell regex must match both `<c …>…</c>` and the self-closing
`<c … />` Excel emits for a blank styled cell — matching only the former shifts every
later value one column left.

Question imports accept the template columns (`Option A`/`correct`/`rubric`) and the
published Question Bank export columns as-is. `question-intake.mjs` treats
`original_ecod_question` as the prompt and `follow_up_probes` / `difficulty_band` /
`assessment_mode` / `suggested_minutes` / `expected_evidence_ecod_designed` /
`enrichment_prescription` as their alias fields, and when an objective cell carries its
options inline (`• A) … • B) …`), `splitEmbeddedOptions()` recovers the stem and the
four options and `correctFromCell()` reads the answer from `Correct answer: A`.
The workbook's `Objective Question` / `Customer Simulation` / `Scenario` / `Concept` /
`Deep Dive` / `Incident` / `Practical` / `Migration` / `Architecture Case` /
`Experience Probe` / `Discovery` / `Communication` type labels are normalised to the
two modes the generator understands.

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
| `PATCH`/`DELETE` `…/questions/:id` | edit/delete authored; remove/restore published (`DELETE` hides, `PATCH { active }` toggles) |
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
- A competency the paper never reached (allocations can be capped at 1–50 questions, so
  this is normal) is **not** scored 0: it is reported `status: 'untested'` with null
  score/level/gap, excluded from the weighted blend, and listed under `not_assessed`.
  Absence of evidence is not evidence of absence, and a fabricated 0% would also drag
  the overall band down for questions nobody was asked.

## 7. Intentional v1 limits (honest list)
- JSON/blobs persistence has no cross-process lock; fine at MVP scale, size up via
  Airtable/Postgres. Both adapters guard the common cases rather than assume a single writer:
  the file store stamps every write with a revision (`{"rev", "tables"}`) and re-reads a file
  another process changed before serving or mutating — `npm run seed` against a running server
  composes with it instead of being overwritten by the server's next write — and refuses to
  persist over a file it cannot re-read; the blob store starts every mutation from a strongly
  consistent read so one function instance does not resurrect what another removed. Two
  processes writing the *same* table at the *same* instant can still race (last writer wins
  for that one write).
- Airtable caps a text cell at 100,000 characters. The adapter splits the three columns that
  can outgrow it (`snapshot_json`, `report_json`/`quiz_state`, `answer`) across a fixed set of
  continuation columns (`schema.mjs` `overflow`: up to 4 cells for a paper, 5 for an answer —
  a full-length recording is ~400k characters) and refuses anything larger with a
  `VALUE_TOO_LARGE` error that the API surfaces as `413` naming the field. Airtable also drops
  unchecked checkboxes from records; the adapter restores `false` for the boolean columns
  listed in `schema.mjs` `flags`, since the app reads `active === false` as "deactivated".
- No email notifications yet (assessor/candidate see state in-portal).
- Enrichment & Validation are roadmap modules — roles/constants prepared, no data access yet.
- Reports are immutable once finalized (correction path = new assessment) by design.
