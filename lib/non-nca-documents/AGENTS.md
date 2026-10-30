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
- Issuance rows are immutable but for supersession and one acknowledgement.
- Staff issue (`CREDIT_OFFICER`); only the borrower acknowledges and signs
  (`proxy` allowlist `lib/proxy/shared-client-api.ts`). Signing OTP as the PASQ flow.
- The PASQ/agreement/disburse routes answer 409 for a key-facts application
  (`refusal.ts`). **Disbursing a key-facts loan is not built**: the disburse route
  returns the gate's reason or "payout not available". Approval of an LS
  application through `decide` still demands NCA evidence (credit-life election,
  NCA checks): a separate item.

## Key Files
| File | Purpose |
|------|---------|
| `render.ts` / `quote.ts` | Template + approved terms -> PDF bytes; the quote.* tokens |
| `issue.ts` / `acknowledge.ts` / `sign.ts` | The three actions (audited) |
| `state.ts` / `refusal.ts` | What stands and why a signature would fail; the 409s |
