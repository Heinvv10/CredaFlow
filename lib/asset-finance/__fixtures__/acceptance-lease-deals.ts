/**
 * Lease acceptance deals (slice 3, C12; DESIGN.md "Acceptance (every slice)"):
 * three synthetic operating and full-maintenance leases whose rental, VAT,
 * escalation and early-termination figures the pricing and termination code
 * must reproduce to the cent. Asserted by lib/asset-finance/acceptance-deals.test.ts.
 *
 * Every expectation was derived INDEPENDENTLY of lib/asset-finance/lease-pricing.ts,
 * amortise.ts and lease-termination.ts, from the written rules below, in exact
 * rational arithmetic (Python Fractions: a spreadsheet, not the solver). The
 * working is above each deal. Every figure is integer cents; every deal is synthetic.
 *
 * Shared rules (r = annual rate, d_i = days in period i, e = rental escalation):
 *   capital F   = cash price EXCLUDING VAT (no deposit, trade-in or fee)
 *   residual    = the balance still owed immediately after the LAST rental
 *   g_i         = 1 + r × d_i / 365                       (actual/365, simple)
 *   w_i         = (1 + e)^floor(i / 12), half-up to 6 decimals (i is 0-based)
 *   A0 = F × Π g_i;  U = Σ_i w_i × Π_{j>i} g_j;  B = round_half_up((A0 − residual) / U)
 *   int_i       = round_half_up(open_i × r × d_i / 365)
 *   rental_i    = round_half_up(B × w_i); the last absorbs the residue:
 *                 open + int − residual
 *   maint_i     = round_half_up(M × (1 + m)^floor(i / 12) to 6 dp)      (FML only)
 *   VAT_i       = half_up(15% × rental_i) + half_up(15% × maint_i)       (per line)
 *   total_i     = rental_i + maint_i + VAT_i
 *   ARREARS: due = start + (i + 1) months; ADVANCE: due = start + i months, the
 *   first on the start date with d_0 = 0 (an annuity due); month-end clamped from the anchor.
 * Early termination (rental-only PV at the contract rate, from the termination date T):
 *   PV = round_half_up( Σ_k rental_k / Π_{j ≤ k} (1 + r × days_j / 365) ), k over rentals due after T,
 *   days_1 counted from T; penalty = round_half_up(p × PV); invoice VAT half-up per line;
 *   amount = PV + penalty + VAT(PV) + VAT(penalty) + arrears (already invoiced: no new VAT).
 */
import type { LeasePricingInput } from "../lease-pricing"
import type { TerminationInput } from "../lease-termination"

export interface AcceptanceLeaseRow {
  periodNo: number // 1-based
  dueDate: string
  openingBalanceCents: number
  interestCents: number
  rentalExclVatCents: number
  maintenanceExclVatCents: number
  vatCents: number
  totalCents: number
}

export interface AcceptanceLeaseDeal {
  id: string
  description: string
  input: LeasePricingInput
  expected: {
    baseRentalCents: number
    /** Distinct rental weights by year of the term (floor(i / 12)). */
    weightsByYear: number[]
    /** Maintenance escalation factors by year (FML). */
    maintenanceFactorsByYear?: number[]
    rows: AcceptanceLeaseRow[]
    totals: { rentalExclVatCents: number; maintenanceExclVatCents: number; vatCents: number; totalCents: number }
  }
  termination?: {
    input: Omit<TerminationInput, "rentals">
    /** The rentals still to fall due after the termination date. */
    remainingRentals: number
    pvCents: number
    penaltyCents: number
    invoiceVatCents: number
    invoiceExclVatCents: number
    totalCents: number
  }
}

const row = (
  periodNo: number, dueDate: string, openingBalanceCents: number, interestCents: number,
  rentalExclVatCents: number, maintenanceExclVatCents: number, vatCents: number, totalCents: number,
): AcceptanceLeaseRow => ({ periodNo, dueDate, openingBalanceCents, interestCents, rentalExclVatCents, maintenanceExclVatCents, vatCents, totalCents })

export const LEASE_DEALS: AcceptanceLeaseDeal[] = [
  /*
   * LSE-1 — operating lease, ARREARS, 36 months, fixed 11.75%, escalation 6.875%.
   *   cash R1 100 000.00 ex VAT, residual R250 000.00; F = 110 000 000, residual 25 000 000
   *   start 2027-01-31, due month-end clamped: 2027-02-28 (28 d), 03-31 (31 d), … 2030-01-31 (Σ 1 096 days)
   *   weights: years 1–3 = 1, 1.06875, 1.06875² = 1.1422265625 → 1.142227 (half-up: the 7th digit is 5 or more)
   *   A0 = 156 269 706.053943   U = 45.718332854
   *   B  = (156 269 706.053943 − 25 000 000) / 45.718332854 = 2 871 270.622977 → 2 871 271
   *   row 1: 110 000 000 × 0.1175 × 28/365 = 991 506.85 → 991 507; rental 2 871 271; VAT 430 690.65 → 430 691; total 3 301 962
   *   row 13 (2028-02-29, 29 d, year 2): 2 871 271 × 1.06875 = 3 068 670.88 → 3 068 671; VAT 460 300.65 → 460 301; total 3 528 972
   *   row 25 (year 3): 2 871 271 × 1.142227 = 3 279 643.26 → 3 279 643; VAT 491 946.45 → 491 946; total 3 771 589
   *   row 36 (2030-01-31, 31 d): open 28 000 202; int 279 427; rental = 28 000 202 + 279 427 − 25 000 000 = 3 279 629
   *   Σ rentals = 12 × 2 871 271 + 12 × 3 068 671 + (3 279 643 × 11 + 3 279 629) = 110 635 006
   *   Σ VAT = 16 595 254; Σ total = 127 230 260
   */
  {
    id: "LSE-1",
    description: "Operating lease, arrears, 36 months, fixed 11.75%, 6.875% escalation (a 6-decimal half-up weight)",
    input: {
      cashPriceExclVatCents: 110_000_000, residualCents: 25_000_000, periods: 36, rentalTiming: "ARREARS",
      escalationRate: "0.06875", startDate: "2027-01-31", maintenance: null, vatRateTenThousandths: 1500,
      ratePath: [{ effectiveDate: "2027-01-31", annualRate: 0.1175 }],
    },
    expected: {
      baseRentalCents: 2_871_271,
      weightsByYear: [1, 1.06875, 1.142227],
      rows: [
        row(1, "2027-02-28", 110_000_000, 991_507, 2_871_271, 0, 430_691, 3_301_962),
        row(2, "2027-03-31", 108_120_236, 1_078_981, 2_871_271, 0, 430_691, 3_301_962),
        row(12, "2028-01-31", 89_236_057, 890_527, 2_871_271, 0, 430_691, 3_301_962),
        row(13, "2028-02-29", 87_255_313, 814_582, 3_068_671, 0, 460_301, 3_528_972),
        row(25, "2029-02-28", 59_218_960, 533_782, 3_279_643, 0, 491_946, 3_771_589),
        row(36, "2030-01-31", 28_000_202, 279_427, 3_279_629, 0, 491_944, 3_771_573),
      ],
      totals: { rentalExclVatCents: 110_635_006, maintenanceExclVatCents: 0, vatCents: 16_595_254, totalCents: 127_230_260 },
    },
  },
  /*
   * LSE-2 — full-maintenance lease, ADVANCE, 36 months, fixed 13.25%, rental escalation 5%,
   *   maintenance R3 850.00 a month ex VAT escalating 7.125%.
   *   cash R1 800 000.00 ex VAT, residual R400 000.00; F = 180 000 000, residual 40 000 000
   *   start = first due 2027-05-31; due month-end clamped: 05-31 (d = 0), 06-30 (30 d), 07-31 (31 d), … 2030-04-30 (Σ 1 065 days)
   *   weights 1, 1.05, 1.1025; maintenance factors 1, 1.07125 → 1.07125, 1.07125² = 1.1475765625 → 1.147577
   *   A0 = 264 395 301.363855   U = 45.937190419
   *   B  = (264 395 301.363855 − 40 000 000) / 45.937190419 = 4 884 828.59568 → 4 884 829
   *   row 1 (ON the start date, no days): interest 0; rental 4 884 829; maintenance 385 000;
   *          VAT = 732 724.35 → 732 724 + 57 750 = 790 474; total 6 060 303
   *   row 2: 175 115 171 × 0.1325 × 30/365 = 1 907 076.1 → 1 907 076
   *   row 13 (2028-05-31, year 2): rental 4 884 829 × 1.05 = 5 129 070.45 → 5 129 070;
   *          maintenance 385 000 × 1.07125 = 412 431.25 → 412 431; VAT 769 360.5 → 769 361 (half-up) + 61 864.65 → 61 865 = 831 226; total 6 372 727
   *   row 25 (year 3): rental 4 884 829 × 1.1025 = 5 385 523.97 → 5 385 524; maintenance 385 000 × 1.147577 = 441 817.1 → 441 817;
   *          VAT 807 828.6 → 807 829 + 66 272.55 → 66 273 = 874 102; total 6 701 443
   *   row 36 (2030-04-30, 30 d): open 44 896 569; int 488 942; rental = 44 896 569 + 488 942 − 40 000 000 = 5 385 511
   *   Σ rentals 184 793 063; Σ maintenance 14 870 976; Σ VAT 29 949 622; Σ total 229 613 661
   */
  {
    id: "LSE-2",
    description: "Full-maintenance lease, advance, 36 months, fixed 13.25%, 5% rental and 7.125% maintenance escalation",
    input: {
      cashPriceExclVatCents: 180_000_000, residualCents: 40_000_000, periods: 36, rentalTiming: "ADVANCE",
      escalationRate: "0.05", startDate: "2027-05-31", vatRateTenThousandths: 1500,
      maintenance: { monthlyExclVatCents: 385_000, escalationRate: "0.07125" },
      ratePath: [{ effectiveDate: "2027-05-31", annualRate: 0.1325 }],
    },
    expected: {
      baseRentalCents: 4_884_829,
      weightsByYear: [1, 1.05, 1.1025],
      maintenanceFactorsByYear: [1, 1.07125, 1.147577],
      rows: [
        row(1, "2027-05-31", 180_000_000, 0, 4_884_829, 385_000, 790_474, 6_060_303),
        row(2, "2027-06-30", 175_115_171, 1_907_076, 4_884_829, 385_000, 790_474, 6_060_303),
        row(12, "2028-04-30", 144_146_183, 1_569_811, 4_884_829, 385_000, 790_474, 6_060_303),
        row(13, "2028-05-31", 140_831_165, 1_584_833, 5_129_070, 412_431, 831_226, 6_372_727),
        row(25, "2029-05-31", 95_260_090, 1_072_002, 5_385_524, 441_817, 874_102, 6_701_443),
        row(36, "2030-04-30", 44_896_569, 488_942, 5_385_511, 441_817, 874_100, 6_701_428),
      ],
      totals: { rentalExclVatCents: 184_793_063, maintenanceExclVatCents: 14_870_976, vatCents: 29_949_622, totalCents: 229_613_661 },
    },
  },
  /*
   * LSE-3 — operating lease, ARREARS, 24 months, fixed 12.50%, escalation 8%, with an early-termination quote.
   *   cash R950 000.00 ex VAT, residual R200 000.00; F = 95 000 000, residual 20 000 000
   *   start 2027-02-15, due the 15th from 2027-03-15 (Σ 731 days); weights 1, 1.08
   *   A0 = 121 865 979.388057   U = 28.142304212
   *   B  = (121 865 979.388057 − 20 000 000) / 28.142304212 = 3 619 674.445316 → 3 619 674
   *   row 1: 95 000 000 × 0.125 × 28/365 = 910 958.9 → 910 959; rental 3 619 674; VAT 542 951.1 → 542 951; total 4 162 625
   *   row 13 (2028-03-15, year 2): 3 619 674 × 1.08 = 3 909 247.92 → 3 909 248; VAT 586 387.2 → 586 387; total 4 495 635
   *   row 24 (2029-02-15): open 23 658 096; int 251 165; rental = 23 658 096 + 251 165 − 20 000 000 = 3 909 261
   *   Σ rentals 90 347 077; Σ VAT 13 552 058; Σ total 103 899 135
   *
   *   Quote: termination date T = 2028-05-15, rental 15's own due date; rentals 1–13 paid, 14 (due 2028-04-15) and
   *   15 (due on T) unpaid. A rental due on T is not "still to fall due": it is arrears (the boundary case).
   *   Remaining: rentals 16–24 (9), the first due 2028-06-15 (31 days after T), the next 30 days after that, …
   *   discount factors: 1 + 0.125 × 31/365 = 1.01061644; × (1 + 0.125 × 30/365) = 1.02099948; and so on (the product
   *   over each period)
   *   Σ rental_k / factor_k = 33 405 906.3497 → PV 33 405 906
   *   penalty 10% = 3 340 590.6 → 3 340 591
   *   VAT: 33 405 906 × 15% = 5 010 885.9 → 5 010 886; 3 340 591 × 15% = 501 088.65 → 501 089; invoice VAT 5 511 975
   *   invoice ex VAT 36 746 497
   *   arrears = rentals 14 and 15 in full, 2 × 4 495 635 = 8 991 270, + a R250.00 collection fee for rental 14 (rental 15's
   *            posts the day after T) 25 000, + default interest on rental 14 at 12.5% + 5% margin: 29 complete days
   *            (04-16 … 05-14; T itself is not complete): 4 495 635 × 0.175 × 29/365 = 62 508.15 → 62 508; none on rental 15
   *            = 9 078 778
   *   amount = 36 746 497 + 5 511 975 + 9 078 778 = 51 337 250
   */
  {
    id: "LSE-3",
    description: "Operating lease, arrears, 24 months, fixed 12.5%, 8% escalation, early-termination quote with arrears",
    input: {
      cashPriceExclVatCents: 95_000_000, residualCents: 20_000_000, periods: 24, rentalTiming: "ARREARS",
      escalationRate: "0.08", startDate: "2027-02-15", maintenance: null, vatRateTenThousandths: 1500,
      ratePath: [{ effectiveDate: "2027-02-15", annualRate: 0.125 }],
    },
    expected: {
      baseRentalCents: 3_619_674,
      weightsByYear: [1, 1.08],
      rows: [
        row(1, "2027-03-15", 95_000_000, 910_959, 3_619_674, 0, 542_951, 4_162_625),
        row(2, "2027-04-15", 92_291_285, 979_805, 3_619_674, 0, 542_951, 4_162_625),
        row(12, "2028-02-15", 64_479_718, 684_545, 3_619_674, 0, 542_951, 4_162_625),
        row(13, "2028-03-15", 61_544_589, 611_231, 3_909_248, 0, 586_387, 4_495_635),
        row(14, "2028-04-15", 58_246_572, 618_371, 3_909_248, 0, 586_387, 4_495_635),
        row(15, "2028-05-15", 54_955_695, 564_613, 3_909_248, 0, 586_387, 4_495_635),
        row(24, "2029-02-15", 23_658_096, 251_165, 3_909_261, 0, 586_389, 4_495_650),
      ],
      totals: { rentalExclVatCents: 90_347_077, maintenanceExclVatCents: 0, vatCents: 13_552_058, totalCents: 103_899_135 },
    },
    termination: {
      input: { terminationDate: "2028-05-15", annualRate: 0.125, arrearsCents: 9_078_778, penaltyRate: "0.1", vatRateTenThousandths: 1500 },
      remainingRentals: 9, pvCents: 33_405_906, penaltyCents: 3_340_591,
      invoiceExclVatCents: 36_746_497, invoiceVatCents: 5_511_975, totalCents: 51_337_250,
    },
  },
]
