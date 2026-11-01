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
  rail blockers, the staff page, the start-review bureau enquiry all read the one rule). It is priced
  with no credit life (`KEY_FACTS_CREDIT_LIFE`; an ACCEPTED election is refused; `creditLifeOfferedFor`
  is false outside the NCA's jurisdiction). KYC, the submission snapshot, the affordability gate,
  screening, credit checks and the approval matrix apply to both. The Reg 23A minimum-living-expense
  rule still applies to both (a South African table: revisit with the bank).
- Staff issue (`CREDIT_OFFICER`); only the borrower acknowledges and signs
  (`proxy` allowlist `lib/proxy/shared-client-api.ts`). Signing OTP as the PASQ flow.
- The PASQ/agreement/disburse routes answer 409 for a key-facts application
  (`refusal.ts`). **Disbursing a key-facts loan is not built yet** (A10b PR B): the
  disburse route returns the gate's reason or "payout not available".

## Key Files
| File | Purpose |
|------|---------|
| `render.ts` / `quote.ts` | Template + approved terms -> PDF bytes; the quote.* tokens |
| `issue.ts` / `acknowledge.ts` / `sign.ts` | The three actions (audited) |
| `state.ts` / `refusal.ts` | What stands and why a signature would fail; the 409s |
