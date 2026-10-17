# Independent B review of A Wave B

Reviewed `314a9321ef7a2c3eeb3e304fb8caa318d0e1080b` plus correction `34040560b57be186b5d74163ca6b6f928e6cc2eb`.
Verdict: approve corrected submission for integration, conditional on integrated automated and browser acceptance.

- Root's substantive finding was valid: the initial commit described a next scheduled payment as the aggregate account amount. Correction removes that sentence from PaymentHero and adds a fail-first regression scoped to the rendered hero's R1,000 payment. Reviewed the correction and inspected other new descriptions against their actual values.
- F06: native details/summary exposes the same feature-aware navigation, including optional business links, as desktop. Sign-out uses the portal return path. Menu closes on navigation; Escape restores summary focus. Scroll-height constraint and placement are appropriate to inspect at mobile sizes. No authorization changed.
- F07: main had already corrected the payment reference surface. New tests use actual palette resolution for light/dark and three tenant primaries, rather than claiming a new runtime fix. Real browser readability remains required.
- F12: original portalOutstanding calculations remain unchanged. New detail fields separate outstanding principal, overdue instalments plus live charges, and unpaid scheduled contractual total. Calculated dated settlement is shown only for the shared isS125Priced population; asset and NON_NCA contracts request a lender quote and do not assert an early-settlement calculation. Inspected shared settlement/charges semantics and statement terminology.

Ran in A's worktree after confirming reviewed runtime paths had no uncommitted differences: `npx vitest run 'app/(portal)/portal/page.test.tsx' 'app/(portal)/portal/loans/[id]/page.test.tsx' 'app/(portal)/portal/payment/page.test.tsx' components/app-shell/PortalSidebar.mobile.test.tsx --maxWorkers=2`: 4 files / 34 tests PASS on Node22.23.1.

Remaining limitations: native mobile touch/keyboard and actual sign-out need browser proof; translations' new terms remain English in machine-draft non-English catalogs, so native-language acceptance stays open. No real provider/settlement operation is certified by these tests.
