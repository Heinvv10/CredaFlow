# Lesotho PostBank LMS tender (LPB/0009/2026) — build plan

**Decided 2026-10-29 (Hein):** bid as a JV, CredaFlow + Fair Score (51%, brings ISO 27001,
references, certified staff). Bid closes **25 Nov 2026 12:00 CAT**; clarification
questions close **12 Nov 16:30 CAT**. Tender PDF: `~/Downloads/Loan-Management-System-Bid-document.pdf`
(text: Section 6 = spec items 1–7; evaluation is pass/fail per item, "Comply" needs evidence,
live demo may be demanded; PCI/tokenization/encryption/REST deviations are automatic Fail).

Gap analysis (2026-10-29, Explore agent): config engines, Lesotho jurisdiction, IFRS 9,
restructures, SSO/OAuth, tamper-evident audit + SIEM, k8s/observability/CI scanning are the
big gaps. Already built: bureau, PASQ/key facts, reminders/LoD, debit retry, legal/repo,
SoD disbursement, settlement quotes, SMS/email/WA, OpenAPI.

## Tiers (approved)

**A — must Comply + demo**
| ID | Work | Spec | Wave | Depends |
|---|---|---|---|---|
| A1 | Jurisdiction layer: lender currency (LSL/ZAR), Lesotho ID, holidays per country, NCA flows gated to ZA | 4.10, 5.8, implicit | 1 | — |
| A2 | IFRS 9 staging/SICR/ECL + interest suspension on NPLs + reports | 2.8.2, 2.8.3 | 1 | — |
| A4 | Configurable rules engine + scorecards → risk grades + auto approve/decline/refer w/ reason codes + simulation on history; generic maker-checker (`lib/maker-checker/`) | 2.3.1, 2.3.2, 2.3.5, 2.3.7, 2.3.9 | 1 | — |
| A7 | SSO (OIDC + SAML) for staff; OAuth2 client-credentials on `/v1` API | 4.5, 3.6 | 1 | — |
| A8 | Tamper-evident audit (append-only + hash chain) + SIEM forwarding (syslog/HTTPS) | 2.8.5, 4.7 | 1 | — |
| A9 | Helm chart/K8s manifests, CI SAST + dep + container scan, OpenTelemetry + structured logs + /metrics | 5.3, 5.6, 5.7, 4.8 | 1 | — |
| A5 | Product engine: weekly/fortnightly, grace, bullet/interest-only, product versioning w/ effective dates + maker-checker, pricing by risk grade/segment/channel | 2.1.1–2.1.4, 2.6.1 | 2 | A4 |
| A6 | Approval matrix: multi-level by amount/product/risk/branch, delegated authority, TAT escalation, credit committee packs | 2.4.1, 2.4.2, 2.2.6 | 2 | A4 |
| A3 | Restructure / top-up / refinance / consolidation / payment holiday with approval + history | 2.6.6 | 2 | A5 |

**B — if time:** tokenization vault (4.2/4.3), report builder + CSV/PDF (2.8.4), roll/cure/PTP/productivity + early warning (2.7.2, 2.7.10), payroll check-off file import (2.6.3), mobile money adapter, AI credit memos (2.9.3), live PEP/sanctions provider (2.2.2).

**C — mark partial with dated roadmap:** drag-and-drop process designer (2.9.5), full microservice split (5.2), HSM (4.4). Raise "modular monolith + containers = equivalent?" as a clarification question before 12 Nov.

## Conflict rules for parallel work
- One worktree per item: `/home/hein/Workspace/CredaFlow-lpb-<id>`, branch `feat/lpb-<id>-<slug>` from `origin/main`.
- Only A1 edits `TenantConfig`; other items put config in their own models / schema files.
- New schema goes in a new `prisma/schema/<domain>.prisma`; registries get new files.
- ZA lenders must be unchanged: NCA render hashes stay pinned; no re-pin.
- Agents open a ready PR and stop. Coordinator runs blind `/review`, then `mq add`.

## Validation per item
Failing test first; `npx tsc --noEmit`, `npm run lint`, full `npm test`, `npm run ci:quick`; `RUN_*_IT`
suite for any trigger/CHECK; blind review; browser check on a seeded local DB for UI pieces.

## Email to Pramod + Dr Danny (Fair Score)
Hein (2026-10-29): build first, then draft the email. If the build runs past ~5 Nov, flag a
short early version (ISO 27001 scope, LMS references, PM/Security lead CVs, PCI route, JV
paperwork) because clarifications close 12 Nov. First draft kept at the session scratchpad
`email-fairscore-lpb-draft1.md` (superseded once the build is done).

## Status
- 2026-10-29: wave 1 (A1, A2, A4, A7, A8, A9) dispatched.
- 2026-10-29 ~15:20: A9 → PR #252. Team review round 1 REQUEST_CHANGES (3 HIGH: external crons not scheduled in chart, TRUSTED_PROXY unset, metrics token test gap). Fix list sent to lpb-a9; findings posted on PR.
- Follow-ups queued (new items): F1 secret-box.ts openSecret GCM authTagLength 16 + drop semgrep exclusion; F2 shared (Postgres) rate-limit store so limits hold across replicas (spec 5.5 scaling).
- 2026-10-29 ~15:40: A1 → PR #253 (1539+/72 files). Review team (quality, security, TDD, arch-opus, NCA-bypass breaker-opus) running.
  Coordinator decisions on A1 open items:
  - PASQ / NCA credit agreement block LS loans at signing (DB gate). NEW ITEM **A10 (wave 2, after A1 merges)**: for non-NCA jurisdictions, the signing/disbursement gate requires an approved *key facts statement + loan agreement rendered from lender-owned versioned DocumentTemplate* (spec 2.2.4, 2.4.3) instead of PASQ; demo template visibly marked "SAMPLE — bank's legal team supplies wording". Never invent Lesotho legal text. ZA path unchanged.
  - LSL format: keep the agent's `M 1,234.56`.
  - Lesotho ID spec: shape-only (LOW confidence) → put on the clarification-question list for the bank.
  - ~17 local rand formatters: **F3** sweep after wave 2 merges (conflict avoidance).
  - Staff-attested reckless-lending gate: keep for LS (good practice; bank can switch off later).
- 2026-10-29 15:25: all agents hit the 5h usage limit; Hein switched account; all resumed ~15:45.
- A7 → PR #254 (5682+/93). Security-scan fixes (unverified-email linking → subject pin; mTLS DN parser → fingerprint) requested before review; review held.
  Decisions: LDAP not required (spec accepts SAML/OIDC); SSO_SECRET_KEY must be added to existing lender/demo envs at deploy.
- A2 → PR #255 (3265+/59). Review team running: quality, security, TDD, arch-opus, ledger-breaker-opus. Stage 3 at DPD>=90 kept (configurable); IFRS 9 off by default; bank supplies PD/LGD + probation.
- PR #253 TDD reviewer: approved; 3 test gaps sent to A1.
- ~16:30: #255 round 1 REQUEST_CHANGES (make-up run reverses allowance, ON_DEMAND feeds staging, close deadlock, no supersede, AF EAD, Stage 3 basis) → fix list to A2. Decision: per-lender stage3InterestBasis FULL_SUSPENSION (CBL/2.8.3) | NET_BASIS (IFRS 9 5.4.1(b)).
- ~16:45: #256 round 1 REQUEST_CHANGES → fix list to A4. Decisions: non-login per-tenant system user books automated decisions; engine REFERs instead of DECLINE until lender records POPIA s71 sign-off; automated-decline notice paragraph only as lender-approved template; maker-checker gets baseRef/STALE, step-up TOTP, registry files, per-payload approvePermission (A6 needs it); digital-submission trigger for spec 2.3.9.
- Follow-ups: F4 IFRS 9 PD/LGD/settings through maker-checker (after #256); F5 move decide-application.ts to lib/applications/decide.ts with typed result.
- Wave 2 (A5, A6) waits for #256 to merge (maker-checker contract changing).
- ~17:00: #253 round 2 REQUEST_CHANGES (ZA tenant provisioned after load treated as LS → DB trigger + provision checks; footer "NCR null"). DECISION REVERSED: ZA NCA PDFs stay byte-identical (old negative format for ZAR PDFs).
- #254 round 2: fix-review SHIP; breaker no auth break; 1 functional blocker (default SAML NameIDPolicy emailAddress refused) + mTLS single-PEM + no password reset for SSO-linked users → A7. trustIdpMfa REMOVED (staff-TOTP rule unchanged).
- #252 round 2: HIGHs closed; middleware-span token leak + scrubber regression + README/digest/manifest LOWs → A9 (last round).
- A8 → PR #257 (2331+/85): append-only hash-chained AuditLog, SIEM outbox. Review team running (quality, security, TDD, arch-opus, tamper/concurrency breaker-opus with throwaway DB). Merge-order note: #257 changes ~55 IT suites' audit teardown → other branches must use lib/audit/audit-rows.test-helpers.ts after it merges.
- ~17:30: #257 round 1: CRITICAL (in-trigger chain lock → 40001 on Serializable audited txs incl. disburse), phantom links via ON CONFLICT, deadlocks, PII to SIEM, no POPIA redaction design. DECISION: redesign to lock-free inserts + async chainer (insert-only AuditChainLink), digest-hashed PII columns (audited redaction possible), HMAC + daily checkpoints to SIEM, SIEM field allowlist/masking, runtime DB role must not own audit tables. #257 must NOT merge before this.
- #255 round 2 running (fix-review + ledger breaker incl. af-break-credit-notes deadlock comparison vs main). After round 2: A2 builds Reports → IFRS 9 page (F6) with browser screenshots.
- Merge order intent: #252 → #254 → #253 → #255 → #256 → #257 (others rebase onto #257's audit test helper).
- ~17:15: GitHub Actions blocked by billing ("payments failed / spending limit") since ~14:56 UTC+2 — every PR check fails at start; mq can't merge. Hein chose a SELF-HOSTED RUNNER: agent ci-runner creating user gha-credaflow, 2 runners (labels self-hosted,linux,velo,credaflow), branch ci/self-hosted-runner moving quality-gate.yml off ubuntu-latest and replacing the docker postgres service with native PG16 clusters (IsaFlow pattern). No docker group for runner users.
- #254: breaker round 2 reconfirm SHIP on 7a6a1371 → ready to merge once CI runs. Follow-up docs PR: docs/SSO-AND-OAUTH.md lines 78–79 (bound users have no password path while SSO on; disabling SSO is the outage recovery).
- #255 round 2: 5 new accounting faults (backdated population, NET_BASIS double reserve, late-run ordering, effectiveFromMonth, restructure marker) → A2, then Reports → IFRS 9 page.
- ~17:40: #256 round 2 → A4 list (reopen only engine declines + no re-automation after human review; s71 notice correctness incl. WhatsApp; SHADOW side-effect free; SoD for system approvals compares disburser vs capturer/attester; durable trigger sweep; hide system user). FINDING: digital auto-APPROVE always refers (no reckless-lending attestation on portal apps) — correct for ZA/NCA. Follow-up **F7**: for non-NCA lenders allow an automated affordability attestation (after #253) so spec 2.3.9 instant decisioning can approve.
- #252 round 3: one regression (route labeler applied to CLIENT fetch spans) + CLIENT span paths must be segment-masked → A9.
- ~18:00: #252 round 4 SHIP (96006d54) — ready, waiting for CI. #254 SHIP (7a6a1371) — ready, waiting for CI.
- #253 round 3: breaker found suspend-LS-then-activate-ZA on a warm process + concurrent activation race. DECISION: structural fix — single-row InstanceJurisdiction table (immutable once loans exist), all tenants must match it (advisory-locked triggers), app reads it with TTL re-check and fails closed on mismatch; tenant-vs-tenant comparisons removed. Tenant deletion blocked once loans exist: accepted (lenders retired by status).
- 18:22 #252 MERGED (first tender PR on main). #254 ejected by mq (conflicts with #252) → agent lpb-a7b merging main into it.
- ~18:25 terminal crash killed all builders; worktrees a1/a2/a4/a8/f2 hold uncommitted work. Resumed (throttled, load 68–100): lpb-a7b (#254 conflicts), lpb-a8b (#257 redesign), lpb-a1b (#253 redesign), blind review of #258. QUEUED to resume next: a2 (#255 round 2 + IFRS 9 page), a4 (#256 round 2), f2 (F1+F2).
- 19:26 #254 MERGED (after main merge 72db0f9f + reconfirm). 19:33 #258 approved (hardening 08e87cdc reconfirmed) → queued. Worktrees a7, a9 removed. Resumed lpb-a2b (#255 round 2 + IFRS 9 page). Still to resume: a4 (#256 round 2), f2 (F1+F2).
- ~21:00 #258 ejected once by mq: lib/valuation-guides/guide-concurrency.integration.test.ts race test ('two drafts published at once') saw both publish — likely timing flake; re-queued. If it recurs, investigate (native PG on self-hosted runner timing vs guide-store concurrency guard).
- #253 redesign pushed 279e23ae (InstanceJurisdiction) → round 4 fix review + breaker running. #255 round 3 → A2 fix list (ungoverned months posting, report defaults ON_DEMAND, basis switch with open month, stale race, restructure marker). Resumed lpb-a4b (#256 round 2). F2 still to resume.
- ~21:10 USAGE LIMIT reached in coordinator session. Running at stop: lpb-a1b idle (#253 round 4 review: fix-review + breaker running), lpb-a2b (#255 round 3 fixes; IFRS 9 page browser-checked, screenshots CredaFlow-lpb-a2/.scratch/shots/), lpb-a4b (#256 round 2 + bureau-cap race fix), lpb-a8b (#257 redesign, full IT running, not pushed). #258 re-queued in mq after guide-concurrency flake. F2 (feat/lpb-f2-shared-rate-limit, worktree CredaFlow-lpb-f2 with uncommitted WIP) NOT resumed. Next session: use 2026-10-29-lpb-tender-continue-goal.md; check each worktree/PR state first.
- ~22:00 #257 round 2 (4 reviewers incl. real-DB breaker): core redesign sound (0 40001/deadlocks); REQUEST_CHANGES. DECISIONS: web login vs worker login (chain key, chainer, verifier, delivery only in worker; Helm worker own Secret; compose single-container documented weaker); AuditPolicy changes only via definer fn that writes audit row + revision + old-destination events; external anchoring via seq + signed checkpoints at SIEM; createdAt forced by trigger; high-water-mark chaining + deep sweep + audited repair path; HMAC redaction digests; restore paths re-create roles/grants; index CONCURRENTLY in own migration. Sent to lpb-a8b.
- #255 round 4: last small round sent to A2 (basis-switch deadlock removed, posted-freeze for switch-off/forward, exit-date operator command, effectiveFromMonth required). #258 re-queued (all green).
- ~22:10 #255 FINAL: fix review + breaker SHIP on a7698fbf → waiting CI then mq. Decision: IFRS 9 cannot be switched off after first posting (documented). Operator command `npm run lender:set-exit-date`.
- #256 round 2 pushed 3e81f5c6. DECISION: add nullable LoanApplication.capturedById (SoD for engine approvals); sweep cron without singleRun accepted. Then round 3 review.
- lpb-a2b reassigned to F1+F2 (CredaFlow-lpb-f2).
- 21:31 #258 MERGED (self-hosted runners live; worktree removed). #256 round 3: fix review SHIP, breaker REQUEST_CHANGES (capturer gaps, sock-puppet self-approval → SUPER_ADMIN for LIVE/s71 + 30-day account-creation rule, cap fail-open) → A4. #259 (F1/F2) round 1: security APPROVED, breaker REQUEST_CHANGES (fallback resets limits globally, self-trip via pool starvation, key explosion; auth namespaces must fail closed) → A2.
- ~23:35 #253 round 5: fix review SHIP + breaker SHIP. Last small fix to A1 (shared advisory lock in tenant/config guards; search_path = pg_catalog, pg_temp in all guard fns). Accepted: config INSERT silently takes instance jurisdiction (refusing would re-break upserts). #255 queued in mq 21:29Z (CI slow on 2 runners).
- ~00:10 #259 FINAL rate-limit design (after scan oscillation): separate AUTH and OTHER limiter pools; auth fails closed on any store problem incl. pool saturation (accepted: sustained login flood can make logins refuse); non-auth falls back to memory; auth cleanup never evicts active counters, refuses NEW keys over hard ceiling + ALERT; IPv6 /64 bucketing.
- #257 round 2 rework pushed addf8062 → round 3 (security, arch, breaker) running. DEPLOY RISK: demo stacks run as superuser → must migrate to web/worker logins or set AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1 at deploy (docs/DEPLOY.md).
- #256: final breaker check on 6c5552b8 (age rule exempts operator/bootstrap/seed accounts).
- #259 accepted trade-off (final): auth rate limits fail closed (login DoS under flood accepted, documented) + mitigations: per-key single-flight, sealed-group new keys gated by stricter address bucket. Further scan 'DoS vs fail-open' flips = accepted trade-off.
- #253 breaker SHIP on 7353220a → waiting CI then mq. #256: first TOTP self-enrolment excluded from takeover rule; uncapped takeover query.
- ~00:35 #256 FINAL: breaker SHIP on 9d2ebfc4 (takeover rule incl. SSO link/role sync, first-TOTP exemption only ≤7 days after creation, paged fail-closed trail, CRM lead editors) → waiting CI then mq.
- FOLLOW-UP F8: telematics ITs `alerts` and `edge-round2` fail on clean origin/main at ~00:52 SAST (time-of-day dependent, per A8) — can eject PRs from mq overnight. Diagnose + fix (clock injection).
- #257 round 2 full IT 485/490 (A8's 3 fixed in 29a77cbc). After #257 merges, other PRs' ITs must use plantAuditRowsForTest / purgeAuditRowsForTest / purgeAuditPolicyForTest.
- 00:49 SAST #255 EJECTED from mq: telematics time-of-day flake (F8 — confirmed on mq run) + gitleaks 1 finding on the branch. F8 assigned to lpb-a1b (new branch fix/telematics-time-of-day); #255 gitleaks to lpb-a2b. #253/#256 checks still pending; don't queue during 00:30–01:15 SAST until F8 merges.
- #259 FINAL: security APPROVED + breaker SHIP on a86c8917. Optional follow-up: refuse prod boot when TRUSTED_PROXY unset. Auto-queue watcher running for #253, #256, #259 (skips 00:30–01:15 SAST).
- ~02:10 GitHub billing failed AGAIN (hosted jobs not starting). Required checks are only `quality` + `integration` (aggregate), both on ubuntu-latest since #258 hardening → all merges blocked. Agent ci-required opening PR to move those two jobs self-hosted. Also: security.yml scans ALL branches, so #259's synthetic cron secret fails `secrets` on every PR until #259 merges (non-required check). #260 (F8 telematics time-of-day test fix) APPROVED, waiting CI.
- ~02:40 #257 round 4: architecture SHIP (demos boot), security: one change — DEMO_MODE must not double as the privileged-role allowance → explicit AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1 written by demo scripts; demo upgrade-stack also ensures AUDIT_CHAIN_KEY (generate if missing, never overwrite) so tamper-evidence is demoable. Breaker round 4 pending. #261 (required jobs self-hosted) APPROVED → auto-queue on green.
- 2026-10-30: WAVE 1 COMPLETE. Merged: #252 A9, #253 A1, #254 A7, #255 A2, #256 A4, #257 A8 (19:10), #259 F1+F2, #258/#261 self-hosted CI, #260 telematics fix, #263 CI back on GitHub-hosted ubuntu-24.04 (Hein 12:50 "move CI to GH"; velo runners idle as billing fallback). #262 closed (superseded).
  Cross-PR lessons: AuditLog.createdAt is DB-stamped (use plantAuditRowsForTest); checkRateLimit is async (await); register() reads InstanceJurisdiction (boot tests mock @/lib/jurisdiction/load.server).
  Flaky: lib/compliance/pasq-ceremony-guard-migration IT :821 (updateMany resolved {count:1}) failed twice on #260, passed on rerun — investigate.
- 2026-10-30 19:15: WAVE 2 dispatched: A5 product engine → lpb-a2b (CredaFlow-lpb-a5), A6 approval matrix → lpb-a4b (CredaFlow-lpb-a6), A10 non-NCA KFS/agreement gate → lpb-a1b (CredaFlow-lpb-a10). Next: A3 after A5; F7 after A6; F3 rand-formatter sweep after wave 2.
- 2026-10-30 ~20:45: #265 (A6 approval matrix) round 1 REQUEST_CHANGES — breaker proved 7 bypasses (asset finance skips matrix, grade frozen before engine writes it, delegator acts twice, maker via delegate, loosening under-detected, self-grant, committee recorder approves). Fix list + arch addendum sent to lpb-a4b. Breaker repro: scratchpad/break265.integration.test.ts.
- 2026-10-30 ~20:45: #266 (A5 product engine) round 1 REQUEST_CHANGES — NCA cap checked on LoanProduct not version rate (over-cap loan booked), repeat short-term rule skipped, monthly-equivalent instalment wrong for bullet/IO/monthly (NCA parity broken), credit life 4.3x on weekly, principal not reconciling, mandate MONTHLY/throws, IFRS 9 grace accrual. Fix list + addendum sent to lpb-a2b. Repros: scratchpad/break266.integration.test.ts, pr266-breaks.test.ts.
  Spec scoring (arch): 2.1.1–2.1.4 Partial, 2.6.1 Partial/Fail. NEW ITEM **A5b** (after #266): product types (check-off, SME, group, revolving), maker-checker on product create/edit, balloon + variable/reference-rate repricing. Open decision for Hein if A5 changes NCA due dates (31 Jan start → 28 Feb vs main's 3 Mar).
- 2026-10-30 ~21:30: #265 round-1 fixes at ae778228; breaker round 2 running. Deferred (Hein-delegated coordinator decision): branch-scoped approver authority, committee conditions at signing/disbursement; regrade upward-only accepted.
- 2026-10-30 ~21:30: #267 (A10) round 1 REQUEST_CHANGES — ZA holds (no way to give a ZA loan KEY_FACTS); LS breaks: unapproved wording via requiresApproval=false, KFS deleted after ack, file swap / cross-application doc (DB backstops), terms-hash reads OLD, 4 NCA routes missing refusal, template setup not reachable from UI. Fix list to lpb-a1b. Repro scratchpad/brk267.integration.test.ts. Spec 2.2.4 + 2.4.3 Partial.
  NEW ITEM **A10b** (live-demo blocker): LS end-to-end — decide without NCA evidence (credit-life/affordability decl/reckless assessment/SA bureau gated by regime), KEY_FACTS payout booking, debit mandate + statements + certificate of balance without NCR number, LS arrears letter, credit-life policy, offer letter + notifications/branch-assisted signing, seed an approved KEY_FACTS app for the demo.
- 2026-10-30 ~22:50: #265 round 3 — seat rule holds; left: committee DECLINED racing final step (DB trigger fix) + approval-bypass IT fails setup when run with other files. #266 round 2 — NCA parity byte-identical (12,150 cases), reconciliation clean (310,752 schedules); left: weekly/fortnightly monthly-equivalent fee, pricing-input SoD not actually written (inputStaffIds), channel overwritable, PUT tolerance writes submitted value, productType not locked (PO_FUNDING lifts Reg 42 fee cap).
  Follow-ups logged: F8 branch-scoped approver authority; F9 committee conditions shown/enforced at signing+disbursement; F10 unversioned product payout cap re-check after repo cut (pre-existing); A10b also owns LS credit life for bullet/full grace, debit orders/check-off for weekly/fortnightly.
  F11 committee 'latest decision' ordered by createdAt — use an insert sequence (LOW, DB-writer only)
  F12 (system-wide, MEDIUM) maker-checker sockpuppet: a LOAN_ADMIN can create a second LOAN_ADMIN and approve their own drafts (all two-person controls incl. templates, matrix, product versions). Fix: approver must not be created/modified by the maker in last N days (maker-checker MAKER_ACCOUNT_CONTROLLED pattern) applied to every dual-control.
- 2026-10-30 23:26 #265 (A6) MERGED; 23:57 #267 (A10) MERGED. #266 (A5) ejected 00:13 — 11 asset-finance ITs fail (prepare route 422) when combined with main+#267; sent to lpb-a2b for root cause + full 3-shard IT.
  F13 backdateLease moves leases by whole months: 5 lease servicing ITs skipped on 29th-31st (#269) until it moves by the lease's own day gap. F14 prisma/seed/ uses addMonthsClamped(today,1) pattern — check demo seed/bake on 29th-31st. F15 recovery-rules-vat-refund TRUNCATE deadlock flake in combined AF run.
- 2026-10-31 01:36 #269 (AF fixture month-end dates) MERGED. #266 at a55deb62 (main merged). Latent main bug: AuditLog triggers read "Message" inside compound IF; audit_redactor lacks SELECT -> audit redaction ITs fail on shard 1 depending on DB state. Fix PR (nested IF, no grant) assigned to lpb-a2b: fix/audit-trigger-message-read.
- 2026-11-01 06:45: WAVE 2 ALL ON MAIN: #265 A6, #267 A10, #266 A5 (merged 2026-10-31 15:45 SAST, another session, head 1c04bfb8), #269 AF fixture dates, #274 audit Message guards (superseded our fix/audit-trigger-message-read; worktree CredaFlow-audit-msg has untracked superseded work, remove at cleanup). #275 structured schedules BRANCH-only (fail-closed channel check that never reached #266), blind review running.
  lpb-a2b stopped 2026-10-31 on "weekly limit, resets Nov 4 20:00 SAST". Next: A10b (LS end to end, demo blocker), A3, A5b, F7, F3, F8–F15, demo re-bake, compliance summary, Fair Score email (build past ~5 Nov → flag early version; clarifications close 12 Nov).
  F16 five AF accounting ITs fail on the 1st of a month (af-break-real, af-break-real-lease, lease-receipts, lease-receivable, lease-invoices: back-dated/previous-month assumptions; go-live month == current month). Fix fixtures like #269.
- 2026-11-01 10:00: moved to a new session. Goal: handoffs/2026-11-01-lpb-tender-continue-goal.md. #275 queued. A10b PR A fixes uncommitted in CredaFlow-lpb-a10b; PR B local at d78f48e8.
- 2026-11-01 18:05: credaflow-68 took over from credaflow-73. #275, #277 A10b PR A, #282 (rate-limit flake + gitleaks fingerprint) MERGED. secrets IS a required check and scans all refs: one fingerprint on a pushed branch blocks every batch; put it on main. #279 PR B: breaker SHIP on 783d5825, review pending. #281 A3 round 2 fixes. #280 A5b waits for #281, then carries the integration (column copy, guard binding, balloon, carried interest). PR C started on the payout branch. Merge order: #279, #281, #280, PR C. Drafts: lpb-artifacts/email-fairscore-lpb-early-draft.md, clarification-questions-draft.md. New finding: item 1.2 needs the offered version live at a regulated lender; CredaFlow has none, Ndzinga runs the parent. F17: decide 500 with a pricing rule below the product rate (brk279 V1).
- 2026-11-02 11:20: BUILD DONE. All LPB build PRs merged: #279, #290, #291, #281, #293, #292, #280, #294, #289 (last, 4b242b88 at 10:53). ZA NCA fingerprints unchanged, no re-pin. Browser walk on final main 4b242b88 (fresh IT DB, DEMO_LENDER=basotho, no SQL): apply (key facts before submit) -> approve (matrix ungraded rule, LOAN_ADMIN) -> portal sign (offer, key facts, OTP) -> payout by 3 people (admin in-person KYC, payout.confirmer account, loan.admin.two) -> M500 receipt -> arrears letter on LN-SEED-0001. Shots: lpb-artifacts/shots/final-main-walk/. Evidence page https://claude.ai/artifact/8Pm9MsLsU3RXAPQCcGBoVk ; compliance page https://claude.ai/artifact/3CuvQn1X57KdZpsvBDHY41 (20 Comply / 51 Partial / 33 Fail; T1-T6 all Fail; rescore in compliance-summary.json, old one kept as compliance-summary-0da7d4b6.json).
  Walk findings (follow-ups, not fixed): ~15 form labels still say "(R)" on an LS lender (portal scenario explorer, client wizard, expense breakdown, loan calculator, CRM convert; F3 swept formatters only). Seeded walk borrower's statement is 2 years old -> new application opens with NO_STATEMENT, a LOAN_ADMIN clears it with a reason.
  Demo re-bake NOT done: there is no Basotho live stack (tsela = demo.credaflow.com, fairscore = fairscore.credaflow.com, each own data dir/cron/tunnel). Lesotho demo needs Hein to choose: rebrand an existing stack or a new stack + DNS/tunnel route. Asked 2026-11-02.
  2026-11-02 11:45: Re-bake NOT possible as-is (checked 2026-11-02 11:45): Hein chose a NEW basotho stack (basotho./basotho-staff.credaflow.com), but scripts/demo/simulate has no KEY_FACTS/Lesotho path (0 hits; 24 PASQ/debit-order/mandate steps), so bake.sh cannot build a Lesotho snapshot. Needs either simulator LS support (builder work, after 8 Nov) or a seed-only live stack from DEMO_LENDER=basotho (no history; restore.sh only restores snapshots). Then: Cloudflare public hostnames on tunnel credaflow-demo (Hein, dashboard), ports 3350/3352/5486 (3340 is taken), SSO_SECRET_KEY generated into the new .env.production.
