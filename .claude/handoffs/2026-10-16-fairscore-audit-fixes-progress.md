# Fair Score audit fixes — progress (updated 2026-10-17 11:20 SAST)

Goal: .claude/handoffs/2026-10-16-fairscore-audit-fixes-goal.md

## All fix PRs MERGED (origin/main 6cd882d9)
#137 DebiCheck doc · #138 NCA rate cap (repo+21%, GN R1080) + own-lender debt + one arrears helper · #139 insurance + RBAC ·
#140 countersign-after-mandate + segregation of duties · #141 portal qualify/schedule/payment notifications/PO funding ·
#142 PASQ "Credit Life: Not offered" (Hein signed off) · #143 FSP optional · #144 S129 omit FSP line (Hein signed off) ·
#145 Insurance Officer loan-book scope · #146 s125 settlement (Hein signed off (a)–(f) + COB changes) · #147 staff UX + simulated S129 (complaints copy signed off) ·
#148 bake bg-27 anchor · #149 Fair Score demo data (fictional "Fair Score Demo Lender", FSP 98765, healthier book) · #150 PO follow-ups ·
#151 asset finance/leasing · #152 borrower portal · #153 NCR arrears history · #156 AF arrears-growth cap · #157 cap follow-ups · #158 demo-marker scope.
Every PR had blind review (and breaker review for money/auth) until SHIP.

## Default policies I set — Hein to confirm
- Former directors/sureties removed within 12 months are cross-checked (FORMER_PARTY_LOOKBACK_MONTHS).
- AF payout/booking refused if an answered arrears exception grows > 1.5× the loan's regular instalment (MAX_ARREARS_GROWTH_INSTALMENTS).
- Post-approval new exception on an AF deal: only remedy is cure or cancel (no audited override).
- Repeat short-term loans above 3% pm refused at approval (MICRO30 is 5%): may want a repeat-loan product.
- Fair Score demo uses fictional NCR NCRCP98765 / FSP 98765 with a "Demo lender" note (not on PDFs).

## Still GATED (needs Hein)
DebiCheck provider + sandbox (see docs/DEBICHECK.md) · website chat LLM key · FNB/SB/Nedbank/Capitec CSV samples ·
Stitch paid-at field (value date uses createdAt ≤1h else held) · SACRRA account type for instalment sales · WhatsApp v3 due-day template needs Meta approval per lender ·
af/zu/xh website complaints copy still old route.

## Not done yet (rest of goal §11–12)
- J: Fair Score re-bake on a post-merge image (after 17:00, check sim lock + credaflow-d4 session), verify, then GATE for live switch.
- Browser acceptance of the coverage table on a local seeded stack (staff 127.0.0.1, portal localhost) + screenshots.
- Ledger table (every findings bullet → PR/test/screenshot) and evidence Artifact.
- Note: snapshots baked before #138/#140/#147 need re-bake (3% products, SoD default, demo marker); upgrade-stack now runs the SoD-off and demo-marker hooks.

## 2026-10-17 browser acceptance (credaflow-33)
- Image `credaflow:fairscore-6cd882d9` built from the Fair Score runner (moved to main via local branch runner/fairscore-main). Acceptance stack: containers cf-accept-staff (127.0.0.1:3460) / cf-accept-portal (localhost:3462) on DB cf-accept-fs (pre-audit dump + current migrations). Demo clients there use a session test password in the scratchpad, not the real demo one.
- Verified in browser: B8 arrears/PAR agree dashboard↔collections; B1 staff settlement = COB (R27,991.63); D arrears banner amount+days; B7 notify→reconciliation→reject/allocate; B2 rate cap blocks 36% p.a.; E5/E6 exceptions; C1 FAIS disclosure renders; C2 commission on premium; C3 claim > claimed → 422; C4 Insurance Officer 403 on /api/payments + "You don't have access"; portal decline view, decline-aware apply, micro cap error, PO fields, notification statuses, documents.
- New defects found → PR #162 MERGED 9b2b45c4 (NCA-checks layout jump #34, mandate bank pre-select #41, payment form select-on-focus, reference panel dark mode, policy rate-table premium, header rate-cap blocker, restore.sh runs dpd-update so demo arrears days don't freeze). Blind review 2 rounds → APPROVED; ci green; re-verified in browser.
- NOT yet browser-tested (legacy data lacks approval evidence): origination A1 mandate-before-countersign, A2 SoD, A3 disburse in rail, B3 own-lender debt, op/FML lease pages vs PDF, policy issue, payment plan. Do them on the baked copy. The simulator countersigns BEFORE the mandate, so A1 must be done by hand.
- S129 send click was blocked by the browser-safety classifier → needs Hein's OK (simulated, .invalid recipient).
- Gated for Hein: PASQ page-2 whitespace (#39), mandate "Debit Day of Month: As per repayment schedule" (#41 wording).
- Ledger draft: scratchpad ledger.md (110 rows: 78 FIXED, 11 DATA, 10 OK, 4 INFO, 3 GATED, 1 WONTFIX, 3 UNKNOWN → now fixed by #162 / gated as above).
- Next: rebuild image from main ≥ 9b2b45c4 (runner update-runner.sh), bake after 17:00 (check sim lock + credaflow-d4), acceptance on baked copy, evidence Artifact, then STOP at live-switch gate.

## 2026-10-19 origination acceptance on a staging copy (credaflow-33)

No re-bake by this session: another session (cf-demo-deploy-20261018-mq, Hein-authorised) re-baked and switched both public demos to afe773ca (includes #162) on 2026-10-18; nightly restore OK since. main 03c1ba34 (#183/#185/#186/#187) is NOT in live.

Staging copy: live snapshot 20261018T133808Z restored into `cf-accept-fs` (it-db), migrated to main, image `credaflow:fairscore-03c1ba34`, staff 127.0.0.1:3460 / portal localhost:3462 (`cf-accept-staff`, `cf-accept-portal`, volume `cf-accept-uploads`, worktree `CredaFlow-accept`). Session-generated test password set on that DB only.

Passed in the browser: A1 (mandate signed before countersign, then countersigned), A2 (SoD on: approver 403 on disburse), A3 (disburse from the rail, loan LN-MVERNJ2E-CNO3), B3 staff side (Thabo Sithole 60 DPD: notice + own instalment counted), E1 op lease and FML pages == PDFs (all 36 rows + totals), policy FUN-0005 with FAIS PDF, payment plan.
Held: S129 send (available on LN-MQKMIRLR-TIKK, 92 DPD) — waiting for Hein.

New findings (ledger rows 111–120): portal qualify page ignores own-lender debt (MEDIUM); AF supplier-evidence links /entities/null/ 404; FML memo lists its own booked loan as exposure; payment plan 1 cent short; S129 stage hint vs unavailable button; mixed currency formats; Afrikaans portal English strings; staff 404 shows public links; silent sign button when declarations unticked.

Ledger: `.claude/handoffs/2026-10-19-fairscore-audit-ledger.md` (120 rows). Evidence page: https://claude.ai/artifact/H77u3PX1zXCXpvkK5ye7Zi (private).

Next: Hein — S129 click, PASQ p2 / mandate wording, live switch to a build with #186. Then fix rows 111–120 (none blocks the demo). Remove the staging copy when done.

### 2026-10-19 08:40 update
- S129 simulated send done on staging (Hein OK): issued on LN-MQKMIRLR-TIKK. New HIGH finding row 121: notice prints arrears R669.00 vs outstanding balance R500.00 (principal only). Needs Hein sign-off to change.
- Rows 39/41 (PASQ page 2, mandate debit day): PR #189 (fix/nca-pasq-mandate-layout), ci:full green, blind review R1 REQUEST_CHANGES → fixed → R2 APPROVED; queued `mq add 189`. Hein approved the change ("Fix it").
- Live switch to main (with #186 + #189): Hein approved; scheduled in-session for 17:03 2026-10-19 (build, watched bake, switch, restore, verify, kit, logins file).

### 2026-10-19 09:30
- #189 MERGED (07:02Z). Another agent upgraded live Fair Score to `credaflow:fairscore-2d0370ef` (main incl. #186 + #189) at 09:21 and is baking it (bake.sh running). My 17:03 switch cancelled — not needed, and would collide.
- S129 total fix: branch fix/s129-outstanding-balance (5b0cb900, cd2a8e76 + 2 cleanups pending), blind review R1 APPROVED w/ MEDIUM → addressed, R2 APPROVED; ci:full running. Not in 2d0370ef: needs a later image + bake.
- S129 total fix: PR #191 opened and queued (mq add 191), ci:full green, review R2 APPROVED. Needs the next Fair Score image + bake to reach live.
