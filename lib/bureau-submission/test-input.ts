import type { BureauLoanInput } from "./map-loan"

// Shared builder for the bureau-submission unit tests. Seeded data only:
// 8001015009087 is a synthetic ID number that passes the Home Affairs check.

type Overrides = Partial<Omit<BureauLoanInput, "loan" | "client">> & {
  loan?: Partial<BureauLoanInput["loan"]>
  client?: Partial<BureauLoanInput["client"]>
}

export const at = (isoDay: string) => new Date(`${isoDay}T10:00:00.000Z`)

/** A PERSONAL loan of R5,000 over 3 months, one instalment paid, none overdue at 30 Sep. */
export function bureauInput(overrides: Overrides = {}): BureauLoanInput {
  const { loan, client, ...rest } = overrides
  return {
    kind: "MONTHLY",
    dataFlag: "D",
    asOf: at("2026-09-30"),
    supplierNumber: "TT0109",
    productType: "PERSONAL",
    termDays: 90,
    initiationFeePayment: "DEFERRED",
    loanPurposeCategory: "MEDICAL",
    schedule: [
      { dueDate: at("2026-09-15"), principalDue: 160_000, interestDue: 25_000, feesDue: 50_000, totalDue: 235_000, totalPaid: 235_000 },
      { dueDate: at("2026-10-15"), principalDue: 165_000, interestDue: 20_000, feesDue: 0, totalDue: 185_000, totalPaid: 0 },
      { dueDate: at("2026-11-15"), principalDue: 175_000, interestDue: 10_000, feesDue: 0, totalDue: 185_000, totalPaid: 0 },
    ],
    settlementCents: 370_000,
    chargesOutstandingCents: 0,
    lastPaymentDate: at("2026-09-15"),
    attorneyReferralDate: null,
    confirmedAdverse: [],
    alreadySent: [],
    ...rest,
    loan: {
      reference: "LN-TEST0A-0001",
      status: "ACTIVE",
      principal: 500_000,
      initiationFee: 50_000,
      startDate: at("2026-08-15"),
      maturityDate: at("2026-11-15"),
      closedAt: null,
      writeOffAt: null,
      collectionsStage: "NONE",
      ...loan,
    },
    client: {
      idNumber: "8001015009087",
      firstName: "Thabo Testing",
      lastName: "Mokoena",
      dateOfBirth: null,
      addressLine1: "12 Main Road",
      suburb: "Mamelodi",
      city: "Pretoria",
      postalCode: "0122",
      phone: "+27821234567",
      employerName: "Acme Mining (Pty) Ltd",
      monthlyIncome: 1_250_000,
      deceasedAt: null,
      ...client,
    },
  }
}

/** The same loan with instalments 1 and 2 unpaid as at `asOf`. */
export function overdueInput(overrides: Overrides = {}): BureauLoanInput {
  const base = bureauInput()
  return bureauInput({
    asOf: at("2026-11-20"),
    schedule: base.schedule.map((row) => ({ ...row, totalPaid: 0 })),
    settlementCents: 605_000,
    lastPaymentDate: null,
    ...overrides,
  })
}
