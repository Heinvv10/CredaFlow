# Candidate acceptance and external gates

## Resumed synthetic demo approval

Hein's later explicit approval (“This is still only demo data, so Im approving it. Resume the goal”) permits F15 integration for synthetic demo acceptance. Historical pre-merge legal-block statements below are superseded for that scope. Named real-lender legal review, provider configuration, production prerequisites and any public deployment remain separate. New combined source `70ab5bde` preserves current main `37c85a18` plus F15; no previous gate result is inherited for that combined candidate. Final combined automated/browser/PDF/portable-restore results will be recorded with their exact source and image identity.

Historical private core candidate63a96479 was accepted for its documented local scope and merged as9dfb76b9 while F15 remained separate. All evidence must name exact commit, command/scenario, actual outcome and limitation. Unit green does not execute database enforcement. Browser capture does not prove mutation acceptance.

Combined70ab5bde/image02b900ad now passes exact quick/quality19688tests/14realface/build and owned PostgreSQL2933tests, with two accuracy tests skipped from336selected. Required hosted quality/integration both pass after the necessary quality-only status correction. PR171 merged as0acd1bdf, tree-identical to tested70ab. Independently reviewed fresh browser scopes are portal25+charges7, pricing9, financial16 (including the later-main booked application classification and new full-repayment PO refusal), accounting8 with139-row balanced CSV, staff7/READONLY4+3write403, two normal portal recoveries, operator invitation/TOTP/support/both sign-outs and the complete fresh F15 signing/countersigning/native CLIENT download. These do not imply new provider, camera, insurance, fresh mandate or full loan-disbursement lifecycles.

The sealed combined package has1495verified checksum entries,5397sourceGitblobs/28imageblobs, three actual paired database/upload/key restores with114 matching migrations, preserved receipts/FORCE RLS and zero allocation mismatches. All referenced document bytes were independently checked: base450uploads/352documents, charges443/347, corrected accounting443/347. The accounting fixture's initial missing upload mount was corrected and re-restored; its failed0-file proof remains outside the final package. This is demo acceptance only; named real-lender/provider/hosting prerequisites below remain external. Exact hashes/provenance/rollback are in FINAL-RELEASE.md.

## Automated gates

Iterate targeted fail-first risky regressions and ci:quick using Node22. After independent review, MQ serially integrates committed submissions. Combined candidate runs uninterrupted ci:quality and ci:integration on owned disposable PostgreSQL16, including teardown on failure. Capture catalog triggers and CHECK constraints before compliance changes. Applicable PDF fingerprint/render checks and face-model checks remain mandatory; no unapproved fingerprint repins. Review downstream main drift before merge via existing mq add PR process.

## Browser gate

Private synthetic runtime only, isolated browser contexts and ports. Reproduce each finding and verify corrected outcome against combined candidate, with role/session and theme/viewport recorded. Include setup-to-close accounting, four AVS flag combinations, principal/default charges, borrower/business mobile menu and READONLY direct access. Record console/network exceptions individually.

Complete uncaptured route inventory: forgot/reset passwords; all operator administration/security/support/usage; PASQ token, portal business index, portal password recovery, payment returns, deal-signers and selfie token. Eligible synthetic tokens required; refusal/redirect is distinct from successful flow. Track each route evidence explicitly.

## Additional configuration/acceptance gaps

All start pending verification; absent credentials/approvals are externally blocked only after concrete prerequisite is identified. Never silently exclude sold scope.

| Gate | Required evidence / allowed local preparation |
|---|---|
| G01 identity/legal | Validate configuration fail-closed and render samples; actual lender identity/legal approval external |
| G02 launch pricing | Compare configs with existing cap rules and boundary examples; no real product repricing |
| G03 insurance rates/eligibility | Detect unsupported credit-life quote config; insurer-approved rates external |
| G04 policy disclosures/beneficiaries | Test issuance guards and synthetic flows; approval external |
| G05 FIC/screening | Onboarding roles/prerequisite checks; real screening external |
| G06 security/recovery | Synthetic normal staff TOTP, recovery, break-glass and audience/tenant isolation |
| G07 bureau/KYC | Synthetic success/failure/timeout and enforcement; provider credentials/real external acceptance external |
| G08 OTP/delivery | Wrong/expired/retry/rate-limit/failure synthetic checks; real delivery external |
| G09 mandate | Fail-closed identity/config and local signing; actual creditor/bank acceptance external |
| G10 AVS/payout | Four flag combos, subject binding, separation and simulation; real bank transfer external |
| G11 collections | Local mandate/retry/return invariants; actual bank submissions external |
| G12 online payments | Signed/duplicate/cancel/failure/return synthetic callback cases; real settlement external |
| G13 messaging | Consent/unsubscribe/refusal simulation; real sends forbidden; SMS remains off |
| G14 OCR/AI | Existing permitted corpus/accuracy and timeout checks; preserve explicit existing failed model gates |
| G15 accounting destination | Local mappings/close/export; destination writes require target authorization |
| G16 scheduler | Prepare hosting/task/monitoring procedure; external setup forbidden |
| G17 operator | Private control-plane create/isolation/support/security/recovery acceptance |
| G18 deployment | Fresh reproducible immutable image, provenance, backup/restore and rollback private rehearsal; public deployment requires exact target approval |
| G19 remaining browser coverage | Fresh loan/asset/insurance/maintenance/recovery/complaint/DSAR journeys; distinguish existing fixtures from new mutations |
| G20 accessibility/packaging | Keyboard/mobile navigation, theme contrast, missing dialog descriptions/media; no blanket WCAG claim |

F15 legal presentation changes may be implemented/rendered on an unmerged review branch. Merge requires lender legal sign-off per AGENTS.md and explicit user instruction. Continue independent tasks while this gate remains outstanding.

## G06-R — recovery mutation audit and single-use acceptance

Source-confirmed during recovery route preparation: staff forgot/reset update User reset token/password without lib/audit; portal forgot creates ClientOtp without audit; portal reset changes password and consumes OTP using separate Promise.all writes. Runtime reproduction pending. This is an additional audit-coverage gap in explicitly requested recovery acceptance, not one of F01-F15.

Assigned A separate branch fix/gtm-recovery-audit-20261017 at527291a79909b71a17e62aa225cb81fe7791fcde, own existing A worktree after clean switch. Smallest fix: logAuditStrict within same transaction as token issuance or guarded token/OTP consumption+password mutation; preserve existing rate/Turnstile/channel/tenant/token-format behavior; no secrets in audit. Single-use guarded update must ensure concurrent duplicate consumption produces exactly one successful mutation/audit, and audit failure rolls back credential/token state. Public forgot requests have anonymous actor and identified target, never assert authenticated user. No schema/migration/statutory changes assigned.

Acceptance: fail-first route tests, meaningful owned-Postgres transaction rollback and concurrent replay tests, final candidate full quality/integration, actual private-browser issuance/consume/expired/replay and corresponding sanitized audit events using non-relaying local sink. External delivery remains unproven. Structural OTP schema/purpose/tenant redesign is outside this surgical change; do not claim those combinations accepted without separate evidence.

## G18-R — reproducible pinned public-model acquisition

Pristine31339 image failed Step34 after slow SFace full-body download terminated near38.70MB; Dockerexit1, owned builder OOMKilled=false. Original source quality/database gates remain passed, no image/browser result exists. Same pinned official URL in clean diagnostic container: HEAD200 Content-Length38696353 and Accept-Ranges:bytes; requested tail returned206 exact6353bytes in46ms, first1MiB returned206 exact Content-Range0-1048575/38696353 and1048576bytes in91ms. This isolates long full-body acquisition from file availability/model integrity. Existing fetch has no range/retry/resume and exposes only generic terminated error.

A smallest correction: bounded sequential range retrieval from the identical pinned official URL, strict Content-Range/length/total continuity, safe single-body200 fallback only before accumulation, complete final SHA-256 validation and atomic verified publish. Preserve all model/license pins, runtime transformed-model hash, thresholds and mandatory14real-model tests. Do not silently concatenate a server's ignored-range200, accept truncated/inconsistent pieces, publish partial bytes or bypass corrupt-cache checks. Meaningful tests must exercise multi-range byte assembly, ignored-range fallback, wrong/truncated ranges or body termination and unchanged final checksum rejection/cleanup. B independently reviews committed source; new candidate passes full gates and actual pristine archive/image download before browser acceptance. No user/provider/legal decision needed for this local public dependency acquisition fix.

## G06-U — canonical operator-origin redirects

Actual browser invitation established that an unenrolled operator on operator.localhost was redirected to canonical staff localhost by middleware constructing URLs from Auth.js's rewritten request URL. Unsetting NEXTAUTH_URL is not a valid fix: staff reset links fall back tolocalhost3300 and requireOperatorBaseUrl throws. B correction30b2c7f8 derives all four console redirects from the configured operator origin, preserving scheme/port and callback path without trusting Host/Forwarded/Origin values. Four fail-first cases,36 targeted tests, independent A review and frozen quick passed. Integrated into66c183c1; actual resulting-image invitation/mandatory TOTP/grant/revoke/host isolation acceptance remains pending. No authentication/CSRF/2FA policy relaxed.

## Final core acceptance and remaining configuration gates

Source `63a96479d290b215049b3a3e46977dc09305c21f` is an ancestor of merged main `9dfb76b90fa5b8b5a87fb1430d1af3ffedca5f4a`; root independently confirmed an empty tree diff. Exact local quality, all14 actual face checks, production build and335-selected real-Postgres gate passed (333files/2930tests; two accuracy tests skipped). Hosted quality/integration both passed on63a. Nine PDF fingerprints and five samples/23 original pages matched the preserved baseline. A independently verified all1842 portable checksums,28 image blobs,5272 source Git blobs and all four paired database/upload restores; no allocation mismatches occurred. This is a private synthetic Tsela/Turnstile-TEST build, not a production promotion artifact.

The following status describes each gate's actual scope. External configuration remains outstanding even where a local behavior is accepted. `LOCAL-GATE-MAP.md` maps existing automated suites; final gate receipts establish execution, rather than the source inventory alone.

| Gate | Final scoped outcome / concrete outstanding requirement |
|---|---|
| G01 | Externally blocked for real lender identity and named legal approval. Synthetic identity and fail-closed identity suites passed; no regulator verification inferred. |
| G02 | Accepted existing pricing-rule consistency and nine browser boundaries; no approved launch prices or historical repricing invented. Lender pricing approval remains external. |
| G03 | Externally blocked: TEST asset credit-life has zero active rate tables and zero mandatory eligibility types. Existing synthetic insurance enforcement suites passed; no insurer rates invented. |
| G04 | Externally blocked: five copied policies lack PPR issue/acknowledgement, one lacks FAIS PDF, none records beneficiaries. Insurer applicability/disclosure/beneficiary approval required; no historical acknowledgements fabricated. |
| G05 | Externally blocked: screening provider unset and no RMCP document. Staff FIC/configuration page and automated guards do not establish screening or submission. |
| G06 | Accepted scoped normal staff TOTP, READONLY restrictions, operator audience/host isolation, fresh recovery wrong/valid/replay/expiry and strict transactional audit tests. Browser runtime has a fixture superuser; separate low-privilege integration evidence proves its own RLS scope. Production bootstrap remains target-specific. |
| G07 | Synthetic bureau/KYC enforcement and14 face checks passed. Real bureau/biometric acceptance externally blocked by absent provider credentials. Selfie browser proves landing/refusal/expiry only. Separate legal clone's explicit vendor-UAT policy must be labelled simulated. |
| G08 | Accepted actual local-SMTP operator/staff/portal delivery and recovery/refusal, plus signing-OTP database guards. Real external delivery remains blocked by absent approved configuration; legal signing browser acceptance is separate. |
| G09 | Signed-mandate bank tuple, immutability and countersign database regressions passed. Fresh complete browser mandate and actual creditor/bank acceptance are not claimed. |
| G10 | Accepted four AVS flag combinations, exact subject/application/audit/server binding and separation-of-duties dialog without dispatch. Overall payout readiness or bank transfer not claimed; original flags/providers restored off/unset. |
| G11 | Non-NCA refusal and synthetic collection/database guards passed. Engine remains off; real submission/settlement/returns require provider authority and configuration. |
| G12 | Signed callback/replay/allocation regression suites and truthful return-page UI passed. Real provider initiation, settlement and reversal remain externally blocked. |
| G13 | Consent/unsubscribe/audit/concurrency regressions and local sink behavior passed. Real messaging configuration/delivery remains blocked; no external customer messages sent and SMS stays off. |
| G14 | Externally blocked/unproved: VLM endpoint/key unset, two accuracy tests skipped, prior failed/stopped OCR/statement-reader accuracy gates retained. Unit/face/model-download success does not establish OCR/statement accuracy. Statement AI remains off. |
| G15 | Accepted nine local accounting states, actual close/CSV and independent139-row Decimal debit=credit4075101.12 reconciliation. No Xero/IsaFlow destination write; approved destination/credentials required. |
| G16 | Externally blocked for a named hosting/scheduler/monitoring target; no CRON_SECRET or running scheduler. Historical heartbeat rows are not operational evidence. |
| G17 | Accepted actual operator invitation/set-password/replay/mandatory TOTP/verified login/both sign-outs, synthetic lender provisioning, support grant/read-only/revoke, role and host refusals. No real lender or production bootstrap certification. |
| G18 | Accepted private pristine image/provenance: historical core63 four paired restores and combined70 three independently reviewed paired database/upload/key restores, plus rollback procedure. No public deployment. Production needs a named-target build without baked test inputs and its own acceptance/backup/configuration approval. |
| G19 | Accepted19 precisely scoped formerly uncaptured routes, normal synthetic PO submission plus actual full-repayment refusal, complaint/DSAR mutations and existing signed-deal access/refusal. Existing signed/booked records do not prove new ceremonies or complete provider lifecycles. |
| G20 | Accepted defined keyboard/mobile/short-viewport/sign-out/theme/reference contrast/media/dialog checks in Chrome. No blanket WCAG or cross-browser certification. |

Additional G06-R, G06-U and G18-R corrections are accepted on core63 and preserved/revalidated within the combined70 scopes above: strict single-use recovery audit transactions; middleware and both actual operator sign-out origins; pristine bounded/retried pinned model retrieval without a cache workaround. The later explicit user approval authorizes F15 demo integration; real-lender legal presentation approval remains external.

## G21 — existing provider-signature presentation (legal review)

Status: accepted as an explicitly recorded demo limitation under the user's later approval; real-lender legal presentation review remains external. Discovered during actual F15 render acceptance, not part of the new certificate: original declaration/signature page5 places the synthetic provider typed signature against its preprinted representative name, with the longer new fixture name also crowding the date. Root/A visually confirmed this; exact same-ceremony legacy comparison proves F15 neither introduces nor repairs it. Preserve stored original pages and fingerprints. A real lender's reviewer must assess this sample and approve a separately scoped future remedy if required; no existing signed document may be silently rewritten.

Historical F15 implementation64a1fd37/image37c45525 passed its own quality19687tests/14face/build and integration2932tests (two accuracy skips), actual ceremony and paired artifact review. The later demo approval supersedes that proposal's pre-merge legal blocker only for synthetic scope. Current combined70 results above replace inherited-pass assumptions; real-lender presentation/retention decisions, including G21, remain external. No real provider or production activation is authorized.
