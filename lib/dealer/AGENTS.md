<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: dealer portal (spec: docs/asset-finance/SLICE5.md Part A)
<!-- summary: dealer principal and host gate, 404 for every miss, whitelist projection, DB-owned commission and run netting -->

## Principal and host
- **`DEALER` is not a `UserRole`.** `hasMinRole`/`canDo`/`requireApiRole` refuse it, but
  dozens of call sites treat any non-CLIENT session as staff. The boundary is the host
  gate, `lib/proxy/dealer-host.ts`: on `DEALER_APP_HOST` only `/dealer`, `/api/dealer`,
  NextAuth and the set-password token path are served and a non-DEALER session 404s; off
  it the dealer paths 404 and a DEALER session is refused. A new staff guard joins the
  census, `lib/dealer/staff-guards-refuse.test.ts`. Unset `DEALER_APP_HOST` = no dealer
  sign-in anywhere; it needs a `TENANT_HOST_MAP` entry and the staff container.
- `sign-in.ts`; revalidation `principal.ts` (the jwt DEALER branch runs before staff).
  Revocation is `tokenVersion` (DB: only increases), bumped with any deactivation. Portal
  on = `featureAssetFinance && featureDealerPortal && isDemoLender` (CHECK
  `TenantConfig_dealer_portal_demo_only` until dealer 2FA ships). Writes are same-origin.

## The 404 rule
- Every refusal of a signed-in session is 404 (`guards.ts`, `page-guard.ts`): another
  dealer's or lender's row, a staff/client session, the portal off, SALES on an admin
  route. Every query filters `{ tenantId, dealerId }` (`dealerDealWhere` in `deals.ts`);
  a miss is `dealerMiss` (`result.ts`). Never 403 or "not yours".
- A duplicate borrower or asset is 409 "already on the lender's book" (audited, rate
  limited), showing nothing of it. A dealer deal names only a borrower and asset that
  dealer captured; `createdByDealerId` and a dealer deal's parties are write-once (DB).

## Projection and handoff
- `deal-view.ts` is a whitelist `select`, never the deal row. Never add: decision or
  reasons, approval exceptions, financials, affordability, bureau/screening, NCA
  regime/rule/override, payout, staff uploads, other dealers' rows, or how the loan
  performs (a reversal's reason). `deal-view.test.ts` plants sentinels; the commission
  statement follows the same rule.
- Dealer submit only sets `dealerSubmittedAt` (DRAFT is left only after it, CHECK
  `AssetFinanceDeal_dealer_handover`); the staff accept (`submit.ts`) runs the unchanged
  `submitDeal` as staff. Consent is evidence, only for people the dealer captured. Dealer
  uploads never satisfy staff gates; after the hand-over they only answer a request.
- Dealer-typed contact details are untrusted until staff verify them
  (`contact-verification.ts`): no portal activation or password, no signing code, no
  booking (DB: `Client_dealer_contact_guard`, `AssetFinanceDeal_dealer_contacts_verified`).

## Commission (the database owns it)
- No TS writer. `guardAssetDealDealer` snapshots on the move into APPROVED (base = goods
  advance: cash price incl. VAT less deposit and trade-in); EARNED at BOOKED, REVERSED
  on the Loan's status (CANCELLED always, else inside `clawbackMonths`). Insert-only.
- **Commission never depends on the rate or the fees** (a dealer paid more for pricing
  the borrower up is conflicted), and is never a borrower charge (`no-borrower-charge.test.ts`).
- **Netting.** A run links REVERSED lines first; an EARNED line joins only with or after
  its reversal (`payable-run-lines.ts`; triggers `DealerPayableRunLine_netting`,
  `DealerPayableRun_netting`). Four-eyes; release to the APPROVED staff-captured account,
  with the dealer's tax invoice if it carries VAT. Journals: `lib/accounting/AGENTS.md`.
