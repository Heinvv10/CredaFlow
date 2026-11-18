# LPB/0009/2026 Section 6 compliance: notes

## Rescore on final main (2026-11-02)

Rescored by reading the code on final main (all LPB PRs merged, #289 last). Line data: `compliance-summary.json` (104 lines,
each with `previousStatus` from 0da7d4b6 and a dated `roadmap` on every Partial). The 0da7d4b6 file is kept as
`compliance-summary-0da7d4b6.json`.

| Status | 0da7d4b6 | Final main |
|---|---|---|
| Comply | 10 | 20 |
| Partial | 58 | 51 |
| Fail | 36 | 33 |

Changed: 2.1.1 Fail to Partial; 2.3.9 and 2.6.6 Fail to Partial/Comply; 2.1.4, 2.2.4, 2.3.5, 2.4.1 to 2.4.4, 2.5.3, 2.6.2 Partial to Comply.
Not upgraded although a PR claimed it: 2.1.3 (no DB guard on LoanProduct, insurance products outside the control), 2.6.1
(no rate-change notice), 2.7.4 (letter not strategy-driven), 4.5 (settings still single-person).

**T1 to T6 all still Fail.** The Fail lines are the same as the "with PRs" column below; every remaining one needs Fair Score,
the Bank, spend, or work that does not exist yet.

### Fixed points to state in column (c)

- **A5b product types (2.1.1):** salary-backed/check-off, SME, group and revolving are each Partial (see the line). Mortgage is
  out of scope and is declared as a deviation.
- **Arrears bands (2.7.1):** ours are 1-30/31-60/61-89/90+ so PAR90 and NPL agree at day 90 (`lib/reports/arrears-buckets.ts`).
  The tender default is 61-90/>90. Configurable bands with the tender default are on the roadmap for 13 Nov.
- **2.6.11:** `deploy/README.md` says "A restart can skip a daily job". That contradicts "automatic restart and recovery" and
  the same document goes in the bid. The fix (batch control with catch-up) and the README rewrite ship together; until then
  the line is Partial and the README must not be attached as evidence.
- **All Lesotho documents are SAMPLE:** key facts, offer letter, agreement, arrears letter. The Bank's legal team supplies wording.

### F-items

| Item | Result |
|---|---|
| F1, F2 | Merged #259 |
| F3 currency formatter sweep | Merged #290. About 15 form labels still say "(R)" (found in the 2 Nov walk); follow-up |
| F7 instant approval (2.3.9) | Merged #291; Partial until a Lesotho bureau exists |
| F8 to F12 approval and account control | Merged #292 |
| F13 backdateLease | Merged #290 |
| F14 seed month-end dates | No change needed (#290): `prisma/seed/` already uses `addMonthsClamped` and prepares with start = today |
| F15 recovery-rules VAT refund deadlock | Merged #290 |
| PASQ ceremony IT flake | Merged #290 |
| #257 notes (non-object newValue has no `_clipped`; forgeable clip marker; redaction length visible) | Deferred: not small (#290 notes); post-award |
| SIEM same-millisecond tie | Merged #293 |

### Residual risks (accepted, state in the bid where relevant)

- Two JIT accounts through one SSO connection count as two people.
- An owner-level DB write can DELETE and re-INSERT decision-engine config.
- A ZA borrower whose address staff corrected needs a second staff confirmation before recovery.
- F10's reading of the signed date needs the lender's legal view.
- Key-facts payout needs three people with segregation on; lender onboarding must provision two people
  (`lender:bootstrap-admin --second`), but the operator console still creates one.
- The top-up/refinance signed-paper route needs legal sign-off.
- The borrower is not sent a rate-change notice (needs wording).
- The key facts statement gate before submission is in application code, not a DB floor.

---

## Earlier scoring at 0da7d4b6 (kept for the record)

Scored 2026-11-02 against origin/main 0da7d4b6. Line data: `compliance-summary.json` (104 lines).

**Today the bid fails all six criteria.** Merging the five open PRs changes T1 scores but no T result.

| Status | On main | If all five PRs merge |
|---|---|---|
| Comply | 10 | 21 |
| Partial | 58 | 50 |
| Fail | 36 | 33 |

**Basis.** Main scores come from reading code, schema and module rules, not from running a demo. Pending scores come from PR descriptions, plus one read of #280's module rules; the PR diffs were not reviewed and the PRs have no blind-review verdict here. #280 is CONFLICTING against main. Treat every pending Comply as provisional until the PR is merged and walked in a browser. Tender scoring has no "Partial". A Partial survives only if the evaluator rates it a minor deviation, so 58 Partials are themselves a real risk, and column (c) must state each one.

## T1 to T6

| Criterion | Lines | Result now | Result with PRs | Lines still Fail with PRs |
|---|---|---|---|---|
| T1 General and functional | 1.1 to 2.9.6 (61) | Fail | Fail | 1.2, 2.2.2, 2.3.8, 2.5.1, 2.6.3, 2.7.2, 2.7.3, 2.7.6, 2.9.3, 2.9.4, 2.9.5, 2.9.6 |
| T2 Integration | 3.1 to 3.8 (8) | Fail | Fail | 3.2, 3.3, 3.4, 3.5, 3.7 |
| T3 Security, tokenization, PCI | 4.1 to 4.10 (10) | Fail | Fail | 4.1, 4.2, 4.3, 4.4, 4.8, 4.9 |
| T4 Architecture, performance, continuity | 5.1 to 5.16 (16) | Fail | Fail | 5.2, 5.4, 5.11, 5.12, 5.14 |
| T5 Implementation and support | 6.1 to 6.6 (6) | Fail | Fail | 6.1, 6.2, 6.5 |
| T6 Experience and personnel | 7.1 to 7.3 (3) | Fail | Fail | 7.1, 7.3 |

Overall: **Fail**. One Fail on any criterion ends the bid before price is opened.

## Likely-Fail lines, most fatal first

Fatal means no engineering in the time left can fix it alone, or the tender makes it automatic.

| # | Lines | Why it is fatal | Cheapest fix | Owner | By (my estimate) |
|---|---|---|---|---|---|
| 1 | 1.2 | Offered version must be live at a regulated institution on 25 Nov. CredaFlow has no lender. No build fixes this. | Fair Score's live LMS client, if there is one. Otherwise ask Q7 and accept the answer. If both fail, this bid is not winnable as CredaFlow. | Fair Score | 5 Nov; Q by 12 Nov |
| 2 | 7.1 | Needs 3 implementations and 1 core banking integration. We have at most 1, and it has none. | Fair Score's reference letters; Q6 to combine across JV members. | Fair Score | 5 Nov |
| 3 | 4.1 | PCI has no equivalent and a deviation is an automatic Fail. | Commit to on-prem, no PAN in scope. Engage a QSA now for a reviewed responsibility matrix (route b). Ask Q16. Costs money, needs Hein. | QSA | Engage this week |
| 4 | 4.2, 4.3, 2.9.4 | Automatic Fail. ID and account numbers are plain columns, used across PDFs, matching and search. | Buy a vault (Vault Transform or equivalent) and tokenize `idNumber` and `bankAccountNumber` at the data layer, with logged detokenization. No PAN field exists, so state that. Largest engineering item in the bid. | CredaFlow | Start now |
| 5 | 4.4 | Automatic Fail. Keys are env variables and no HSM or KMS code exists. | Key provider interface backed by a KMS or Vault; Bank supplies the HSM on-prem (Q11). Database encryption at volume level, documented, or pgcrypto for the tokenized fields. Hooks into item 4. | CredaFlow, Bank | With item 4 |
| 6 | 3.2, 2.2.2, 2.5.1, 2.6.3, 2.7.6 | Automatic Fail, and all depend on a core system we do not know. | Generic core banking adapter (customer lookup, disburse, debit, GL post) against a mock server, published as an OpenAPI contract, so a demo shows real-time flows. Cannot be finished without the Bank's specification; answer depends on Q12. Add a real screening provider for 2.2.2. | CredaFlow, Bank | Mock in 2 weeks |
| 7 | 5.4, 3.3 | Automatic Fail. 10 of 582 routes are documented and versioned. | Publish the channel API that 3.3 names (eligibility, statements, repayment, status) under `/api/v1`. "Every system function" stays out of reach; state the deviation. Rated risk: still Fail if read strictly. | CredaFlow | 2 weeks |
| 8 | 5.2 | Modular monolith against a stated architecture. Not on the automatic list, but it is not minor. | Q9. Only Bank acceptance in writing clears it. A split cannot ship by 25 Nov. | Bank | Q by 12 Nov |
| 9 | 2.9.5, 2.9.6 | Whole capabilities missing. T1 names low-code explicitly. | Q20. Then a graphical editor over the existing matrix and rule forms is the minimum; process flows stay hard-coded, so expect Partial at best. | CredaFlow | Q by 12 Nov |
| 10 | 3.5, 3.4, 3.7 | Automatic Fail on the REST rule. | Mobile money and payroll adapters against sandboxes, ERP adapter through the mock, integration reconciliation report. Depends on Q12 and Q14. | CredaFlow, third party | After Q answers |
| 11 | 5.14, 5.11, 5.12 | T4 demands a DR design and a benchmark; neither exists. | Patroni or managed Postgres with WAL archiving design, one failover test with timings. k6 run on a seeded 500k-loan database; fix what it finds. About 3 days, and it may uncover real work. | CredaFlow | 10 Nov |
| 12 | 4.8 | T3 requires a pen test summary under 12 months old. | Commission one on the offered version now, or get Q17 to allow it after award. Costs money, needs Hein. | Third party | Book this week |
| 13 | 4.9, 7.3, 6.5 | Documents and people we do not hold. | Fair Score's certificate and scope (Q5); signed CVs; a staffed 24/7 rota behind an SLA. | Fair Score | 5 Nov |
| 14 | 2.7.2, 2.7.3, 2.3.8, 2.9.3 | Functional gaps, each named in the spec. | Collections strategy rules and queues on the existing collections module; early-warning report on missed receipts; SME spreading form and report; memo drafts from templates (AI wording needs a Hein decision, since the statement AI rule bans model prose). About 2 to 4 days each. | CredaFlow | Before 20 Nov |
| 15 | 6.1, 6.2 | Documents, plus a loan import tool. | Write plan and migration method; build import with balance reconciliation report after Q23. | Fair Score, CredaFlow | 15 Nov |

## Findings the coordinator should act on

- **Demo blocker on main:** `#289` and `#292` each report that the application page crashes with a matrix or approval case present. Main has it. Do not demo 2.4.1 or 2.4.2 before those merge.
- **`#280` conflicts with main** and says booking through the disburse route is unproven, so 2.6.1 stays Partial after it.
- **Rate changes and 2.6.9:** neither `#280` nor `#281` notifies the borrower. A repricing demo will show that gap.
- **Risk-grade pricing and matrix rules** work on LS only with a bureau check, which means the simulated bureau after `#291`. A real LS deployment has neither until the Bank names a bureau.
- **Arrears bands** are 61-89 and 90+; the tender default is 61-90 and over 90. Small, and an evaluator will spot it.
- **2.6.11:** `deploy/README.md` states that a restart can skip a daily job. That contradicts the line, and the same document would go in the bid as evidence.
- **All Lesotho documents are SAMPLE.** State that in column (c). The Bank's legal team supplies wording.

## Recommendation

Get a straight answer on items 1 and 2 from Fair Score before spending on PCI, the vault or a pen test. Those two decide whether the bid can pass at all, and items 3, 4, 5 and 12 are the most expensive work on the list. The email draft already asks for them by 5 Nov, but it has not been sent and should go now rather than after the build.
