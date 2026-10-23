# Part W browser acceptance: results (2026-10-22, head after review round 3)

Local dev server against a throwaway PostgreSQL 16 migrated to the branch
head (Part T included), seeded with `commission-browser-seed.test.ts`;
synthetic data, demo-flagged lender. Signed in as a LOAN_ADMIN (password, then
TOTP).

| # | Check | Result |
|---|---|---|
| 01 | `isaDealer` (commercial instalment sale, introduced by "SYNTHETIC Highveld Plant Dealers (Pty) Ltd", DEALER): contract start 22 Nov 2026, Prepare documents → 200; agreement and resolution listed | Pass |
| 02 | Its agreement, page 2: section 5 ends with `Introducer  SYNTHETIC Highveld Plant Dealers (Pty) Ltd (dealer)`, then "Introducer's commission. The Seller may pay a commission to the introducer named above, …"; section 6 and 7.1 numbering unchanged | Pass |
| 03 | `isaPlain` (same shape, no dealer): agreement has no Introducer row and no paragraph (0 matches for "introducer"/"commission"). All rand figures of the two agreements are identical (same hash over every `R n.nn` in the text) | Pass |
| 04 | `ncaBroker` (NCA instalment sale, "SYNTHETIC Karoo Finance Brokers CC", BROKER): quotation issued (201); after the repayment schedule and before ACKNOWLEDGEMENT a section "COMMISSION TO THE INTRODUCER" with `Introducer … (broker)` and the fixed paragraph ending "not included in the total cost of credit shown above". DRAFT watermark: the lender's asset-finance wording flag is off | Pass |
| 05 | `ncaPlain` (no introducer): no such section. Total cost of credit R 2,510,491.28 on both quotations; all 73 money lines identical | Pass |
| 06 | Settings → Document templates: all 11 asset-finance variants "version 1 published"; in the database every version is ACTIVE with basis SYNTHETIC_DEMO and `approvedSystemSha256` equal to the re-pinned fingerprint (e.g. `af.isa.commercial` fd0b5e81…, `af.nca.instalment_sale` 78cc2272…): the demo re-approval took | Pass |

Page errors: none. The server log shows only the expected refusals: the first
step of the two-step sign-in (`CredentialsSignin` before the TOTP code), and
422 from Prepare documents when the contract start date gives a term longer
than the approved one (the default start date, today, before it was set) and
on the NCA deal (whose agreement waits for the quotation's acknowledgement).

Not exercised in the browser: the NCA agreement (needs the consumer to
acknowledge the quotation in the portal; the seed gives the consumer no portal
login). Its section is covered by the unit and fingerprint tests.
