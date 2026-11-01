<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: non-nca-documents
<!-- summary: Offer letter, key facts statement, loan agreement and arrears letter of a non-NCA (Lesotho) loan: templates, issue, accept, sign, the DB gate -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
An application of a jurisdiction without the NCA is governed by an **offer letter, a key facts statement and a loan
agreement** from the lender's own versioned templates, not by the PASQ. `LoanApplication.disclosureRegime` (`NCA_PASQ` |
`KEY_FACTS`) says which; a trigger stamps it at insert from the instance and it never changes. Tender items
2.2.4 and 2.4.3. Setting up a lender and the go-live conditions: `docs/non-nca-go-live.md`.

## Critical Rules
- **Never invent Lesotho legal wording.** The templates (`keys.ts`, CUSTOM `DocumentTemplate`s) are the bank's
  legal team's. The demo ones (`prisma/seed/non-nca-templates.ts`) are structure and approved figures only; a demo
  lender's documents open with the SAMPLE banner (`render.ts`, `LoanDocumentIssuance.sample`, derived in the DB).
- **The ZA path is untouched.** The four PASQ guards, the commit invariant and the approved-status CHECK each gained one `KEY_FACTS` step-aside (`migration.test.ts` diffs them). NCA PDFs are not touched.
- **The gate is in the database** (`guardLoanApplicationKeyFactsDocuments`): the borrower's signature needs all three
  documents standing, from the template's CURRENT approved version with their issued wording hash, the offer accepted and
  the key facts statement acknowledged on their exact bytes, the agreement signed the issued one, the approved terms
  unchanged. DISBURSED needs a signed agreement and the same wording. `state.ts documentProblem` calls the same SQL.
- **Issued on approval** (`issue-on-approval.ts`); the approval stands if a template is unpublished. `deliver.ts` tells the borrower (a demo `.invalid` mailbox is simulated).
- **Section 129 is unreachable here**: code refuses by jurisdiction, the database by regime (`guardSection129KeyFacts`). The loan has `arrears-letter.ts` (immutable, one a day, dunning holds).
- **At a branch only the borrower's own code carries the act** (`branch-sign.ts`): required whatever the exemption; staff are the witness (`assistedBy`), with no path through accept or sign.
- **Before an application** (`pre-submission.ts`, 2.2.4): an INDICATIVE statement for the exact terms, claimed by the portal's submission. The staff-captured path has no such step.
- Figures come from `quote.ts` (the frozen approval), never the product row; `loanApplicationTermsSha256` is SQL on both sides.
- Issuance rows are immutable but for supersession and one acknowledgement; `guardLoanDocumentFile` keeps their files. The keyed templates need an approver other than the author and cannot be re-keyed or deleted (`guardLoanDocumentTemplate`).
- **Approval evidence by regime** (`regime-evidence.ts`, the one rule): a KEY_FACTS application is not asked for the
  credit-life election, the affordability declaration, the s81 assessment or a South African bureau check, and none
  is stamped on it. KYC, the submission snapshot, the affordability gate, credit checks, the matrix and the lender's own
  deceased record (`Client.deceasedAt`, also in both locked verifiers, no override) apply to both. Reg 23A is NCA-only (`snapshot.ts`).
- **Credit life is off for a KEY_FACTS loan, outright**: billed under South African regulations. Every offer read goes through
  `loadCreditLifeOffer` (`lib/insurance/credit-life-offer.ts`) and `creditLifeOfferedFor`, on one basis: the application's
  stamped regime, or for one not created yet the regime it will get, never the jurisdiction alone (an `NCA_PASQ` application
  pre-dating a switch keeps its offer). Priced with `KEY_FACTS_CREDIT_LIFE`; ACCEPTED is refused by decide and by the
  CHECK `LoanApplication_key_facts_no_credit_life`. Offering cover later is a feature (a Lesotho product), not a switch.
- **Screening is the identity-risk check a KEY_FACTS loan has**: decide and readiness refuse while no provider is
  configured, also inside the transaction. The simulated provider counts where `SIMULATED_INTEGRATIONS` permits it.
- **The decision engine cannot approve a KEY_FACTS application** until a Lesotho bureau is integrated
  (`lib/decisioning/key-facts-referral.ts`): it refers (`NO_BUREAU`, `MISSING_FACT`) and strips the grade, which was scored on
  facts nobody checked. With no bureau check a scorecard decline refers too; a rule's decline on known facts stands.
- Staff issue (`CREDIT_OFFICER`); only the borrower accepts and signs (`lib/proxy/shared-client-api.ts`). PASQ routes answer 409 (`refusal.ts`).
  Each step refuses a deceased borrower under the client row lock (`borrower-gate.ts`); the portal's refusal does not say why.
- **Disbursing** (`disburse.ts`, `payout-gates.ts`): every gate in one SERIALIZABLE transaction on the NCA route's lock protocol; a dry run for the page. No debit mandate: EFT. Rules: `docs/non-nca-go-live.md`.

## Key Files
| File | Purpose |
|------|---------|
| `render.ts` / `quote.ts` | Template + approved terms -> PDF bytes; the quote.* tokens |
| `issue.ts` / `acknowledge.ts` / `sign.ts` / `branch-sign.ts` | The actions (audited) |
| `arrears-letter.ts` / `deliver.ts` / `pre-submission.ts` | The arrears letter; telling the borrower; the indicative statement |
| `state.ts` / `refusal.ts` | What stands and why a signature would fail; the 409s |
| `payout-gates.ts` / `disburse.ts` / `payout-account.ts` | Every payout gate; booking; the second person |
