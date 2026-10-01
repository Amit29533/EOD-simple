# ECOD reliability implementation — 1 October 2026

## Delivered

- The previously shipped two-hour exam window remains anchored to the first exam-hall entry. Closing a browser, signing out, or changing devices does not restart it.
- Spoken recordings are now immutable, content-addressed revisions. An answer points to its exact recording; an overlapping draft cannot overwrite a locked answer's audio. Playback verifies assessment and question ownership. Legacy recordings and inline audio remain readable.
- Assessment papers and reports now use immutable detached revisions. Failed parent commits cannot replace the paper or report attached to the last successful commit. Warm instances follow the committed revision; mutable legacy columns are read afresh.
- Permanent deletion enumerates committed and abandoned detached revisions. Cleanup errors propagate instead of being reported as success. The assessment parent remains present until detached cleanup completes, enabling a fresh deletion preview and retry. A partial deletion can already have removed some child data; retries complete the deletion rather than restore it.
- Account creation accepts a persisted request identifier, returns the original account on unchanged replay, verifies the supplied password, and rejects altered account details under the same request. Manual allocation similarly returns its original open paper. Replays repair interrupted candidate-stage updates. Assessor finalization explicitly supports retry-safe requests that return the saved report without rescoring or a duplicate scoring audit.
- The Question Bank's primary preview uses the role's actual automatic allocation engine. Published defaults are RSA 50, AI/BI 50, and SAMA 30 with 25 objective and 5 open items across ten modules. Preview does not allocate a paper. The legacy module-template preview is explicitly distinguished. Actual question identities vary because selection is randomized.
- Admins can issue password-confirmed recovery links in Users & Access. Links expire after 15 minutes, invalidate previous sessions and recovery links, and work once. Only a token hash is stored. The link token is in the URL fragment, and is not a login credential. Password recovery preserves any enabled authenticator factor.
- Optional authenticator protection is available through the sidebar. Setup requires the current password and confirmation of a time-based code. Secrets are encrypted with AES-256-GCM and bound to the user ID. Eight hashed backup codes are issued once. Login codes and backup codes cannot be replayed. Enable/disable revokes other sessions; disable requires the password and a fresh code or unused backup code. TOTP implementation is checked against [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238) SHA-1 vectors.
- Netlify production context requires strong reads and conditional-write metadata instead of silently falling back. `BLOBS_REQUIRE_CONSISTENCY=true` explicitly enables this requirement in runtime environments without a production `CONTEXT`. Deploy previews and branch deployments choose separate stores by default. `BLOBS_STORE_NAME` permits an explicit environment-specific name.

## Netlify rollout

Deploy browser modules and the serverless API together. Production continues using the existing `ecod` Blobs store unless `BLOBS_STORE_NAME` is explicitly changed. Do not change its name without a deliberate data migration. Preview stores are separate and need their own synthetic accounts/content; do not point a preview at production storage.

For authenticator setup, configure a private `SECURITY_ENCRYPTION_KEY` containing 64 hexadecimal characters (32 cryptographically random bytes) in Netlify's function environment, then redeploy. Never put this key in source control, public browser variables, logs, or a chat. Retain it securely with recovery procedures: replacing or losing it makes existing authenticator secrets unreadable. Without this key, normal non-MFA login remains available but MFA setup is unavailable. A protected account still requires its authenticator or a backup code after password recovery.

Set `BLOBS_REQUIRE_CONSISTENCY=true` in the production function environment to ensure enforcement regardless of whether Netlify exposes `CONTEXT` there. A storage environment lacking the required primitives will refuse the operation rather than risk a stale write. Verify this in staging before production rollout.

New writes adopt the immutable layout without bulk migration. Old objects remain readable and become versioned when rewritten. Rolling back to code that predates revision markers would read the wrong detached paths; retain this storage reader if rolling back unrelated features. Backups must include all table objects, response shards, recording objects and detached columns, plus the separately secured encryption key. Copying table objects alone is incomplete.

For Airtable deployments, apply the setup schema's added JSON/text fields (`creation_request`, `mfa_json`, recording `revision`, and session `purpose`). Airtable lacks the conditional-write primitive used here; its cross-instance guarantees remain weaker than Netlify Blobs.

## Verification and remaining work

Full regression run: **766 tests, 763 passed, 3 skipped, zero failures** (approximately 102 seconds). Two additional allocation/finalization replay regressions were then added and verified in a focused run: **3 passed, zero failures**. Tests use disposable local stores and simulated independent Blobs adapters; no production candidates or attempts were changed. Failure-path coverage includes a losing recording draft, failed paper/report parent commit, warm-cache revision changes, retryable cleanup failure, allocation preview composition, recovery expiry/replay, authenticator replay/encryption, and allocation/finalization stage repair.

This is a substantial reliability phase, not certification that the portal is bug-free or that the entire strategy is finished. Remaining work from the strategy includes:

1. Distributed reservation of the candidate/role allocation slot and durable operation journals for every multi-object onboarding/deletion step. Request IDs address replay, but operations with different IDs and process-local locks still need stronger cross-instance exclusion.
2. Delayed collection of unreachable media and paper/report revisions. Immediate collection is deliberately avoided because an in-flight commit can still reference a newly written version. Existing recording retention and full deletion remove media versions; obsolete detached revisions otherwise remain until deletion.
3. Shared login throttling across function instances. Current throttling remains per process. Password-confirmation endpoints also need shared abuse limits.
4. Encrypted backup tooling, a successful staging restore drill, alerting, realistic concurrent-exam load tests, and a deployed candidate-to-report smoke test.
5. Approved timing accommodations, audited support/retake workflows, scoring moderation, additional accessibility verification, and subject-matter review of question distractors and rubrics.

These items should ship in subsequent tested phases. Production deployment, function environment configuration, restore verification and live browser/network behavior have not been verified by this local run.
