import { describe, expect, it } from "vitest"
import { renderRecord } from "./layout"
import { bureauAccountType, mapLoan, monthsInArrears } from "./map-loan"
import { at, bureauInput, overdueInput } from "./test-input"

describe("mapLoan — a performing loan", () => {
  const { fields, statusCode } = mapLoan(bureauInput())

  it("maps identity from the client, deriving gender and date of birth from the ID", () => {
    expect(fields.saIdNumber).toBe("8001015009087")
    expect(fields.gender).toBe("M")
    expect(fields.dateOfBirth).toBe("19800101")
    expect(fields.surname).toBe("MOKOENA")
    expect([fields.forename1, fields.forename2, fields.forename3]).toEqual(["THABO", "TESTING", ""])
  })

  it("derives a female gender from an ID sequence below 5000", () => {
    expect(mapLoan(bureauInput({ client: { idNumber: "9202200001082" } })).fields.gender).toBe("F")
  })

  it("prefers the captured date of birth over the ID-derived one", () => {
    expect(mapLoan(bureauInput({ client: { dateOfBirth: at("1980-01-02") } })).fields.dateOfBirth).toBe("19800102")
  })

  it("uses the loan reference, upper-cased and otherwise untouched, as the account number", () => {
    expect(fields.accountNumber).toBe("LN-TEST0A-0001")
    expect(mapLoan(bureauInput({ loan: { reference: "ln-ab/c 1" } })).fields.accountNumber).toBe("LN-AB/C 1")
  })

  it("leaves branch, sub-account, title, postal address, owner/tenant and occupation blank", () => {
    for (const name of ["branchCode", "subAccountNumber", "title", "postalAddressLine1", "ownerTenant", "occupation", "homePhone", "workPhone", "nonSaIdNumber"]) {
      expect(fields[name], name).toBeUndefined()
    }
  })

  it("reports the settlement amount in whole rands as the current balance", () => {
    expect(fields.currentBalance).toBe("3700")
    expect(fields.currentBalanceIndicator).toBe("D")
    expect(mapLoan(bureauInput({ settlementCents: 370_049 })).fields.currentBalance).toBe("3700")
    expect(mapLoan(bureauInput({ settlementCents: 370_050 })).fields.currentBalance).toBe("3701")
  })

  it("includes a deferred initiation fee in the opening balance and excludes an upfront one", () => {
    expect(fields.openingBalance).toBe("5500")
    expect(mapLoan(bureauInput({ initiationFeePayment: "UPFRONT" })).fields.openingBalance).toBe("5000")
  })

  it("reports the recurring instalment, not the fee-loaded first one", () => {
    expect(fields.instalment).toBe("1850")
  })

  it("reports nothing overdue and 00 months in arrears", () => {
    expect(fields.amountOverdue).toBe("0")
    expect(fields.monthsInArrears).toBe("0")
    expect(statusCode).toBeNull()
    expect(fields.statusCode).toBe("")
    expect(fields.statusDate).toBe("")
  })

  it("maps product type, term, frequency, reason and dates", () => {
    expect(fields.accountType).toBe("P")
    expect(fields.terms).toBe("3")
    expect(fields.repaymentFrequency).toBe("03")
    expect(fields.loanReason).toBe("E")
    expect(fields.paymentType).toBe("00")
    expect(fields.ownershipType).toBe("00")
    expect(fields.dateOpened).toBe("20260815")
    expect(fields.lastPaymentDate).toBe("20260915")
    expect(mapLoan(bureauInput({ loanPurposeCategory: null })).fields.loanReason).toBe("O")
  })

  it("reports a micro loan as type M with a term of one", () => {
    const micro = mapLoan(bureauInput({ productType: "MICRO", termDays: 61 })).fields
    expect(micro.accountType).toBe("M")
    expect(micro.terms).toBe("1")
  })

  it("normalises the cell number, employer and income", () => {
    expect(fields.cellPhone).toBe("0821234567")
    expect(fields.employer).toBe("ACME MINING PTY LTD")
    expect(fields.income).toBe("12500")
    expect(fields.incomeFrequency).toBe("M")
    const unknown = mapLoan(bureauInput({ client: { monthlyIncome: 0, phone: "12345" } })).fields
    expect(unknown.income).toBe("")
    expect(unknown.incomeFrequency).toBe("")
    expect(unknown.cellPhone).toBe("")
  })

  it("renders to a 700-character line", () => {
    expect(renderRecord(fields, "MONTHLY")).toHaveLength(700)
  })
})

describe("mapLoan — address", () => {
  it("sends street, suburb and city on lines 1-3 with a cleaned postal code", () => {
    const { fields } = mapLoan(bureauInput({ client: { addressLine1: "Unit 4, 12 Main Rd.", postalCode: " 0122 " } }))
    expect(fields.addressLine1).toBe("UNIT 4 12 MAIN RD")
    expect(fields.addressLine2).toBe("MAMELODI")
    expect(fields.addressLine3).toBe("PRETORIA")
    expect(fields.postalCode).toBe("0122")
  })

  it("strips placeholder words and a zero-filled postal code", () => {
    const { fields } = mapLoan(bureauInput({
      client: { addressLine1: "Unknown", suburb: "N/A", city: "as above", postalCode: "0000" },
    }))
    expect(fields.addressLine1).toBe("")
    expect(fields.addressLine2).toBe("")
    expect(fields.addressLine3).toBe("")
    expect(fields.postalCode).toBe("")
  })
})

describe("monthsInArrears — whole 30-day blocks", () => {
  const open = { overdueRands: 500, daysOpen: 400 }
  it("is 0 for 0-29 days, 1 for 30-59, 2 for 60-89", () => {
    expect(monthsInArrears({ ...open, daysInArrears: 29 })).toBe(0)
    expect(monthsInArrears({ ...open, daysInArrears: 30 })).toBe(1)
    expect(monthsInArrears({ ...open, daysInArrears: 59 })).toBe(1)
    expect(monthsInArrears({ ...open, daysInArrears: 60 })).toBe(2)
  })
  it("never exceeds the months the account has been open", () => {
    expect(monthsInArrears({ overdueRands: 500, daysInArrears: 95, daysOpen: 61 })).toBe(2)
  })
  it("is 0 when nothing is overdue, whatever the day count", () => {
    expect(monthsInArrears({ overdueRands: 0, daysInArrears: 95, daysOpen: 400 })).toBe(0)
  })
  it("is derived from the schedule as at the period date, not from a stored column", () => {
    const { fields } = mapLoan(overdueInput())
    expect(fields.amountOverdue).toBe("6050")
    expect(fields.monthsInArrears).toBe("2")
  })
  it("adds default charges owed to the amount overdue", () => {
    expect(mapLoan(overdueInput({ chargesOutstandingCents: 8_200 })).fields.amountOverdue).toBe("6132")
  })
})

describe("mapLoan — status", () => {
  it("COMPLETED on or after maturity is C with every balance zeroed", () => {
    const { fields, statusCode, statusDate } = mapLoan(bureauInput({
      loan: { status: "COMPLETED", closedAt: at("2026-11-15") }, asOf: at("2026-11-30"), settlementCents: 0,
    }))
    expect(statusCode).toBe("C")
    expect(statusDate).toEqual(at("2026-11-15"))
    expect(fields.statusDate).toBe("20261115")
    expect([fields.currentBalance, fields.amountOverdue, fields.instalment, fields.monthsInArrears]).toEqual(["0", "0", "0", "0"])
    expect(fields.openingBalance).toBe("5500")
  })

  it("COMPLETED before maturity is T", () => {
    const { statusCode, fields } = mapLoan(bureauInput({ loan: { status: "COMPLETED", closedAt: at("2026-09-20") }, settlementCents: 0 }))
    expect(statusCode).toBe("T")
    expect(fields.instalment).toBe("0")
  })

  it("a deceased client is Z, dated the death, with balances kept", () => {
    const { fields, statusCode } = mapLoan(overdueInput({ client: { deceasedAt: at("2026-11-02") } }))
    expect(statusCode).toBe("Z")
    expect(fields.statusDate).toBe("20261102")
    expect(fields.currentBalance).toBe("6050")
  })

  it("a deceased client is never given an adverse listing", () => {
    const { statusCode } = mapLoan(overdueInput({
      loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") },
      client: { deceasedAt: at("2026-11-02") },
      confirmedAdverse: ["W"],
    }))
    expect(statusCode).toBe("Z")
  })

  it("WRITTEN_OFF carries no status until a staff member confirms it", () => {
    const { fields, statusCode } = mapLoan(overdueInput({ loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") } }))
    expect(statusCode).toBeNull()
    expect(fields.amountOverdue).toBe("6050")
    expect(fields.monthsInArrears).toBe("2")
  })

  it("a confirmed WRITTEN_OFF is W, with the write-off value as the amount overdue", () => {
    const { fields, statusCode } = mapLoan(overdueInput({
      loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") },
      schedule: bureauInput().schedule.map((row, i) => ({ ...row, totalPaid: i === 0 ? row.totalDue : 0 })),
      settlementCents: 400_000,
      confirmedAdverse: ["W"],
    }))
    expect(statusCode).toBe("W")
    expect(fields.statusDate).toBe("20261110")
    // schedule arrears are R3,700; the write-off value is the R4,000 balance
    expect(fields.currentBalance).toBe("4000")
    expect(fields.amountOverdue).toBe("4000")
  })

  it("ATTORNEY_REFERRED carries no status until confirmed, then is L dated the referral", () => {
    const referred = { loan: { collectionsStage: "ATTORNEY_REFERRED" }, attorneyReferralDate: at("2026-11-12") }
    expect(mapLoan(overdueInput(referred)).statusCode).toBeNull()
    const { fields, statusCode } = mapLoan(overdueInput({ ...referred, confirmedAdverse: ["L"] }))
    expect(statusCode).toBe("L")
    expect(fields.statusDate).toBe("20261112")
    expect(fields.amountOverdue).toBe("6050")
  })

  it("leaves out a handover dated after the period, and sends one dated on its last day", () => {
    const referred = { loan: { collectionsStage: "ATTORNEY_REFERRED" }, confirmedAdverse: ["L" as const] }
    // overdueInput is as at 20 Nov 2026.
    const later = mapLoan(overdueInput({ ...referred, attorneyReferralDate: at("2026-11-21") }))
    expect(later.statusCode).toBeNull()
    expect(later.fields.statusDate).toBe("")
    expect(later.fields.amountOverdue).toBe("6050")
    expect(mapLoan(overdueInput({ ...referred, attorneyReferralDate: at("2026-11-20") })).statusCode).toBe("L")
  })

  it("leaves out a death recorded after the period, and still gives a deceased client no adverse listing", () => {
    const { statusCode, fields } = mapLoan(overdueInput({ client: { deceasedAt: at("2026-11-21") } }))
    expect(statusCode).toBeNull()
    expect(fields.currentBalance).toBe("6050")
    expect(mapLoan(overdueInput({
      loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") }, client: { deceasedAt: at("2026-11-21") }, confirmedAdverse: ["W"],
    })).statusCode).toBeNull()
    expect(mapLoan(overdueInput({ client: { deceasedAt: at("2026-11-20") } })).statusCode).toBe("Z")
  })

  it("a confirmation for one adverse status does not release the other", () => {
    const { statusCode } = mapLoan(overdueInput({
      loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") }, confirmedAdverse: ["L"],
    }))
    expect(statusCode).toBeNull()
  })

  it("a W with balance and overdue both under R100 goes as C with zeroed balances", () => {
    const small = bureauInput().schedule.map((row, i) => ({ ...row, totalDue: i === 0 ? 9_900 : 0, totalPaid: 0, principalDue: 0, interestDue: 0, feesDue: i === 0 ? 9_900 : 0 }))
    const { fields, statusCode } = mapLoan(overdueInput({
      loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") },
      schedule: small, settlementCents: 9_900, confirmedAdverse: ["W"],
    }))
    expect(statusCode).toBe("C")
    expect(fields.statusDate).toBe("20261110")
    expect([fields.currentBalance, fields.amountOverdue, fields.instalment]).toEqual(["0", "0", "0"])
  })

  it("keeps W when either the balance or the overdue amount reaches R100", () => {
    const { statusCode } = mapLoan(overdueInput({
      loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") },
      schedule: bureauInput().schedule.map((row) => ({ ...row, totalPaid: row.totalDue })),
      settlementCents: 10_000, confirmedAdverse: ["W"],
    }))
    expect(statusCode).toBe("W")
  })

  it("does not repeat a once-only status the ledger says was already sent", () => {
    const referred = { loan: { collectionsStage: "ATTORNEY_REFERRED" }, attorneyReferralDate: at("2026-11-12"), confirmedAdverse: ["L" as const] }
    expect(mapLoan(overdueInput({ ...referred, alreadySent: ["L"] })).statusCode).toBeNull()
    expect(mapLoan(overdueInput({ client: { deceasedAt: at("2026-11-02") }, alreadySent: ["Z"] })).statusCode).toBeNull()
  })

  it("never emits D, E or V", () => {
    const statuses = ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED", "WRITTEN_OFF", "COMPLETED", "CANCELLED"]
    for (const status of statuses) {
      for (const collectionsStage of ["NONE", "SECTION_129_SENT", "PAYMENT_ARRANGEMENT", "ATTORNEY_REFERRED"]) {
        const { statusCode } = mapLoan(overdueInput({
          loan: { status, collectionsStage, closedAt: at("2026-11-10"), writeOffAt: at("2026-11-10") },
          attorneyReferralDate: at("2026-11-12"), confirmedAdverse: ["W", "L"],
        }))
        expect(["C", "T", "W", "L", "Z", null]).toContain(statusCode)
      }
    }
  })
})

describe("mapLoan — daily records", () => {
  it("a registration has no status, no last payment date and 00 months in arrears", () => {
    const { fields } = mapLoan(overdueInput({ kind: "DAILY", dataFlag: "R", lastPaymentDate: at("2026-09-15"), loan: { status: "COMPLETED", closedAt: at("2026-11-20") } }))
    expect(fields.dataFlag).toBe("R")
    expect(fields.statusCode).toBe("")
    expect(fields.lastPaymentDate).toBe("")
    expect(fields.monthsInArrears).toBe("0")
    expect(fields.supplierNumber).toBe("TT0109")
    expect(fields.transactionDate).toBe("20261120")
    expect(renderRecord(fields, "DAILY")).toHaveLength(718)
  })

  it("a closure carries C or T and zeroed balances", () => {
    const { fields } = mapLoan(bureauInput({ kind: "DAILY", dataFlag: "C", loan: { status: "COMPLETED", closedAt: at("2026-09-30") }, settlementCents: 0 }))
    expect(fields.dataFlag).toBe("C")
    expect(fields.statusCode).toBe("T")
    expect(fields.currentBalance).toBe("0")
  })

  it("never carries a monthly-only status", () => {
    const { statusCode } = mapLoan(overdueInput({
      kind: "DAILY", dataFlag: "C", loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") }, confirmedAdverse: ["W"],
    }))
    expect(statusCode).toBeNull()
  })
})

describe("bureauAccountType", () => {
  it("maps MICRO to M and PERSONAL to P, and excludes PO funding", () => {
    expect(bureauAccountType("MICRO")).toBe("M")
    expect(bureauAccountType("PERSONAL")).toBe("P")
    expect(bureauAccountType("PO_FUNDING")).toBeNull()
    // A sole proprietor's NCA asset loan is reported as it was while asset products were typed PERSONAL.
    expect(bureauAccountType("ASSET_FINANCE")).toBe("P")
    expect(() => mapLoan(bureauInput({ productType: "PO_FUNDING" }))).toThrow(/not reported/)
  })
})
