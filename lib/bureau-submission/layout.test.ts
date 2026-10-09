import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  CRLF,
  DAILY_LENGTH,
  MONTHLY_FIELDS,
  MONTHLY_LENGTH,
  bureauFileName,
  parseHeader,
  parseRecord,
  parseTrailer,
  renderFile,
  renderHeader,
  renderRecord,
  renderTrailer,
} from "./layout"

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, "__fixtures__", name), "latin1")

/** Lines of a fixture, asserting every line (the last included) ends CRLF. */
function fixtureLines(name: string): string[] {
  const text = fixture(name)
  expect(text.endsWith(CRLF)).toBe(true)
  return text.slice(0, -CRLF.length).split(CRLF)
}

describe("field table", () => {
  it("has 56 contiguous fields covering 1-700", () => {
    expect(MONTHLY_FIELDS).toHaveLength(56)
    let next = 1
    for (const field of MONTHLY_FIELDS) {
      expect(field.start, field.name).toBe(next)
      next = field.end + 1
    }
    expect(next - 1).toBe(MONTHLY_LENGTH)
  })
})

describe("Experian's monthly sample", () => {
  const lines = fixtureLines("experian-sample-monthly.txt")

  it("has every line exactly 700 characters", () => {
    expect(lines).toHaveLength(18)
    for (const line of lines) expect(line).toHaveLength(MONTHLY_LENGTH)
  })

  it("parses the header at the spec positions", () => {
    expect(parseHeader(lines[0])).toEqual({
      recordType: "H",
      supplierNumber: "TT0109",
      monthEndDate: "20230302",
      version: "06",
      creationDate: "20230302",
      tradingName: "TT0109",
    })
  })

  it("parses a data record at the spec positions", () => {
    const first = parseRecord(lines[1], "MONTHLY")
    expect(first.dataFlag).toBe("D")
    expect(first.saIdNumber).toBe("8810145000083")
    expect(first.gender).toBe("M")
    expect(first.dateOfBirth).toBe("19881014")
    expect(first.accountNumber).toBe("55")
    expect(first.accountType).toBe("M")
    expect(first.dateOpened).toBe("20230302")
    expect(first.openingBalance).toBe("000001000")
    expect(first.currentBalance).toBe("000001009")
    expect(first.currentBalanceIndicator).toBe("D")
    expect(first.instalment).toBe("000001026")
    expect(first.monthsInArrears).toBe("00")
    expect(first.repaymentFrequency).toBe("03")
    expect(first.terms).toBe("0001")
    expect(first.employer).toBe("Oscorp")

    const handedOver = parseRecord(lines[3], "MONTHLY")
    expect(handedOver.statusCode).toBe("L")
    expect(handedOver.statusDate).toBe("20230302")
    const closed = parseRecord(lines[9], "MONTHLY")
    expect(closed.statusCode).toBe("C")
    expect(closed.currentBalance).toBe("000000000")
    expect(closed.cellPhone).toBe("+27912345678")
  })

  it("has a trailer counting every line, header and trailer included", () => {
    expect(parseTrailer(lines[17])).toEqual({ recordType: "T", recordCount: 18 })
  })
})

describe("Experian's daily sample", () => {
  const lines = fixtureLines("experian-sample-daily.txt")

  it("has every line exactly 718 characters and no header or trailer", () => {
    expect(lines).toHaveLength(14)
    for (const line of lines) {
      expect(line).toHaveLength(DAILY_LENGTH)
      expect(["R", "C"]).toContain(line[0])
    }
  })

  it("carries the supplier number at 701-710 and transaction date at 711-718", () => {
    const first = parseRecord(lines[0], "DAILY")
    expect(first.dataFlag).toBe("R")
    expect(first.supplierNumber).toBe("TT0109")
    expect(first.transactionDate).toBe("20230302")
    expect(first.accountNumber).toBe("55")

    const closure = parseRecord(lines[8], "DAILY")
    expect(closure.dataFlag).toBe("C")
    expect(closure.statusCode).toBe("C")
    expect(closure.statusDate).toBe("20230302")
  })
})

const RECORD = {
  dataFlag: "D",
  saIdNumber: "8810145000083",
  gender: "M",
  dateOfBirth: "19881014",
  accountNumber: "ln-abc-1234",
  surname: "van der Merwe",
  forename1: "Sue Ann",
  addressLine1: "12 Main Road",
  postalCode: "7133",
  ownershipType: "00",
  loanReason: "O",
  paymentType: "00",
  accountType: "P",
  dateOpened: "20260105",
  openingBalance: "5000",
  currentBalance: "3250",
  currentBalanceIndicator: "D",
  amountOverdue: "0",
  instalment: "1100",
  monthsInArrears: "0",
  repaymentFrequency: "3",
  terms: "6",
  cellPhone: "0821234567",
}

describe("renderRecord", () => {
  const line = renderRecord(RECORD, "MONTHLY")

  it("renders exactly 700 characters", () => {
    expect(line).toHaveLength(MONTHLY_LENGTH)
  })

  it("left-justifies and space-fills alpha, upper-cased", () => {
    expect(line.slice(76, 101)).toBe("VAN DER MERWE".padEnd(25, " "))
    expect(line.slice(106, 120)).toBe("SUE ANN".padEnd(14, " "))
  })

  it("right-justifies and zero-fills numeric", () => {
    expect(line.slice(393, 402)).toBe("000005000")
    expect(line.slice(430, 432)).toBe("00")
    expect(line.slice(434, 436)).toBe("03")
    expect(line.slice(436, 440)).toBe("0006")
  })

  it("right-justifies and space-fills account number, postcode and phone", () => {
    expect(line.slice(47, 72)).toBe("LN-ABC-1234".padStart(25, " "))
    expect(line.slice(248, 254)).toBe("  7133")
    expect(line.slice(511, 527)).toBe("0821234567".padStart(16, " "))
  })

  it("renders an absent date as zeros and an absent alpha as spaces", () => {
    expect(line.slice(385, 393)).toBe("00000000") // last payment
    expect(line.slice(440, 448)).toBe("00000000") // status date
    expect(line.slice(432, 434)).toBe("  ") // status code
    expect(line.slice(39, 47)).toBe(" ".repeat(8)) // branch code
  })

  it("round-trips through parseRecord", () => {
    const parsed = parseRecord(line, "MONTHLY")
    expect(renderRecord(parsed, "MONTHLY")).toBe(line)
    expect(parsed.surname).toBe("VAN DER MERWE")
    expect(parsed.accountNumber).toBe("LN-ABC-1234")
    expect(parsed.currentBalance).toBe("000003250")
  })

  it("renders the daily tail to 718 with a right-justified supplier number", () => {
    const daily = renderRecord(
      { ...RECORD, dataFlag: "R", supplierNumber: "TT0109", transactionDate: "20260105" },
      "DAILY",
    )
    expect(daily).toHaveLength(DAILY_LENGTH)
    expect(daily.slice(0, 698)).toBe(`R${line.slice(1, 698)}`)
    expect(daily.slice(698, 700)).toBe("  ")
    expect(daily.slice(700, 710)).toBe("    TT0109")
    expect(daily.slice(710, 718)).toBe("20260105")
    expect(renderRecord(parseRecord(daily, "DAILY"), "DAILY")).toBe(daily)
  })

  it("refuses a numeric value that is not digits or overflows its field", () => {
    expect(() => renderRecord({ ...RECORD, currentBalance: "12.50" }, "MONTHLY")).toThrow(/currentBalance/)
    expect(() => renderRecord({ ...RECORD, monthsInArrears: "100" }, "MONTHLY")).toThrow(/monthsInArrears/)
  })

  it("refuses a date that is not CCYYMMDD", () => {
    expect(() => renderRecord({ ...RECORD, dateOpened: "2026-01-05" }, "MONTHLY")).toThrow(/dateOpened/)
  })

  it("refuses an account number that would be truncated", () => {
    expect(() => renderRecord({ ...RECORD, accountNumber: "A".repeat(26) }, "MONTHLY")).toThrow(/accountNumber/)
  })

  it("refuses a field name the layout does not have", () => {
    expect(() => renderRecord({ ...RECORD, nonsense: "1" }, "MONTHLY")).toThrow(/nonsense/)
  })
})

describe("header and trailer", () => {
  const header = renderHeader({
    supplierNumber: "tt0109",
    monthEndDate: "20260930",
    creationDate: "20261001",
    tradingName: "Acme Lending",
  })

  it("renders the header at the spec positions", () => {
    expect(header).toHaveLength(MONTHLY_LENGTH)
    expect(header.slice(0, 1)).toBe("H")
    expect(header.slice(1, 11)).toBe("    TT0109")
    expect(header.slice(11, 19)).toBe("20260930")
    expect(header.slice(19, 21)).toBe("06")
    expect(header.slice(21, 29)).toBe("20261001")
    expect(header.slice(29, 89)).toBe("ACME LENDING".padEnd(60, " "))
    expect(header.slice(89)).toBe(" ".repeat(611))
  })

  it("renders a 9-digit zero-filled trailer count", () => {
    const trailer = renderTrailer(18)
    expect(trailer).toHaveLength(MONTHLY_LENGTH)
    expect(trailer.slice(0, 10)).toBe("T000000018")
    expect(trailer.slice(10)).toBe(" ".repeat(690))
    expect(parseTrailer(trailer).recordCount).toBe(18)
  })
})

describe("renderFile", () => {
  it("ends every line with CRLF, the last included", () => {
    expect(renderFile(["A", "B"])).toBe("A\r\nB\r\n")
  })
})

describe("bureauFileName", () => {
  it("builds the hub file name", () => {
    expect(bureauFileName({ supplierNumber: "tt0109", mode: "TEST", kind: "MONTHLY", date: "20260930", sequence: 1 }))
      .toBe("TT0109_ALL_T702_M_20260930_1_1")
    expect(bureauFileName({ supplierNumber: "TT0109", mode: "LIVE", kind: "DAILY", date: "20261001", sequence: 2 }))
      .toBe("TT0109_ALL_L702_D_20261001_1_2")
  })
})
