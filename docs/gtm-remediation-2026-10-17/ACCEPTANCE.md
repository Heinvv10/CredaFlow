# Candidate acceptance and external gates

No candidate accepted yet. All evidence must name exact commit, command/scenario, actual outcome and limitation. Unit green does not execute database enforcement. Browser capture does not prove mutation acceptance.

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
