import { describe, expect, it } from "vitest"
import { renderHeader, renderRecord, renderTrailer } from "./layout"
import { mapLoan } from "./map-loan"
import { at, bureauInput, overdueInput } from "./test-input"
import { recordHolds, validateFile, validateRecord } from "./validate"

const good = () => mapLoan(bureauInput()).fields

describe("validateRecord", () => {
  it("passes a clean record", () => {
    expect(validateRecord(good())).toEqual([])
  })

  it("passes a clean record with no address", () => {
    const { fields } = mapLoan(bureauInput({ client: { addressLine1: null, suburb: null, city: null, postalCode: null } }))
    expect(validateRecord(fields)).toEqual([])
  })

  it("holds an SA ID that fails the check digit", () => {
    expect(validateRecord({ ...good(), saIdNumber: "8001015009088" })).toEqual(["INVALID_SA_ID"])
  })

  it("holds a missing SA ID", () => {
    expect(validateRecord(mapLoan(bureauInput({ client: { idNumber: "A1234567" } })).fields)).toContain("INVALID_SA_ID")
  })

  it("holds a surname under two characters", () => {
    expect(validateRecord({ ...good(), surname: "A" })).toEqual(["INVALID_SURNAME"])
  })

  it("holds a surname with no vowel, counting Y as one", () => {
    expect(validateRecord({ ...good(), surname: "NG" })).toEqual(["INVALID_SURNAME"])
    expect(validateRecord({ ...good(), surname: "NY" })).toEqual([])
  })

  it("holds a record with no forename", () => {
    expect(validateRecord(mapLoan(bureauInput({ client: { firstName: " " } })).fields)).toEqual(["MISSING_FORENAME"])
  })

  it("holds an account number with a character outside A-Z 0-9 / \\ -", () => {
    expect(validateRecord({ ...good(), accountNumber: "LN_123" })).toEqual(["INVALID_ACCOUNT_NUMBER"])
    expect(validateRecord({ ...good(), accountNumber: "LN 123" })).toEqual(["INVALID_ACCOUNT_NUMBER"])
    expect(validateRecord({ ...good(), accountNumber: "LN/1\\2-3" })).toEqual([])
  })

  it("holds an account number over 25 characters", () => {
    expect(validateRecord({ ...good(), accountNumber: "A".repeat(26) })).toEqual(["INVALID_ACCOUNT_NUMBER"])
    expect(validateRecord({ ...good(), accountNumber: "A".repeat(25) })).toEqual([])
  })

  it("holds months in arrears above 0 with nothing overdue", () => {
    expect(validateRecord({ ...good(), monthsInArrears: "1", amountOverdue: "0" })).toEqual(["ARREARS_WITHOUT_OVERDUE"])
  })

  it.each(["currentBalance", "amountOverdue", "instalment"])("holds a C or T status with a non-zero %s", (field) => {
    const closed = mapLoan(bureauInput({ loan: { status: "COMPLETED", closedAt: at("2026-09-20") }, settlementCents: 0 })).fields
    expect(validateRecord(closed)).toEqual([])
    expect(validateRecord({ ...closed, [field]: "1" })).toContain("CLOSURE_WITH_BALANCE")
  })

  it("holds an opening balance of 0", () => {
    expect(validateRecord({ ...good(), openingBalance: "0" })).toEqual(["ZERO_OPENING_BALANCE"])
  })

  it("holds a current balance above 0 with an instalment of 0", () => {
    expect(validateRecord({ ...good(), instalment: "0" })).toEqual(["BALANCE_WITHOUT_INSTALMENT"])
  })

  it("holds a status with no status date", () => {
    const { fields } = mapLoan(bureauInput({ loan: { status: "COMPLETED", closedAt: null }, settlementCents: 0 }))
    expect(fields.statusCode).toBe("C")
    expect(validateRecord(fields)).toEqual(["STATUS_WITHOUT_DATE"])
  })

  it("holds a W or L with no amount overdue or no months in arrears", () => {
    const written = mapLoan(overdueInput({ loan: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-10") }, confirmedAdverse: ["W"] })).fields
    expect(validateRecord(written)).toEqual([])
    expect(validateRecord({ ...written, monthsInArrears: "0" })).toEqual(["ADVERSE_WITHOUT_ARREARS"])
  })

  describe("a registration", () => {
    const registration = () => mapLoan(bureauInput({ kind: "DAILY", dataFlag: "R", asOf: at("2026-08-15"), settlementCents: 550_000 })).fields

    it("passes when clean", () => {
      expect(validateRecord(registration())).toEqual([])
    })
    it("is held when it carries a status", () => {
      expect(validateRecord({ ...registration(), statusCode: "C", statusDate: "20260815", currentBalance: "0", instalment: "0" }))
        .toEqual(["REGISTRATION_WITH_STATUS"])
    })
    it("is held when the balance is in credit", () => {
      expect(validateRecord({ ...registration(), currentBalanceIndicator: "C" })).toEqual(["REGISTRATION_IN_CREDIT"])
    })
    it("is held when it carries a last payment date", () => {
      expect(validateRecord({ ...registration(), lastPaymentDate: "20260815" })).toEqual(["REGISTRATION_WITH_LAST_PAYMENT"])
    })
  })

  it("reports every rule a record breaks", () => {
    expect(validateRecord({ ...good(), surname: "X", forename1: "", openingBalance: "0" }))
      .toEqual(["INVALID_SURNAME", "MISSING_FORENAME", "ZERO_OPENING_BALANCE"])
  })
})

describe("recordHolds", () => {
  it("holds a record whose value is too wide for its field instead of letting it break the file", () => {
    const { fields } = mapLoan(bureauInput({ client: { monthlyIncome: 100_000_000_000_00 } }))
    expect(validateRecord(fields)).toEqual([])
    expect(() => renderRecord(fields, "MONTHLY")).toThrow(/income/)
    expect(recordHolds(fields, "MONTHLY")).toEqual(["UNRENDERABLE"])
  })

  it("adds nothing to a clean record, and does not double-report a bad account number", () => {
    expect(recordHolds(good(), "MONTHLY")).toEqual([])
    expect(recordHolds({ ...good(), accountNumber: "A".repeat(26) }, "MONTHLY")).toEqual(["INVALID_ACCOUNT_NUMBER"])
  })
})

describe("validateFile", () => {
  const record = (reference: string) => renderRecord(mapLoan(bureauInput({ loan: { reference } })).fields, "MONTHLY")
  const header = renderHeader({ supplierNumber: "TT0109", monthEndDate: "20260930", creationDate: "20261001", tradingName: "Acme" })
  const monthly = (records: string[]) => [header, ...records, renderTrailer(records.length + 2)]
  const dailyLine = (reference: string, dataFlag: "R" | "C" = "R") =>
    renderRecord(mapLoan(bureauInput({ kind: "DAILY", dataFlag, loan: { reference } })).fields, "DAILY")

  it("passes a well-formed monthly file", () => {
    expect(validateFile("MONTHLY", monthly([record("LN-1"), record("LN-2")]), "TT0109")).toEqual([])
  })

  it("passes a well-formed daily file, and one that registers and closes the same account", () => {
    expect(validateFile("DAILY", [dailyLine("LN-1"), dailyLine("LN-1", "C")], "TT0109")).toEqual([])
  })

  it("blocks a monthly line that is not exactly 700 characters", () => {
    expect(validateFile("MONTHLY", monthly([record("LN-1"), `${record("LN-2")} `]), "TT0109")).toContain("WRONG_LINE_LENGTH")
  })

  it("blocks a daily line that is not exactly 718 characters", () => {
    expect(validateFile("DAILY", [record("LN-1")], "TT0109")).toContain("WRONG_LINE_LENGTH")
  })

  it("blocks a trailer whose count is not the number of lines", () => {
    const lines = [header, record("LN-1"), renderTrailer(2)]
    expect(validateFile("MONTHLY", lines, "TT0109")).toEqual(["TRAILER_COUNT_MISMATCH"])
  })

  it("blocks a monthly file with no header or no trailer", () => {
    expect(validateFile("MONTHLY", [record("LN-1"), renderTrailer(2)], "TT0109")).toContain("MISSING_HEADER_OR_TRAILER")
    expect(validateFile("MONTHLY", [header, record("LN-1")], "TT0109")).toContain("MISSING_HEADER_OR_TRAILER")
  })

  it("blocks a line carrying a CR, LF or other non-printable character", () => {
    const forged = `${header.slice(0, 40)}\r\nT000000002${header.slice(52)}`
    expect(forged).toHaveLength(700)
    expect(validateFile("MONTHLY", [forged, record("LN-1"), renderTrailer(3)], "TT0109")).toEqual(["NON_PRINTABLE_CHARACTER"])
    const accented = `${record("LN-1").slice(0, 80)}É${record("LN-1").slice(81)}`
    expect(validateFile("MONTHLY", monthly([accented]), "TT0109")).toEqual(["NON_PRINTABLE_CHARACTER"])
  })

  it("blocks a missing supplier number", () => {
    expect(validateFile("MONTHLY", monthly([record("LN-1")]), "")).toEqual(["MISSING_SUPPLIER_NUMBER"])
    expect(validateFile("MONTHLY", monthly([record("LN-1")]), null)).toEqual(["MISSING_SUPPLIER_NUMBER"])
  })

  it("blocks a header on a daily file", () => {
    expect(validateFile("DAILY", [header.padEnd(718, " "), dailyLine("LN-1")], "TT0109")).toEqual(["HEADER_ON_DAILY_FILE"])
  })

  it("blocks a duplicate account number", () => {
    expect(validateFile("MONTHLY", monthly([record("LN-1"), record("LN-1")]), "TT0109")).toEqual(["DUPLICATE_ACCOUNT_NUMBER"])
    expect(validateFile("DAILY", [dailyLine("LN-1"), dailyLine("LN-1")], "TT0109")).toEqual(["DUPLICATE_ACCOUNT_NUMBER"])
  })
})
