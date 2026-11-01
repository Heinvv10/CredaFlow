<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: non-nca-documents
<!-- summary: Key facts statement and loan agreement of a non-NCA (Lesotho) loan: templates, issue, acknowledge, sign, the DB gate -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
An application of a jurisdiction without the NCA (`InstanceJurisdiction` not ZA)
is governed by a **key facts statement and a loan agreement** rendered from the
lender's own versioned templates, not by the PASQ. `LoanApplication.disclosureRegime`
(`NCA_PASQ` | `KEY_FACTS`) says which; a trigger stamps it at insert from the
instance and it never changes. Tender items 2.2.4 and 2.4.3.

## Critical Rules
- **Never invent Lesotho legal wording.** The two templates (keys in `keys.ts`,
  CUSTOM `DocumentTemplate`s, dual-approved versions under Settings, Documents)
  are the bank's legal team's. The demo ones (`prisma/seed/non-nca-templates.ts`)
  are structure and approved figures only; a demo lender's documents open with
  the SAMPLE banner (`render.ts`, `LoanDocumentIssuance.sample`, derived in the DB).
- **The ZA path is untouched.** The four PASQ guards, the commit invariant and the
  approved-status CHECK each gained one `KEY_FACTS` step-aside and nothing else
  (`migration.test.ts` diffs them against their previous definition). A ZA
  application is `NCA_PASQ`, still needs its PASQ; NCA PDFs are not touched.
- **The gate is in the database** (`guardLoanApplicationKeyFactsDocuments`): the
  borrower's signature needs both documents standing, from the template's
  CURRENT approved version with the wording hash they were issued with, the key
  facts statement acknowledged on its exact bytes, the agreement being signed
  the issued one, the approved terms unchanged. DISBURSED needs a signed
  agreement and the same wording (a newer version after signing does not unsign
  a contract). `state.ts documentProblem` calls the same SQL (`loanDocumentProblem`).
- Figures come from `quote.ts` (the frozen approval, the PASQ's calculator), never
  from the product row; `loanApplicationTermsSha256` is computed in SQL on both sides.
- Issuance rows are immutable but for supersession and one acknowledgement. The
  stored files cannot be deleted or swapped while one references them
  (`guardLoanDocumentFile`); the gate reads them too. The two keyed templates need
  approval by someone other than the author, whatever `requiresApproval` says, and
  cannot be re-keyed or deleted (`guardLoanDocumentTemplate`).
- **Setting up a lender** (Settings, Documents, "Loan documents"): create both
  templates, save a draft, a second admin approves it (the author cannot), anyone but
  the approver publishes it. Nothing is issued until both have a published, approved
  version. **Applications created before the instance became non-ZA stay
  `NCA_PASQ`** (the column defaults to it; set the instance jurisdiction first, it
  is frozen by the first application).
- **Approval evidence by regime** (`regime-evidence.ts`): a KEY_FACTS application is not asked for
  the credit-life election, the affordability declaration, the NCA s81 reckless-lending assessment
  or a South African bureau check (decide-application, its locked re-verification, readiness, the
  rail blockers, the staff page, the draft submit, the start-review bureau enquiry all read the one
  rule). A bureau override reason on a KEY_FACTS approval does not stamp an s81 assessment nobody made.
  KYC, the submission snapshot, the affordability gate, credit checks, the approval matrix and the
  lender's own deceased record (`Client.deceasedAt`, with no override, in both regimes) apply to both.
  The Reg 23A minimum-living-expense rule is NCA-only (`snapshot.ts`): off outside the NCA's jurisdiction.
- **Credit life is off for a KEY_FACTS loan, outright** (no configuration path): it is billed under
  South African regulations. The loan is priced with `KEY_FACTS_CREDIT_LIFE` (declined, premium zero),
  `creditLifeOfferedFor` is false outside the NCA's jurisdiction, an ACCEPTED election is refused by
  decide and by the CHECK `LoanApplication_key_facts_no_credit_life`. Offering cover later is a feature
  (a Lesotho insurer product, its premium rules, and the bullet/grace schedules), not a switch.
- **Screening is the identity-risk check a KEY_FACTS loan has**, because it has no bureau: decide refuses
  to approve while no screening provider is configured (`screeningProviderRequired`), also inside its
  transaction. The simulated provider counts where `SIMULATED_INTEGRATIONS` permits it (a demo stack).
- **The decision engine refers a KEY_FACTS application to staff** (`lib/decisioning/key-facts-referral.ts`):
  with no bureau check (`NO_BUREAU`) or when a rule compares a fact that is missing (`MISSING_FACT`).
  A rule never fires on what is not known, so without this a LIVE engine approved a person nobody assessed.
  Until a Lesotho bureau is integrated the engine cannot auto-approve a key-facts loan.
- **Go-live conditions for a Lesotho lender** (the bank accepts these or changes them): a screening
  provider is configured; the approval matrix rules for key-facts products set `ungraded: true` (a
  KEY_FACTS application has no risk grade, so `riskGradeRankMin` never matches it and the row would
  fall to the default level); debts on a key-facts application are self-declared (no bureau obligations
  to check them against), and the bank must accept that for affordability; no automated engine approval
  (above).
- Staff issue (`CREDIT_OFFICER`); only the borrower acknowledges and signs
  (`proxy` allowlist `lib/proxy/shared-client-api.ts`). Signing OTP as the PASQ flow.
- The PASQ/agreement/packet routes answer 409 for a key-facts application (`refusal.ts`).
- **Disbursing** (`disburse.ts`, called from the disburse route via `disburse-response.ts`): books
  the Loan, its RepaymentSchedule (the printed schedule, from the approval start date), the
  commission and the audit rows. Gates in order: regime/status, segregation of duties, screening,
  signed agreement + unchanged documents, composite KYC, verified payout banking (client record,
  never typed at payout; verified statement for exactly that account), first instalment not
  past, EFT repayment only (no debit-order mandate is prepared for key facts). The payout is
  **manual**: the loan is booked and audited as `payoutChannel: "MANUAL"` with the staff-entered
  bank reference; nothing moves money. **The automated rail is the tender 2.5.1 core-banking
  API adapter and is not built.** Refusals are audited by the route, not the lib.
- Statements, certificates of balance and debit mandates print the lender's registration number
  (not an NCR number) outside the NCA's jurisdiction and omit the NCA/PASA text (the mandate's
  rights clause is a SAMPLE gap for the bank's legal team).

## Key Files
| File | Purpose |
|------|---------|
| `render.ts` / `quote.ts` | Template + approved terms -> PDF bytes; the quote.* tokens |
| `issue.ts` / `acknowledge.ts` / `sign.ts` | The three actions (audited) |
| `state.ts` / `refusal.ts` | What stands and why a signature would fail; the 409s |
