# RSA and AI/BI allocation contract

New assessments for `databricks-rsa` and `databricks-ai-bi-genie` use the finalized module bank, including active admin-authored additions and published-question visibility overrides. They no longer draw from the older competency catalogue.

Every new paper has exactly:

| Modules | Per-module selection | Total |
| --- | --- | --- |
| T01–T10 | 3 objective + 1 open | 40 |
| C01–C04, P01–P04, F01–F02 | 1 open | 10 |

That is 30 technical objective, 10 technical open and 10 non-technical open questions. Questions are randomly drawn within their module/type pools, and open questions are distributed throughout the finished paper. No legacy pinned opener or five-question spoken reservation changes these quotas. All open answers retain the recording requirement. Duplicate prompts are removed before generation.

Account onboarding, CSV planning/commit, manual allocation and the primary admin preview share this policy. For these two roles, the effective default is fixed at 50. Requests for other sizes are refused; missing/inactive questions or competencies that prevent a module filling its quota refuse allocation. Existing snapshots, answers and reports are preserved and retain their original structure. This release does not rebuild existing allocated attempts. SAMA's separate 30-question automatic blueprint remains unchanged.

Competency weights still determine report scoring. Module quotas determine which questions are selected, independently of those weights. Modules are mapped to the existing role competencies; missing published competency definitions are included in the frozen snapshot with published scoring defaults, without overwriting stored admin configuration. An explicitly inactive mapped competency makes its modules unavailable.

## AI/BI bank layout migration

The original 100 AI/BI questions and their IDs are retained. The three broad technical groups for Genie, semantic/data quality, and architecture/environments are split into two topic groups each. Together with governance, authentication, QA and operations, these form T01–T10. The existing consulting scenarios are distributed by topic across the ten non-technical modules. The bank's published version is now 2.0.

No new questions or options were invented for this migration. Some module/type pools have exactly their minimum quota, so those questions necessarily recur until admins add more material; randomization cannot create variety beyond the pool. All generated papers nevertheless satisfy the exact required structure.

Legacy authored AI/BI rows are remapped when read, preserving their stored IDs and active flags. New authored rows store `bank_version`, distinguishing new F01/C01 families from similarly named legacy modules. Editing a legacy row writes its new module placement. Overrides continue using the preserved published question IDs. Family counts are derived from the reorganized content.

Workbook regeneration must target `src/content/ai-bi-genie-source-bank.mjs`. The allocation wrapper `ai-bi-genie-question-bank.mjs` applies the reviewed topic mapping; the generator refuses to overwrite it. Netlify Blobs needs no bulk migration. Airtable installations need the added text field `bank_questions.bank_version` from the setup schema.

## Verification

Focused integration tests generate 200 papers per role, check each module/type quota and uniqueness, and confirm that selections vary across runs. They exercise manual allocation, account onboarding, CSV allocation, admin previews, invalid sizes, unavailable modules, preservation of frozen papers, old/new authored-question mapping, candidate answer-key isolation, submission and assessor finalization. A browser DOM test verifies the fixed-size dialog and its 20 quota rows.

Full regression: **772 tests, 769 passed, 3 skipped, zero failures** (approximately 84 seconds). After normalizing candidate-facing difficulty labels, the three focused allocation/journey tests passed again. These checks used disposable local stores; production data and live Netlify deployment were not modified for testing.
