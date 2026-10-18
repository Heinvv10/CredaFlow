# Asset-finance legal wording

The drafted wording of every asset-finance document, for the lender's legal
team. Every page keeps the DRAFT watermark until
`TenantConfig.assetFinanceLegalWordingApproved` is set for the lender. The
calculations and rules behind the wording are signed off (DESIGN.md, sign-off
record 2026-10-17); the wording is not.

- [`nca.md`](nca.md): the NCA agreement, quotation, s127 and s131 notices.
- [`lease.md`](lease.md): the lease agreement, CPA expiry notice, inspection
  report and early-termination quote.
- [`commercial.md`](commercial.md): the commercial instalment sale, suretyship
  and resolution.

Rendered samples: `docs/asset-finance/evidence/legal-wording/`, produced by
`scripts/asset-finance/render-legal-wording-nca-samples.ts` and
`scripts/asset-finance/render-legal-wording-deal-samples.ts` (both
deterministic: a rerun reproduces the committed PDFs).

## Code changes required before approval

The wording states the law. Where the system does not yet do what the wording
says, the gap is listed here. While any line remains, the flag must not be set
for any lender (DESIGN.md, sign-off record). One line per gap: rule; clause;
code; what must change.

24. NCA s104 notice of a rate change, and the contractual notices in ISA 7.5 and lease 9.3; NCA agreement 3.3, ISA 7.5, lease 9.3; `lib/asset-finance/reprice-notice.ts:4` (PARTIAL: only a staff bell, nothing sent or queued for the borrower); send the new rate and instalment or rental to the consumer or lessee in writing.
26. Effective date of a reference-rate change; ISA 7.4 and 7.5, NCA agreement 3.3, lease 9.3; `lib/asset-finance/rate-feed-sync.ts:15` (a fetched rate is recorded at the date the feed shows it, which can trail the real change; ZARONIA moves under 0.25 points are not recorded); apply a change from the date the reference rate takes effect, or reword the clauses to "the date the lender records it" (commercial.md point 7).
