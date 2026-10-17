# Implementer A Wave C: F08 truthful PO assessment

Base: `34040560`; branch/worktree unchanged. Scope deliberately preserves underwriting and approval enforcement.

Current reproduction: both PO card and order-details intake say the buyer repays it and it is not sized on salary. Current staff affordability still assesses the full scheduled repayment against borrower disposable income. Current card already shows only the configured product range (no salary-based PO maximum); the unused qualification helper still computes an interest-only proxy but it is not a supported approval model.

Change: replace false promise on both surfaces through their existing shared catalogue key: income, expenses and existing debts are assessed, including full repayment; amount range is not an approval or guarantee of buyer repayment. Keep these credit-assessment explanations English across the four catalogues. Preserve order/buyer/document intake, consent wording, product bounds, qualification algorithm and server enforcement. Remove unused PO proxy values from card data and correct its misleading implementation comment. Staff panel accepts optional labels/notes without changing calculation: single PO schedule is called Single scheduled repayment and explains the full-payment affordability basis. Other products retain Proposed Instalment.

Fail-first: both rendered PO card and intake tests failed against original copy for missing income/debt/full repayment disclosure. Updated source passes. Assessment presentation tests cover R1,000 affordable and R10,450 not affordable against R4,000 disposable income, preserving actual preview result; no bypass introduced. Existing qualification and affordability suites unchanged.

Verification: targeted seven suites /239 tests PASS (portal PO card/intake, staff affordability, full catalogue, affordability preview, qualification, asset routing). ci:quick PASS: app/demo typechecks, full lint, docs/mirror/date gates and four timezone runs. No database/migration/PDF/mandated wording changes. No provider or external-message actions.

Policy boundary: implementing a buyer/cash-flow underwriting model remains a separate lender policy/product decision. This candidate offers only existing borrower-affordability assessment and truthful presentation; it does not promise that a R10,000 purchase order is affordable to a borrower with R2,470.46 NDI. It does not establish that currently configured PO prices pass the separate interest-cap gate.

Browser acceptance: PO card range and actual intake must show full borrower assessment, retain purchase-order facts/upload and no buyer-only guarantee. Submit eligible synthetic PO case, inspect staff full-payment label and same actual affordability result. Lower-income case continues blocked as unaffordable, sufficiently high-income case may proceed only after ordinary pricing/evidence checks. No actual external send/disbursement. Rollback: revert submission, no DB rollback.
