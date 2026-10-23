# Slice 5 part C browser results

Round 1 (head 5e251bdb) found defects; rounds 2–3 rechecked the fixes. Final verdict PASS at head 75968e08 (round 3). Screenshots: `round1/`, `round3/`.

## Round 1


Independent run. Fresh clone `/tmp/cf-brC-LOte` at 5e251bdb (now deleted), `npm ci --legacy-peer-deps`, `prisma generate`.
Own DB `cf-it-brC-17606` (it-db.sh up/check, `migrate deploy`, seed `valuation-browser-seed.test.ts` green, now removed).
`next dev` on port 3470 (own PID, killed). Chrome DevTools MCP, one isolated browser context per user.
Screenshots: `round1/`.

## State set by SQL or outside the UI (disclosed)

1. To test the dealer case: `UPDATE "TenantConfig" SET "featureDealerPortal"=true, "isDemoLender"=true` on the seed tenant. Inserted a synthetic `Dealer` (`brc_dealer1`) and a `DealerUser` DEALER_ADMIN (`dealer-admin-brc@staff.invalid`, bcrypt of the seed password). Restarted dev with `DEALER_APP_HOST=localhost` and `TENANT_HOST_MAP=localhost=<slug>,127.0.0.1=<slug>`. Next dev blocks dev assets from 127.0.0.1, so the dealer host is `localhost` and the staff host for the replay is `127.0.0.1` (curl).
2. To try to edit a published guide, ran a direct SQL `UPDATE` on `ValuationGuideRow` and `ValuationGuide`. Both were rejected by triggers, so no state changed.
3. The "Effective from" date input was set with a JS value setter, because the DevTools fill did not populate the native date control. That is a tooling limit, not a defect. The server's own error for an empty date showed correctly: "must be a calendar date YYYY-MM-DD".
4. API probes used `fetch` from the signed-in page (same origin, real session cookie). The dealer cookie replay used curl.

## Steps

| # | Step | Result | What I saw | Screenshot |
|---|---|---|---|---|
| 1 | Admin A uploads `browser-guide-malformed.csv` | PASS | "The guide was refused · 5 line(s) refused. Nothing was stored." Line 2: trade_cents must be whole cents. Line 4: duplicates line 3. Line 5: model required; trade above retail. Line 6: formula (=). Line 7: expected 6 columns, found 7. The list stayed empty. | 01-malformed-refused.png |
| 2 | Admin A uploads valid CSV as "TEST Plant Guide", effective 2026-10-01 | PASS | Draft, 5 rows, sha256 shown. Admin A sees Discard and "You loaded this; another guide manager publishes it.", with no Publish button on either the list or the detail page. | 02-, 03- |
| 3 | Admin A direct `POST …/publish` | PASS | 403 `{"error":"A guide is published by someone other than the person who loaded it"}`. Audited as VALUATION_GUIDE_PUBLISH_REFUSED (four_eyes_self_publish). | (API) |
| 4 | Admin B opens the guide, checks rows, publishes | PASS | All 5 rows shown with values incl. VAT. Publish took it to CURRENT. | 04-published-current.png |
| 5 | Published guide cannot be edited | PASS | API: discard 409 "already PUBLISHED", re-publish 409, PATCH/PUT/DELETE on `/valuation-guides/:id` 404 (no such route). No edit control in the UI. SQL UPDATE on a row raised "A guide row is never changed or deleted: load a new guide". SQL UPDATE of the name raised "…not PUBLISHED to PUBLISHED". | 04- |
| 6 | Credit officer records the EX-1 (no variant) guide value on the deal | PASS | Trade R1,200,000.00, retail R1,400,000.00, goods advance R1,552,500.00, LTV 129.38% trade and 110.89% retail. Recording with nothing chosen gave "Choose the guide row that matches the asset's variant". | 05-deal-guide-ltv.png |
| 7 | Asset page guide panel (lease asset EX-2) | PASS | Recorded R1,100,000 trade and R1,300,000 retail, and the Valuations table shows a "Guide value" row. The manual valuation form offers only Dealer, Auctioneer, Assessor and Internal (no GUIDE). | 06-asset-guide-panel.png |
| 8 | Lease purchase election on the guide valuation | PASS (with defect D1) | Refused: "A purchase rests on an assessor's or a dealer's valuation". HTTP 409, audited LEASE_ACTION_REFUSED (valuation_source). | 07-lease-purchase-guide-refused.png |
| 9 | Book revaluation | PASS | LN-…-WAKO, operating lease, 2025 TEST EX-2, outstanding R606,113.28, TEST Plant Guide 01 Oct 2026, trade R1,100,000, retail R1,300,000, change R0.00, LTV "—" (a lease). | 08-book-revaluation.png |
| 10 | Recovery reference line | PASS | Recorded a non-NCA voluntary recovery on the lease through the UI. The panel shows Valuation "Not valued" and "Guide reference (not an independent valuation): R 1,100,000.00 trade, R 1,300,000.00 retail · TEST Plant Guide, effective 01 Oct 2026, read 21 Oct 2026". The recovery valuation source offers no GUIDE. | 09-recovery-guide-reference.png |
| 11 | CREDIT_OFFICER cannot upload or publish | PASS | Upload API 403 "needs the manage_valuation_guides permission". Publish API 403. | (API) |
| 12 | READONLY: pages visible, no controls; API refused | PASS | Guide list, detail, deal, asset, loan/recovery and revaluation all 200 with zero buttons and zero selects in `main`. API: upload 403, publish 403, discard 403, record guide value 403, GET list 200. | 10-, 11- |
| 13 | Dealer user cannot reach upload or publish | PASS | On the dealer host, with a dealer session: every guide API (GET/POST list, publish, discard, guide-valuations) is 404, and the guide pages are 404. The same dealer session cookie replayed on the staff host: all guide APIs 403, the guide page 404. | 15-dealer-guides-404.png |
| 14 | 390px mobile: list, detail, revaluation | PASS (with note D3) | `scrollWidth == innerWidth == 390` on all three pages, so no page-level horizontal scroll. The forms stack. Tables scroll inside their own `overflow-x:auto` container (revaluation: 332px visible of 1094px). | 12-, 13-, 14- |
| 15 | Console free of page errors | PASS | No uncaught exceptions and no hydration errors. The only console errors are network-status lines for my own deliberate refused probes (403/404/409). Also seen: a font/CSS preload warning and an autocomplete "issue". Server log: CredentialsSignin at the password step of the two-step TOTP login (expected), and one "destination stream errored" during a navigation abort. | — |
| 16 | AuditLog rows | PASS | VALUATION_GUIDE_UPLOAD_REFUSED (lines [2,4,5,6,7], 422, admin-a), VALUATION_GUIDE_UPLOADED (5 rows, sha256, csv, admin-a), VALUATION_GUIDE_PUBLISH_REFUSED (four_eyes_self_publish, 403, admin-a), VALUATION_GUIDE_PUBLISHED (admin-b), ASSET_GUIDE_VALUATION_RECORDED ×2 (officer, with guideId/rowId/tradeCents), LEASE_ACTION_REFUSED (end_of_term_elect, valuation_source, 409), ASSET_RECOVERY_CREATED. | (SQL) |

## Defects

- **D1 (Low, UX), End of term purchase form** (`/loans/:id` lease, "Valuation" select): the purchase dropdown offers the GUIDE valuation ("21 Oct 2026 · TEST Plant Guide (guide effective …)") as a choice, and the server refuses it only on submit. The rule holds, but the form invites a choice that can never succeed. The recovery and manual valuation forms already exclude GUIDE, so this one is inconsistent with them. Suggest filtering GUIDE sources out of the purchase select. Evidence: 07-lease-purchase-guide-refused.png.
- **D2 (Info), audit coverage of permission refusals:** a 403 for a missing permission (CREDIT_OFFICER or READONLY upload/publish/discard/record) and a 409 for discarding or re-publishing a PUBLISHED guide write no AuditLog row. Only the four-eyes self-publish refusal and the malformed upload are audited. This may match the repo's guard convention. Flagged for the lead to decide; not a blocker.
- **D3 (Info), mobile:** at 390px the guide list's Status column and the revaluation table's Trade, Retail, Change and LTV columns start off-screen. They are reachable by scrolling inside the table, but nothing on screen shows the table scrolls. No page overflow.
- **D4 (Info):** with a single matching guide row, the "Guide row (variant)" select preselects it (no "Choose…" placeholder), so one click records it. That is acceptable for a single match.

No High or Medium defects.

Verdict: PASS

## Round 3

6/6 PASS, with screenshots in `round3/`.
- Oversized upload: a whole-upload 422, audited upload_too_large.
- Smoke upload and second-admin publish (CSV and synthetic).
- The "simulated" tag on the record choices, plus the SIMULATED GUIDE pill.
- The deal panel LTV: 129.38% / 110.89%.
- The revaluation "Outstanding" column, both rows:
  - lease row: remaining rentals incl. VAT;
  - instalment rows: principal, LTV 0.23%.
No new defects. Round-2 D1–D3 fixed.
Disclosed: ran a temp copy of nca-browser-seed into the throwaway DB (2nd tenant with instalment sales); the date input was set by a JS setter.
