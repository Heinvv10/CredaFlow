import { beforeEach, describe, it, expect, vi } from "vitest"
import { inflateSync } from "zlib"

vi.mock("./helpers", async () => {
  const actual = await vi.importActual<typeof import("./helpers")>("./helpers")
  return {
    ...actual,
    drawTableRow: vi.fn(actual.drawTableRow),
  }
})

import { drawTableRow } from "./helpers"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { activePaymentTotalCents, generateStatementPdf } from "./statement"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("activePaymentTotalCents", () => {
  it("excludes reversed/voided payments from the statement total", () => {
    const payments = [
      { amount: 292745, reversed: false },
      { amount: 292745, reversed: true }, // voided — must NOT count
      { amount: 100000 }, // undefined reversed → treated as active
    ]
    // Only 292745 + 100000; the reversed 292745 is excluded.
    expect(activePaymentTotalCents(payments)).toBe(392745)
  })

  it("returns 0 when every payment is reversed", () => {
    expect(
      activePaymentTotalCents([
        { amount: 500, reversed: true },
        { amount: 100, reversed: true },
      ]),
    ).toBe(0)
  })

  it("does not count unapplied or refunded receipts as loan repayments", () => {
    expect(
      activePaymentTotalCents([
        { amount: 25_000, allocationStatus: "ALLOCATED" },
        { amount: 50_000, allocationStatus: "UNAPPLIED" },
        { amount: 20_000, allocationStatus: "REFUNDED" },
      ]),
    ).toBe(25_000)
  })

  it("returns 0 for no payments", () => {
    expect(activePaymentTotalCents([])).toBe(0)
  })

  it("does not count a waived balance as a payment", () => {
    expect(
      activePaymentTotalCents([
        { amount: 596_800, paymentMethod: "EFT" },
        { amount: 75, paymentMethod: "WAIVER" },
      ]),
    ).toBe(596_800)
  })
})

describe("generateStatementPdf payment history", () => {
  it("renders running balances from total repayable, not principal", async () => {
    await generateStatementPdf({
      lender: { legalName: ACME_LENDER.legalName, ncrNumber: ACME_LENDER.ncrNumber },
      client: {
        firstName: "Synthetic",
        lastName: "Customer",
        idNumber: "9001015009087",
        email: "synthetic@example.test",
      },
      loan: {
        id: "loan-test",
        reference: "LN-TEST",
        principal: 500_000,
        totalRepayable: 633_496,
        totalPaid: 633_496,
        outstandingPrincipal: 0,
        interestRatePm: 0.05,
        interestModel: "DAILY_ACCRUAL",
        status: "PAID_UP",
        startDate: new Date(2026, 0, 1),
        maturityDate: new Date(2026, 2, 1),
        daysInArrears: 0,
        arrearsAmount: 0,
      },
      product: { name: "Synthetic test product" },
      schedule: [],
      payments: [
        {
          createdAt: new Date(2026, 0, 2),
          amount: 266_165,
          paymentMethod: "EFT",
          reference: "PAY-1",
        },
        {
          createdAt: new Date(2026, 1, 2),
          amount: 266_165,
          paymentMethod: "EFT",
          reference: "PAY-2",
        },
        {
          createdAt: new Date(2026, 2, 2),
          amount: 101_166,
          paymentMethod: "EFT",
          reference: "PAY-3",
        },
      ],
      statementDate: new Date(2026, 2, 3),
    })

    const paymentRows = vi.mocked(drawTableRow).mock.calls
      .map((call) => call[2])
      .filter((columns) => columns.some((column) => column.text.startsWith("PAY-")))

    expect(paymentRows.map((columns) => columns.at(-1)?.text)).toEqual([
      "R 3,673.31",
      "R 1,011.66",
      "R 0.00",
    ])
  })

  it("shows a waived balance as 'Balance waived', reducing the balance but not the payments total", async () => {
    await generateStatementPdf({
      lender: { legalName: ACME_LENDER.legalName, ncrNumber: ACME_LENDER.ncrNumber },
      client: { firstName: "Synthetic", lastName: "Customer", idNumber: "9001015009087", email: "synthetic@example.test" },
      loan: {
        id: "loan-test", reference: "LN-TEST", principal: 500_000, totalRepayable: 596_875,
        totalPaid: 596_875, outstandingPrincipal: 0, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL",
        status: "COMPLETED", startDate: new Date(2026, 7, 1), maturityDate: new Date(2026, 8, 1),
        daysInArrears: 0, arrearsAmount: 0,
      },
      product: { name: "Synthetic test product" },
      schedule: [],
      payments: [
        { createdAt: new Date(2026, 8, 25), amount: 596_800, paymentMethod: "EFT", reference: "PAY-1" },
        { createdAt: new Date(2026, 8, 26), amount: 75, paymentMethod: "WAIVER", reference: "WAIVE-1" },
      ],
      statementDate: new Date(2026, 8, 27),
    })
    const rows = vi.mocked(drawTableRow).mock.calls.map((call) => call[2])
    const waiver = rows.find((columns) => columns.some((column) => column.text === "WAIVE-1"))!
    expect(waiver.map((column) => column.text)).toContain("Balance waived")
    expect(waiver.at(-1)?.text).toBe("R 0.00")
    const total = rows.find((columns) => columns[0]?.text === "TOTAL")!
    expect(total[1].text).toBe("R 5,968.00")
  })

  it("shows default charges as dated debit rows in the running balance, and totals payments separately from charges", async () => {
    await generateStatementPdf({
      ...statementInput(0.05, "FLAT"),
      loan: { ...statementInput(0.05, "FLAT").loan, totalRepayable: 216_900 },
      payments: [
        { createdAt: new Date("2026-09-11T10:00:00+02:00"), amount: 50_000, paymentMethod: "EFT", reference: "PAY-1" },
      ],
      charges: {
        postings: [
          { type: "DEFAULT_INTEREST", day: "2026-09-10", amount: 3_000 },
          { type: "DEFAULT_ADMIN", day: "2026-09-12", amount: 8_200, sourceId: "s129-1" },
        ],
        outstanding: 8_200,
        settlement: 175_100,
      },
    })
    const rows = vi.mocked(drawTableRow).mock.calls.map((call) => call[2])
    const texts = (columns: { text: string }[]) => columns.map((column) => column.text)
    const interest = rows.find((columns) => columns[2]?.text === "Default interest")!
    const payment = rows.find((columns) => columns.some((column) => column.text === "PAY-1"))!
    const letter = rows.find((columns) => columns[2]?.text === "Collection letter fee")!
    // 2169.00 + 30.00 charge = 2199.00; less 500.00 = 1699.00; + 82.00 = 1781.00.
    expect(texts(interest)).toEqual(["10 September 2026", "R 30.00", "Default interest", "Charge", "R 2,199.00"])
    expect(payment.at(-1)?.text).toBe("R 1,699.00")
    expect(texts(letter)).toEqual(["12 September 2026", "R 82.00", "Collection letter fee", "Charge", "R 1,781.00"])
    expect(texts(rows.find((columns) => columns[0]?.text === "TOTAL PAID")!).slice(0, 2)).toEqual(["TOTAL PAID", "R 500.00"])
    expect(texts(rows.find((columns) => columns[0]?.text === "TOTAL CHARGES")!).slice(0, 2)).toEqual(["TOTAL CHARGES", "R 112.00"])
  })

  it("with charges not live, a receipt reduces the balance by its schedule share and shows the part that paid charges", async () => {
    // Stopped after a R500 receipt paid R80 of default interest: settlement is R2,169 - R420.
    await generateStatementPdf({
      ...statementInput(0.05, "FLAT"),
      loan: { ...statementInput(0.05, "FLAT").loan, totalRepayable: 216_900 },
      payments: [{
        createdAt: new Date("2026-09-11T10:00:00+02:00"), amount: 50_000, paymentMethod: "EFT", reference: "PAY-1",
        defaultInterestAllocated: 8_000, chargeFeesAllocated: 0,
      }],
    })
    const rows = vi.mocked(drawTableRow).mock.calls.map((call) => call[2])
    const index = rows.findIndex((columns) => columns.some((column) => column.text === "PAY-1"))
    expect(rows[index].at(-1)?.text).toBe("R 1,749.00")
    expect(rows[index + 1].map((column) => column.text)).toContain("of which R 80.00 default charges")
  })

  it("adds cash received, charges owing and the amount to settle to the account summary", async () => {
    const text = extractPdfContent(await generateStatementPdf({
      ...statementInput(0.05, "FLAT"),
      payments: [
        { createdAt: new Date("2026-09-11T10:00:00+02:00"), amount: 50_000, paymentMethod: "EFT", reference: "PAY-1" },
        { createdAt: new Date("2026-09-12T10:00:00+02:00"), amount: 75, paymentMethod: "WAIVER", reference: "W-1" },
      ],
      charges: { postings: [{ type: "DEFAULT_INTEREST", day: "2026-09-10", amount: 3_000 }], outstanding: 8_200, settlement: 175_100 },
    } as never))
    // Total paid is cash (R500, the R0.75 waiver excluded); the instalment share
    // is labelled as such.
    expect(text).toContain(pdfHex("Total Paid to Date"))
    expect(text).toContain(pdfHex("R 500.00"))
    expect(text).toContain(pdfHex("Applied to Instalments"))
    expect(text).toContain(pdfHex("Default Charges Owing"))
    expect(text).toContain(pdfHex("R 82.00"))
    expect(text).toContain(pdfHex("Amount to Settle Today"))
    expect(text).toContain(pdfHex("R 1,751.00"))
  })

  it("labels held/refunded money and does not show it reducing the balance", async () => {
    await generateStatementPdf({
      ...statementInput(0.05, "FLAT"),
      payments: [
        {
          createdAt: new Date("2026-07-23"),
          amount: 25_000,
          paymentMethod: "EFT",
          reference: "ALLOCATED-1",
          allocationStatus: "ALLOCATED",
        },
        {
          createdAt: new Date("2026-07-24"),
          amount: 50_000,
          paymentMethod: "EFT",
          reference: "UNAPPLIED-1",
          allocationStatus: "UNAPPLIED",
        },
        {
          createdAt: new Date("2026-07-25"),
          amount: 20_000,
          paymentMethod: "EFT",
          reference: "REFUNDED-1",
          allocationStatus: "REFUNDED",
        },
      ],
    })

    const rows = vi.mocked(drawTableRow).mock.calls
      .map((call) => call[2])
    const byReference = (reference: string) =>
      rows.find((columns) => columns.some((column) => column.text === reference))

    expect(byReference("ALLOCATED-1")?.[2].text).toBe("EFT")
    expect(byReference("ALLOCATED-1")?.at(-1)?.text).not.toBe("—")
    expect(byReference("UNAPPLIED-1")?.[2].text).toBe("EFT / Unapplied")
    expect(byReference("UNAPPLIED-1")?.at(-1)?.text).toBe("—")
    expect(byReference("REFUNDED-1")?.[2].text).toBe("EFT / Refunded")
    expect(byReference("REFUNDED-1")?.at(-1)?.text).toBe("—")
  })
})

// The statement's interest-rate line is a consumer disclosure, so assert it on a
// RENDERED statement rather than trusting the wiring. It must follow the
// product's interest model: compounded for REDUCING_BALANCE, simple for the
// short-term models whose interest is never capitalised.
//
// pdf-lib embeds text as HEX inside FlateDecode content streams, so the same
// extract + pdfHex pattern as lib/pdf/__tests__/creditAgreement.test.ts is used.
function extractPdfContent(buf: Buffer): string {
  const parts: string[] = []
  let i = 0
  while (i < buf.length - 6) {
    if (buf.subarray(i, i + 6).toString("ascii") === "stream") {
      let start = i + 6
      while (start < buf.length && (buf[start] === 13 || buf[start] === 10)) start++
      const end = buf.indexOf(Buffer.from("endstream"), start)
      if (end > start && end - start < 200_000) {
        const streamData = buf.subarray(start, end)
        try {
          parts.push(inflateSync(streamData).toString("latin1"))
        } catch {
          parts.push(streamData.toString("latin1"))
        }
      }
      i = end > i ? end + 9 : i + 1
    } else {
      i++
    }
  }
  return parts.join("\n")
}
const pdfHex = (s: string) => Buffer.from(s, "ascii").toString("hex").toUpperCase()

function statementInput(interestRatePm: number, interestModel: string) {
  return {
    lender: { legalName: ACME_LENDER.legalName, ncrNumber: ACME_LENDER.ncrNumber },
    client: { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000080", email: "t@example.com", addressLine1: "45 Oak Ave", city: "Soweto" },
    loan: {
      id: "l1", reference: "LN-TEST-0001", principal: 1_000_000, totalRepayable: 1_256_986,
      totalPaid: 0, outstandingPrincipal: 1_000_000, interestRatePm, interestModel,
      status: "ACTIVE", startDate: new Date("2026-07-22"), maturityDate: new Date("2027-01-22"),
      daysInArrears: 0, arrearsAmount: 0,
    },
    product: { name: "Personal Loan" },
    schedule: [{ installmentNo: 1, dueDate: new Date("2026-08-22"), totalDue: 299498, totalPaid: 0, status: "PENDING" }],
    payments: [],
    statementDate: new Date("2026-07-22"),
  }
}

async function statementText(interestRatePm: number, interestModel: string): Promise<string> {
  return extractPdfContent(await generateStatementPdf(statementInput(interestRatePm, interestModel) as never))
}

describe("statement interest-rate disclosure is nominal for every model", () => {
  it("REDUCING_BALANCE is the nominal rate x 12, not the effective 42.6%", async () => {
    const text = await statementText(0.03, "REDUCING_BALANCE")
    expect(text).toContain(pdfHex("3.00% per month"))
    expect(text).toContain(pdfHex("36.0%"))
    expect(text).toContain(pdfHex("nominal"))
    expect(text).not.toContain(pdfHex("42.6%"))
  })

  it("FLAT annualises the daily rate — NOT the compounded 79.6%", async () => {
    const text = await statementText(0.05, "FLAT")
    expect(text).toContain(pdfHex("5.00% per month"))
    expect(text).toContain(pdfHex("60.8%"))
    expect(text).toContain(pdfHex("nominal"))
    expect(text).not.toContain(pdfHex("79.6%"))
  })

  it("DAILY_ACCRUAL matches FLAT — neither capitalises interest", async () => {
    const text = await statementText(0.05, "DAILY_ACCRUAL")
    expect(text).toContain(pdfHex("60.8%"))
    expect(text).not.toContain(pdfHex("79.6%"))
  })
})

describe("an entity borrower's statement (asset finance)", () => {
  const { client: _consumer, ...base } = statementInput(0.01, "REDUCING_BALANCE")
  const entity = { legalName: "TEST Earthmoving (Pty) Ltd", registrationNumber: "2020/000001/07", address: "9 Test Yard, Testville, 0002" }

  it("prints the entity as the borrower: legal name, registration number, address, and no consumer block", async () => {
    const text = extractPdfContent(await generateStatementPdf({ ...base, entity }))
    expect(text).toContain(pdfHex("BORROWER DETAILS"))
    expect(text).toContain(pdfHex("TEST Earthmoving (Pty) Ltd"))
    expect(text).toContain(pdfHex("2020/000001/07"))
    expect(text).toContain(pdfHex("9 Test Yard, Testville, 0002"))
    expect(text).not.toContain(pdfHex("CLIENT DETAILS"))
    expect(text).not.toContain(pdfHex("ID Number"))
  })

  it("omits the address row when none is on file", async () => {
    const text = extractPdfContent(await generateStatementPdf({ ...base, entity: { ...entity, address: undefined } }))
    expect(text).toContain(pdfHex("Registration Number"))
    expect(text).not.toContain(pdfHex("Address"))
  })

  it("a consumer statement still prints the client block", async () => {
    const text = await statementText(0.01, "REDUCING_BALANCE")
    expect(text).toContain(pdfHex("CLIENT DETAILS"))
    expect(text).not.toContain(pdfHex("BORROWER DETAILS"))
  })
})
