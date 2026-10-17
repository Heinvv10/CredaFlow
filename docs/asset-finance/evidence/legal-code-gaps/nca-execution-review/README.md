# NCA surplus execution review evidence

The law review found that an issued instruction was incorrectly treated as payment.
The real-Postgres test first reproduced CLOSED instead of SURPLUS_HELD; the fix keeps
the surplus outstanding until an already executed bank payment has retained proof.
No bank transfer is initiated by the application.

The two added DRAFT asset notice samples explicitly state that the instruction is
issued and payment remains outstanding until bank execution is evidenced. Existing
six NCA sample bytes and consumer PDF pins are unchanged.

| Sample | SHA-256 |
| --- | --- |
| s127-final-notice-surplus-instructed.pdf | `2139e476ea1248ab04d0ac9c6890a30050205a54b51dcf6d8894c7c58f6f58f0` |
| s131-final-notice-surplus-instructed.pdf | `4c121bb770a7e814c06c5cda6d3b5e2f828e7d41a49749fa6ad28d3299997d75` |

Reproduce with `npx tsx scripts/asset-finance/render-legal-wording-nca-samples.ts`
and `pdftotext -layout` on the surplus-instructed PDFs.

Verification: `nca-surplus.integration.test.ts` now proves pending status, direct
closure refusal (and mutation control), exact amount, bank execution, closure,
once-only proof/audit, no additional Payment, cross-tenant refusal, actor tenant FK,
future date, wrong borrower evidence and retained proof. Existing independent
adversarial tests and surrender/recovery regressions remain green.

The older browser final-notice PDF in the parent evidence folder predates this
wording correction. It is historical until the final acceptance run replaces the
fixture and captures the candidate notice and manual evidence flow.

The follow-up s131 regression starts with a court attachment and real final-outcome
transition to SURPLUS_HELD. Execution now accepts that issued final notice,
closes the recovery and refuses a second proof/payment. An insert cannot use the
held-state exception. A nullable unique tenant bank transaction reference,
trimmed and case-normalised, also prevents one bank payment clearing two
instructions even with separately uploaded confirmation files. Removing its
unique index admits the exact duplicate-reference attack in the PG test.

Document settlement certification now uses the same expanded s125 predicate:
NCA instalment sales and finance leases with multiple instalments are marked
s125-priced. A single DAILY_ACCRUAL bullet remains eligible only for consumer
LOAN contracts. The targeted test failed before this helper correction.
