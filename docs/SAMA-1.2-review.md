# SAMA question bank v1.2 review

Reviewed: 2026-09-24. Source: `SAMA Question bank 1.2.xlsx`.

## Changes compared with the previously published bank

- 100 questions, 10 modules and 10 module-scoped families remain unchanged in count.
- Each module still contains six objective and four open questions.
- All 40 open questions have revised prompts, expected-evidence rubrics, follow-up guidance and suggested duration (now two minutes).
- All 60 objective questions are unchanged, including options and answer keys.
- Question IDs, module/family assignments and other generated question fields are unchanged. Individual workbook row versions remain `1`; the published bank version is now `1.2`.
- All IDs and question texts are unique. All objective questions have four distinct nonempty options and an explicit valid answer key.
- Two-minute open responses match the existing 120-second answer timer. The separate 60-second reading window is unchanged.

## Repository updates

Updated SAMA extraction/build commands, generator configuration, documentation and generated content to v1.2. The assessment catalogue derives its questions from this generated bank and therefore receives the revised prompts and assessor rubrics too.

Added workbook validation and byte-for-byte regeneration tests. Corrected an existing intermittent SAMA UI assertion: a question in its reading phase offers microphone pre-check and Start answering controls, not the answer-phase recorder and Lock & continue control.

## Verification

- `npm run bank:sama-rebuild`: successful; 100 questions, 60 objective / 40 open, no clipped objectives.
- `node --test tests/sama*.test.mjs`: 20 passed during focused verification.
- Final `npm test`: 587 passed, zero failed, zero skipped (including optional jsdom UI tests).
- Tests cover workbook parity, reproducible builds, module quotas, 30-question generated papers, API isolation, catalogue installation/sync, candidate assessment flow, objective scoring, assessor finalization and reporting.

This is a content-integrity and software-integration review, not independent certification of regulatory accuracy. No deployed environment or live database was modified; separate running-server Python smoke/feature/gauntlet scripts were not run.

## Existing workspace rollout caveat

Catalogue synchronization matches by prompt and is additive. On an uncustomized workspace containing all 100 v1.1 questions, syncing v1.2 would add the 40 revised open prompts while retaining the 40 previous open prompts (140 active questions total). It is not an automatic replacement migration. Review and retire superseded open questions through the existing administration workflow before using the updated stored catalogue for new allocations. Do not reset a live database or remove historical assessment records. Existing assessment snapshots are not rewritten by this generated-bank update.
