# ECOD code audit — 1 October 2026

Scope: the local source, Netlify function transport and bundling, JSON and Blobs
adapter contracts, authentication and authorization, candidate exam lifecycle,
admin provisioning/import/deletion, assessor scoring/reporting, module question
allocation and browser DOM behavior. Production data was not accessed or changed.

## Assessment

The tested workflows pass locally, including negative inputs, interrupted saves,
storage faults and concurrent mutations. This audit improves reliability and
repeatability; it does not certify a bug-free system or production capacity.
The remaining distributed-workflow and deployment checks below matter before
expanding use for consequential assessments.

## Fixes and refactoring

| Finding | Change | Verification |
| --- | --- | --- |
| Candidate stage advancement compared a stale read before writing, allowing allocation to regress a finalized candidate | Conditional candidate mutations recheck the stage after every storage conflict; deleting candidates are excluded; Blobs candidate reads are strongly consistent | Stale-read regression and independent Blobs adapters forced into an ETag conflict |
| Self-service password change could overwrite a concurrent admin reset | Credential hash, active status and session generation must still match inside the conditional user mutation | Injected admin reset after password verification; reset credentials survive and the old session fails |
| Assessor progress counted any stored score, including objective, removed or malformed answers | Count usable scores on served open questions, using the same validation as finalization | Legacy objective/orphan/invalid response fixtures; finalization remains blocked |
| AI/BI workbook rebuild targeted the allocation wrapper | Rebuild targets the preserved source bank | Reviewed command against generator guard and the source/wrapper layout |
| Dependency ranges and an ignored lockfile allowed deployments to resolve different packages | Pin the installed Blobs and jsdom versions and track the full npm lockfile | Clean `npm ci`, full suite using that clean install, npm advisory audit |
| HTTP scripts used old module allocation and detached-file assumptions | Use versioned frozen snapshots and assert the strict 50-question module contract | Complete smoke, feature and gauntlet suites through actual HTTP |
| Storage rollback verification depended on chmod and was skipped on Windows | Inject a real persistence error into the filesystem write boundary | All storage-batch tests pass on Windows, including rollback and recovery |

The score validation refactor shares one rule between progress and finalization.
Other changes are targeted at demonstrated reliability problems; exam content,
existing snapshots and SAMA allocation were not rewritten.

## Verification

- Initial baseline: 772 Node tests, 769 passed, 3 skipped, no failures.
- Clean locked-dependency install: 776 Node tests, 773 passed, 3 skipped, no failures.
- Final full run after portable persistence-failure coverage: **776 tests,
  774 passed, 2 skipped, zero failures** (approximately 91 seconds).
- New regression checks: stale stage, deleting candidate, password reset conflict,
  scoring progress integrity and a forced Blobs stage conflict all pass.
- HTTP smoke: complete candidate exam, assessor scoring, finalization and separate
  admin/candidate report projections passed.
- HTTP feature suite: **237/237** passed.
- HTTP gauntlet: **76/76** passed, including route/role guards, foreign-object
  access, concurrent advances and allocations, input fuzzing, spreadsheet bombs,
  pagination, security headers and request size limits.
- Question-bank audit: **863 published records** across module banks and legacy
  catalogues checked; no duplicate prompts or structural validation failures.
- Allocation tests: 200 random papers per RSA/AI-BI role satisfy every module quota.
- npm advisory audit of the locked dependency graph: **zero known advisories**.
  This is a database check, not proof that dependencies have no vulnerabilities.
- Netlify API: esbuild produced an approximately 1.3 MB bundle; importing it,
  rejecting malformed JSON and responding to preflight requests passed.
- Syntax checks passed for all **85** application, frontend, function and script
  JavaScript modules; `git diff --check` found no whitespace errors.
- Existing stress tests cover sign-in queue saturation, 40 concurrent sign-ins,
  Blobs ETag conflicts, recording/lock races, autosave retries and expiry.

The final full run also exercises the formerly skipped write-failure rollback
test. Two workbook checks
cannot run because `SAMA Question bank 1.2.xlsx` is absent; the published SAMA
bank and its exam/API/UI tests do run.

## Repeatable checks

```sh
npm ci
npm test
npm run bank:audit
npm run test:http
npm audit --audit-level=moderate
```

`test:http` requires Python 3 (`PYTHON` can select the executable). Each suite
gets its own temporary JSON store, seed and localhost port. It never uses
production Blobs credentials or your configured BASE/DATA_FILE. The runner
stops its servers and removes its own temporary store after success or failure.

`.github/workflows/ci.yml` runs these checks on Windows and Ubuntu with Node 24
and Python 3.12. The workflow is added but GitHub-hosted execution has not yet
been observed. Enable required checks on the main branch in GitHub; Netlify's
current build command does not itself wait for GitHub CI completion.

## Remaining production risks and ordered follow-up

1. **Distributed business transactions:** Netlify instance-local locks do not
   enforce uniqueness of usernames/candidate links or one open allocation across
   separate function processes. Conditional table writes prevent lost storage
   updates, but they do not make check-then-insert business rules atomic. CSV
   onboarding, scoring/finalization, reassignment and person purges touch several
   records without one transaction. Add durable reservations/revisions and
   reconciliation, or move these records to transactional storage. Test separate
   processes and inject failure after each workflow write. Existing local race
   passes must not be mistaken for coverage of every distributed interleaving.
2. **Cross-instance abuse limits:** login failure budgets and verification queues
   are per warm process. Add a shared throttle or deployment-level policy and
   validate it on staging, including candidates sharing one network address.
3. **Deployment and operations:** verify the deployed function, production/preview
   store isolation, strict-consistency configuration, backup/export and restore,
   retention, logs/alerts and actual concurrent-exam traffic on a separate Netlify
   staging site. Local JSON measurements are not a Netlify capacity result.
4. **Real devices:** DOM tests and synthetic audio requests do not verify actual
   microphone permissions, device switching, recording playback, mobile browsers,
   hardware failures, browser crashes or network loss on a real device. Run those
   journeys against staging with disposable candidates.
5. **Bank depth and editorial review:** RSA/AI-BI can fill their exact quotas, but
   thin module pools repeat questions. Add reviewed material to those pools.
   Structural validation does not establish subject-matter correctness of every
   answer key; that remains an assessor/content-owner review.

Also review production credential policy: the owner-requested first-name plus
four-digit password format has a small guessing space. Use stronger temporary
credentials and mandatory password replacement for a wider production rollout.
No existing account passwords were changed during this audit.
