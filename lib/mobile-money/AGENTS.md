<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: mobile-money
<!-- summary: M-Pesa repayments (paybill C2B, STK push); simulated only, booked via applyManualReceipt -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
M-Pesa repayments for a Kenyan lender: a paybill (C2B) payment quoting the
loan reference, or a portal "Pay with M-Pesa" STK push. Only the simulated
provider exists (KE-4); the Daraja adapter is KE-6. The portal panel shows
only when `MPESA_PAYBILL_SHORTCODE` is set.

## Critical Rules
- **Money goes through `applyManualReceiptInTx` only** (`lib/mobile-money/book.ts`):
  never write Payment or allocation rows here. Method `MOBILE_MONEY`, value date
  `SYSTEM_OBSERVED`, idempotency key `mpesa-c2b:<TransID>`.
- **Exactly once**: the receipt and its `MobileMoneyTransaction` row commit in
  one transaction; UNIQUE(provider, transId) (or a push no longer PENDING) rolls
  a second delivery back. A replay answers DUPLICATE and books nothing.
- **Money is never dropped**: charges refused -> HELD (`recordHeldReceipt`);
  other money-path refusals and amount mismatches -> NEEDS_REVIEW; an unknown
  account reference, or a paid push we never recorded -> UNMATCHED.
- **Simulation is guarded twice**: the simulated adapter refuses to sign, push
  or parse where `isSimulationPermitted("simulated-mpesa")` is false, and the
  ingest stores any simulating provider's callback NEEDS_REVIEW there.
- **Verify before reading**: the webhook passes the raw body to
  `parseCallback`; null -> 401. The tenant comes from the host, never the body.
- **No phone numbers stored or logged**: adapters cut the MSISDN to its last
  four digits (DB CHECK `MobileMoneyTransaction_msisdn_last4`). Audit rows
  carry ids and amounts only.
- **The row's columns must agree with its status** (DB CHECK, migration
  `20261108110100_mobile_money_transactions`). Only the `RUN_DB_IT` suite proves it.

## Key Files
| File | Purpose |
|------|---------|
| `lib/mobile-money/c2b-ingest.ts` | Entry: match the account reference, dispatch |
| `lib/mobile-money/stk-result.ts` | Settle a PENDING push from its result |
| `lib/mobile-money/stk-push.ts` | Start a push, deliver the simulated result |
| `lib/mobile-money/providers/simulated.ts` | Signed simulated callbacks |
| `app/api/webhooks/mobile-money/[provider]/route.ts` | Public callback route |
