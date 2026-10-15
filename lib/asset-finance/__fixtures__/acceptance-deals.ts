/**
 * Acceptance deals (DESIGN.md "Acceptance (every slice)"): deals whose
 * figures the solver must reproduce to the cent. Asserted by
 * lib/asset-finance/acceptance-deals.test.ts.
 *
 * CLIENT_DEALS is the slot for the client's anonymised deal pack: 10–20 past
 * deals with their own figures. It is EMPTY until the pack is supplied; the
 * test skips that block with a message rather than inventing figures.
 *
 * SYNTHETIC_DEALS are three hand-built deals. Their expectations were derived
 * INDEPENDENTLY of lib/asset-finance/structure.ts, from the written rules
 * (actual/365 simple interest on the opening balance, rounded half-up once a
 * period; payment = round(B × weight); the last row absorbs the residue; VAT
 * split half-up by the tax fraction), in exact rational arithmetic — a
 * spreadsheet, not the solver. The working is below each deal.
 *
 * Shared formulas (r = annual rate, d_i = days in period i, w_i = weight):
 *   F        = cash − deposit − trade-in + financed fees
 *   g_i      = 1 + r × d_i / 365                        (period growth)
 *   A0       = F × Π g_i                                (closing balance if B = 0)
 *   U        = Σ_i w_i × Π_{j>i} g_j                    (closing balance per 1c of B)
 *   B        = round_half_up( (A0 − balloon) / U )
 *   int_i    = round_half_up( open_i × r × d_i / 365 )
 *   pay_i    = round_half_up(B × w_i); last row: open + int − balloon
 *   interest = Σ int_i = Σ payments (balloon included) − F
 *   VAT      excl = round_half_up(cash × 10000 / 11500); vat = cash − excl
 * Every figure is integer cents; every deal and figure is synthetic.
 *
 * The lease deals (slice 3) are in ./acceptance-lease-deals.ts, re-exported here.
 */
import type { StructureInput } from "../types"

export { LEASE_DEALS, type AcceptanceLeaseDeal, type AcceptanceLeaseRow } from "./acceptance-lease-deals"

export interface AcceptanceRow {
  index: number // 0-based
  dueDate: string
  openingBalanceCents: number
  interestCents: number
  principalCents: number
  balloonCents: number
  totalCents: number
}

export interface AcceptanceDeal {
  id: string
  description: string
  input: StructureInput
  /** VAT rate in ten-thousandths (1500 = 15%), applied to input.cashPriceCents (VAT-inclusive). */
  vatRateTenThousandths: number
  expected: {
    financedAmountCents: number
    baseInstalmentCents: number
    totalInterestCents: number
    totalPayableCents: number
    firstTwoInterestCents: [number, number]
    finalRow: AcceptanceRow
    /** Further rows worth pinning (a skip period). */
    rows?: AcceptanceRow[]
    vat: { exclVatCents: number; vatCents: number }
  }
}

/** The client's anonymised deal pack goes here (empty until it is supplied). */
export const CLIENT_DEALS: AcceptanceDeal[] = []

/** Seasonal pattern for SYN-3: Apr–Jun harvest ×3, Dec–Jan skip, else 1; period 0 is August. */
const SEASONAL_48 = Array.from({ length: 48 }, (_, i) => {
  const month = ((7 + i) % 12) + 1
  return [4, 5, 6].includes(month) ? 3 : [12, 1].includes(month) ? 0 : 1
})

export const SYNTHETIC_DEALS: AcceptanceDeal[] = [
  /*
   * SYN-1 — monthly 36, no balloon, fixed 12.00%.
   *   cash R862 500.00 incl. VAT, deposit R86 250.00 → F = 86 250 000 − 8 625 000 = 77 625 000
   *   start 2026-03-10, due the 10th from 2026-04-10; d = 31, 30, 31, 30, … 31, 28 (Σ 1 096 days)
   *   A0 = 111 099 450.267790   U = 43.071932919
   *   B  = (111 099 450.267790 − 0) / 43.071932919 = 2 579 393.185739 → 2 579 393
   *   row 1: 77 625 000 × 0.12 × 31/365 = 791 136.99 → 791 137; principal 2 579 393 − 791 137 = 1 788 256; close 75 836 744
   *   row 2: 75 836 744 × 0.12 × 30/365 = 747 979.39 → 747 979; close 74 005 330
   *   row 36 (2029-03-10, 28 days): open 2 555 871; int 2 555 871 × 0.12 × 28/365 = 23 527.77 → 23 528;
   *          pay = 2 555 871 + 23 528 − 0 = 2 579 399 (B + 6c residue)
   *   payments = 35 × 2 579 393 + 2 579 399 = 92 858 154; interest = 92 858 154 − 77 625 000 = 15 233 154
   *   VAT: 86 250 000 × 10000/11500 = 75 000 000 exactly; VAT 11 250 000
   */
  {
    id: "SYN-1",
    description: "Monthly 36, no balloon, fixed 12%",
    input: {
      cashPriceCents: 86_250_000, depositCents: 8_625_000, tradeInCents: 0, financedFeesCents: 0, balloonCents: 0,
      weights: Array<number>(36).fill(1), startDate: "2026-03-10",
      ratePath: [{ effectiveDate: "2026-03-10", annualRate: 0.12 }],
    },
    vatRateTenThousandths: 1500,
    expected: {
      financedAmountCents: 77_625_000, baseInstalmentCents: 2_579_393,
      totalInterestCents: 15_233_154, totalPayableCents: 92_858_154,
      firstTwoInterestCents: [791_137, 747_979],
      finalRow: {
        index: 35, dueDate: "2029-03-10", openingBalanceCents: 2_555_871, interestCents: 23_528,
        principalCents: 2_555_871, balloonCents: 0, totalCents: 2_579_399,
      },
      vat: { exclVatCents: 75_000_000, vatCents: 11_250_000 },
    },
  },
  /*
   * SYN-2 — monthly 60, 30% balloon, PRIME 10.75% + 1.50% = 12.25%.
   *   cash R1 234 567.89 incl. VAT, deposit R123 456.79 → F = 123 456 789 − 12 345 679 = 111 111 110
   *   balloon = 30% of cash = 37 037 036.7 → 37 037 037
   *   start 2026-01-31, due month-end (clamped): 2026-02-28 (28 d), 03-31 (31 d), 04-30 (30 d) … 2031-01-31 (Σ 1 826 days)
   *   A0 = 204 436 104.589588   U = 82.269945496
   *   B  = (204 436 104.589588 − 37 037 037) / 82.269945496 = 2 034 753.597822 → 2 034 754
   *   row 1: 111 111 110 × 0.1225 × 28/365 = 1 044 140.07 → 1 044 140; close 110 120 496
   *   row 2: 110 120 496 × 0.1225 × 31/365 = 1 145 705.95 → 1 145 706
   *   row 60 (2031-01-31, 31 days): open 38 669 435; int 38 669 435 × 0.1225 × 31/365 = 402 320.90 → 402 321;
   *          pay = 38 669 435 + 402 321 − 37 037 037 = 2 034 719; principal 1 632 398; + balloon → total 39 071 756
   *   payments = 59 × 2 034 754 + 39 071 756 = 159 122 242; interest = 159 122 242 − 111 111 110 = 48 011 132
   *   VAT: 123 456 789 × 10000/11500 = 107 353 729.57 → 107 353 730; VAT 16 103 059
   */
  {
    id: "SYN-2",
    description: "Monthly 60, 30% balloon, prime + 1.5%",
    input: {
      cashPriceCents: 123_456_789, depositCents: 12_345_679, tradeInCents: 0, financedFeesCents: 0, balloonCents: 37_037_037,
      weights: Array<number>(60).fill(1), startDate: "2026-01-31",
      ratePath: [{ effectiveDate: "2026-01-31", annualRate: 0.1225 }],
    },
    vatRateTenThousandths: 1500,
    expected: {
      financedAmountCents: 111_111_110, baseInstalmentCents: 2_034_754,
      totalInterestCents: 48_011_132, totalPayableCents: 159_122_242,
      firstTwoInterestCents: [1_044_140, 1_145_706],
      finalRow: {
        index: 59, dueDate: "2031-01-31", openingBalanceCents: 38_669_435, interestCents: 402_321,
        principalCents: 1_632_398, balloonCents: 37_037_037, totalCents: 39_071_756,
      },
      vat: { exclVatCents: 107_353_730, vatCents: 16_103_059 },
    },
  },
  /*
   * SYN-3 — seasonal 48 with skip months, fixed 13.50%, financed fee.
   *   cash R2 415 000.00 incl. VAT, deposit R241 500.00, financed fee R5 750.00
   *   F = 241 500 000 − 24 150 000 + 575 000 = 217 925 000
   *   start 2026-07-15, first due 2026-08-15; weights per due month: Apr–Jun 3, Dec–Jan 0 (skip), else 1:
   *   1,1,1,1,0,0,1,1,3,3,3,1 repeated 4× (Σ w = 64); d = 31, 31, 30, 31, … 31, 30 (Σ 1 461 days)
   *   A0 = 372 970 629.822707   U = 82.900525889
   *   B  = 372 970 629.822707 / 82.900525889 = 4 499 014.039068 → 4 499 014
   *   row 1: 217 925 000 × 0.135 × 31/365 = 2 498 674.32 → 2 498 674; close 215 924 660
   *   row 2: 215 924 660 × 0.135 × 31/365 = 2 475 739.17 → 2 475 739
   *   row 5 (2026-12-15, skip, 30 d): open 209 704 952; int 2 326 863.23 → 2 326 863; pay 0;
   *          principal −2 326 863 (interest capitalises); close 212 031 815
   *   row 48 (2030-07-15, 30 days): open 4 449 644; int 4 449 644 × 0.135 × 30/365 = 49 372.97 → 49 373;
   *          pay = 4 449 644 + 49 373 − 0 = 4 499 017
   *   payments = B × (Σ w − 1) for rows 1–47, rounded per row (weights are whole) = 4 499 014 × 63
   *            = 283 437 882; + 4 499 017 = 287 936 899; interest = 287 936 899 − 217 925 000 = 70 011 899
   *   VAT: 241 500 000 × 10000/11500 = 210 000 000 exactly; VAT 31 500 000
   */
  {
    id: "SYN-3",
    description: "Seasonal 48 (harvest ×3, Dec–Jan skipped), fixed 13.5%, financed fee",
    input: {
      cashPriceCents: 241_500_000, depositCents: 24_150_000, tradeInCents: 0, financedFeesCents: 575_000, balloonCents: 0,
      weights: SEASONAL_48, startDate: "2026-07-15", firstDueDate: "2026-08-15",
      ratePath: [{ effectiveDate: "2026-07-15", annualRate: 0.135 }],
    },
    vatRateTenThousandths: 1500,
    expected: {
      financedAmountCents: 217_925_000, baseInstalmentCents: 4_499_014,
      totalInterestCents: 70_011_899, totalPayableCents: 287_936_899,
      firstTwoInterestCents: [2_498_674, 2_475_739],
      finalRow: {
        index: 47, dueDate: "2030-07-15", openingBalanceCents: 4_449_644, interestCents: 49_373,
        principalCents: 4_449_644, balloonCents: 0, totalCents: 4_499_017,
      },
      rows: [{
        index: 4, dueDate: "2026-12-15", openingBalanceCents: 209_704_952, interestCents: 2_326_863,
        principalCents: -2_326_863, balloonCents: 0, totalCents: 0,
      }],
      vat: { exclVatCents: 210_000_000, vatCents: 31_500_000 },
    },
  },
]
