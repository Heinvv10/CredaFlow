<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: asset finance legal enforcement
<!-- summary: asset surrender receipt windows, withdrawal, surplus and NCA schedule splits -->

- Valuation notice issue is not receipt. `surrender-lifecycle.ts` records
  actual receipt once with delivery evidence. No NCA listing, sale or proceeds
  receipt is allowed until the ten SA business days following receipt finish.
- A timely s127 withdrawal records the actual goods handover. An agreement
  still in default cannot resume possession by this withdrawal path. Linked
  recovery withdrawal and surrender withdrawal share one transaction.
- `surrender-store.ts` applies standalone proceeds and their state/audit in
  one transaction under the loan then surrender locks. Both standalone and
  recovery freezes feed `lib/loan/charges-replay.ts`.
- `nca-surplus-account.ts` records bank evidence, separate verification and
  separate release authority. `nca-surplus.ts` writes the final-notice payment
  instruction, or a held-for-missing-account exception, with the notice.
  A payment instruction does not assert bank settlement confirmation.
- `schedule-records.ts` excludes fees from capital: every NCA row satisfies
  capital + interest + fees = payment. Premiums remain fees in the PASQ billing
  layer; the shared consumer PASQ output must not change without approval.
- Asset wording stays DRAFT until the lender approves it. This work never
  authorises setting the legal approval flag or changing consumer PDF pins.
