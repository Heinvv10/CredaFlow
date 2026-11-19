# Quinn parity — orchestration status (2026-10-14 ~23:00, usage limit hit)

Plan: `.claude/handoffs/2026-10-14-quinn-parity-plan.md`. Hein granted full autonomy on CredaFlow (memory feedback_credaflow_full_autonomy).

| Stream | PR | State |
|---|---|---|
| W5 bureaus | #78 | MERGED c8c65a3 |
| W2 collections | #79 | READY: fix-review SHIP + breaker SHIP at 8f7293b; follow-ups (receipt-link method/reference check, SUSPENDED time separation) — add to merge train after #91 |
| W4 screening/FIC | #81 | READY: Opus fix-review SHIP + breaker SHIP at ff848507; ci:quality + full IT green — merge when Actions billing restored |
| W3 OTP/access | #82 | READY: fix-review SHIP + breaker SHIP; final commit 8d7047c8; ci:quality green locally — merge when GitHub Actions billing restored |
| W0 platform | #83 | READY: fix-review SHIP + breaker SHIP, final 7cf1c6ba reconfirmed; ci:quality green — merge when Actions billing restored (then start W1). Demo/Fairscore need ENV_CREDENTIALS_TENANT_SLUG on next upgrade |
| W8 API/ops | #84 | READY: fix-review SHIP + breaker SHIP at 96876e8; ci:quality + full IT green locally; enc-required opt-in accepted (PR comment) — merge when Actions billing restored |
| W7 i18n | #86 | READY: reviewer SHIP at 92aae15e; ci:quality green — merge when Actions billing restored. Demo/Fairscore re-seed after any af/zu/xh catalogue edit |
| W6 accounting/payouts | #89 | round-2 fixes in progress (NCA figures for reversed loans, NCR return, schedule rows, retry-vs-reversal race, late PAID after FAILED) |
| IT DB guard | #87 | READY: reviewer SHIP (reconfirmed); local ci:full running — merge when Actions billing restored |
| W1 operator console | — | building on feat/w0-platform-foundation (stacked on #83) |
| W0b RLS activation | — | after W1; checklist in docs/ARCHITECTURE.md on #83 |

Merge rule: every reviewer SHIP + CI green, merge with `gh pr merge --merge`, merge origin/main into others first. Re-check every agent result yourself (rm -rf .next before tsc).
Open policy calls for Hein: screening unconfigured lenders pass; thin-file applicants need override; single-admin lenders blocked by maker-checker.

**BLOCKER (2026-10-14 ~23:15):** GitHub Actions jobs not starting (billing failure). main requires quality+integration and enforce_admins=true, so nothing can merge until Hein fixes billing.

**Security streams added 2026-10-15:**
- #92 fix/totp-qr-local — READY (reviewer SHIP at 82f1c0d5). Staff TOTP QR was sent to api.qrserver.com (secret leak); now local. After deploy: staff who enrolled earlier should re-enrol.
- #93 fix/csrf-same-site-gate — READY (Opus security SHIP at 1ec6bf74; ci:quality + full IT + browser check green; logs everyone out once on deploy). no Origin/Sec-Fetch-Site gate anywhere: same-site CSRF on staff+portal (create ADMIN, disburse, decide, borrower NCA signing). Also: __Host- session cookie; portal payment callback marks Stitch payments COMPLETED → webhook drops the real receipt (money bug on main).
- npm audit: 1 critical (next) + 21 high in existing deps — dependency-upgrade stream needed before go-live.
- #91 W1 operator console (stacked on #83): security SHIP + breaker SHIP at b66fd58d; READY at 00676b93 (reconfirmed) — merge after #83, retarget to main.

**Merge coordination (2026-10-15 ~05:20):** credaflow-b0 is landing asset-finance #77 → #85 → #90 (Hein approved merge on green). Agreed: merge-train holds until b0 says #77 merged, then strict turn-taking, one PR per turn.
- Follow-up after #93 merges: `app/api/applications/[id]/statement-export` and `statement-insights` (from #73) still use the old `sec-fetch-site === "cross-site"` check (same-site passes). Switch them to #93's `isCrossOriginRequest`. Impact low (GETs; response unreadable cross-origin; export writes an audit row).

**2026-10-15 06:35 — central merge queue live** (credaflow-b0; systemd --user merge-queue.service; `mq add/status/log`; guard hook blocks agent `gh pr merge`). Merged before it: #87 (5116932e), #92 (15f6b0c4). Queued: #93 #82 #84 #81 #79. Pending owner main-merge: #83 (w0, bureau-framework conflicts), #86 (w7, #80 doc-label conflicts) → then `mq add 83 86 91`. #89 in round-3 review → `mq add 89` when SHIP. b9 queues #98/#96 itself.
- 2026-10-15 ~08:30: #93 merged (queue batch #100). #84 queued (188d76e5), #81 queued (0f80ac23), #79 gating after IF NOT EXISTS migration fix (1f289ceb), #82 ejected (lease fixture needs signing OTP — w3 fixing), #83/#86 resolved & queued, #91 stacked on #83, #89 round-4 (RETURNED-after-PAID, webhook replay).
- W0b follow-ups (from #83 final review): health detail gate should require totpVerified + active operator (not just JWT role); add to ARCHITECTURE.md RLS checklist the 9 tenantId tables main added without tenant-scope/RLS: MaintenanceFund, MaintenanceFundMovement, MaintenanceClaim, AssetMeterReading, LeaseEndOfTerm, LeaseDamageItem, LeaseExpiryNotice, LeaseTerminationQuote, WebhookOutboxFailure (+ ScreeningBlock, ApiRequestLog).
- Other follow-ups: statement-export/insights routes → isCrossOriginRequest; #79 receipt-link method/reference check + SUSPENDED time separation; #89 actor-id FKs; payment-failure copy reviewed; npm audit (1 critical next, 21 high); demo/Fairscore need ENV_CREDENTIALS_TENANT_SLUG + i18n review re-ack; staff who enrolled TOTP before #92 should re-enrol.
- 2026-10-15 10:45: MERGED via queue: #81 #82 #84 #79 #83 #91 #86 (plus earlier #78 #87 #92 #93). Only #89 left — w6 resolving #86 i18n conflicts in 3 portal pages from 3422e40f. Minor follow-up: PortalUnavailable (#82) renders outside the i18n provider → English only.
- 2026-10-15 13:11 SAST: #89 MERGED. All Quinn-parity workstreams (W0–W8, W1, CSRF #93, TOTP QR #92, IT guard #87) are on main. Next: W0b RLS activation (notes in 2026-10-15-quinn-parity-w0b-notes.md), conflict-free registries goal (2026-10-15-conflict-free-registries-goal.md), follow-ups listed above, go-live gates (contracts, legal sign-off, VPS, prod deploy approval).
