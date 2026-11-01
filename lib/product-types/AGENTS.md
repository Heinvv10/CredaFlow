<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: product-types
<!-- summary: what the salary-backed, SME, group and revolving product types require at approval, and what each deliberately does not do yet -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Spec 2.1.1 asks for these types. Each ships its smallest real behaviour: a gate at approval
(`productTypeRefusal`, called by decide and by the locked re-check) and what staff need to satisfy it.

## Critical Rules
- **Non-NCA only** (`NON_NCA_PRODUCT_TYPES`): refused when proposing a product and again at approval. Their documents and credit-type
  classification have no legal sign-off. `productTypeRefusal` returns before any read for every other type, so ZA approvals do not change.
- **Staff originated**: `CUSTOMER_PRODUCT_WHERE` leaves them out; only staff capture the facts.
- **Facts follow the pricing inputs** (`/api/applications/[id]/product-facts`): open applications only, under the row lock, audited,
  the setter joins `inputStaffIds` and may not approve.
- **Never a label with nothing behind it.** A new behaviour goes in the table below, or the type is refused.

## What each does, and does not
| Type | Does | Does not |
|---|---|---|
| SALARY_BACKED | needs employer + payroll number and an employed borrower; monthly deduction list and CSV (`check-off.ts`) | import or match payroll files (2.6.3), employer portal (2.2.1), remit bulk receipts |
| SME | needs business name, registration, turnover and a business purpose | lend to the business itself: the applicant is the borrower of record |
| GROUP | needs a group of 2+ with the borrower in it, nobody in arrears | joint liability, group collection, group meetings |
| REVOLVING | the product maximum is the borrower's limit; owed principal counts, repaid principal frees it | a per-borrower limit, draws without an application, one statement, interest on a running balance |

## Tests
`rules.test.ts`, `check-off.test.ts`; `lib/product-engine/a5b.integration.test.ts` (`RUN_A5B_IT=1`); `decide-gate.integration.test.ts` (`RUN_APPROVAL_IT=1`).
