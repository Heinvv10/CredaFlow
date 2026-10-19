import { createHash } from "node:crypto"
import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { CONTENT_WIDTH, MARGIN } from "./helpers"
import { generateDebitMandatePdf, wrapTextToWidth } from "./debitMandate"
import { LenderIdentityError } from "@/lib/config/identity-schema"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const fixture = {
  lender: {
    ...ACME_LENDER,
    registeredOfficeLines: [
      "Office 2001A - Main Road Centre",
      "CNR First and Second Avenue",
      "Sandton Central, Sandton",
      "2196",
    ],
  },
  creditorBank: {
    bankName: "Provider Bank",
    accountNumber: "9876543210",
    branchCode: "250655",
  },
  client: {
    firstName: "Synthetic",
    lastName: "Customer",
    idNumber: "9001015009087",
    phone: "0820000000",
    email: "synthetic@example.test",
    bankName: "Test Bank",
    branchCode: "000001",
    accountNumber: "1234567890",
    accountType: "CHEQUE" as const,
  },
  loan: {
    reference: "LN-TEST-1",
    paymentFrequency: "MONTHLY" as const,
    recurringDebitAmount: 232_945,
    firstDebitAmount: 266_165,
    firstDebitInitiationFee: 33_220,
    firstDebitDate: new Date("2026-08-01T00:00:00.000Z"),
    repaymentDayOfMonth: 1,
  },
  generatedAt: new Date("2026-07-22T08:00:00.000Z"),
}

function extractPdfContent(buf: Buffer): string {
  const parts: string[] = []
  let index = 0
  while (index < buf.length - 6) {
    if (buf.subarray(index, index + 6).toString("ascii") === "stream") {
      let start = index + 6
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
      index = end > index ? end + 9 : index + 1
    } else {
      index++
    }
  }
  return parts.join("\n")
}

const pdfHex = (value: string) => Buffer.from(value, "ascii").toString("hex").toUpperCase()

function textBaseline(content: string, value: string): number {
  const markerIndex = content.indexOf(pdfHex(value))
  if (markerIndex < 0) throw new Error(`PDF text not found: ${value}`)
  const matrices = [...content.slice(Math.max(0, markerIndex - 300), markerIndex)
    .matchAll(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm/g)]
  const y = Number(matrices.at(-1)?.[1])
  if (!Number.isFinite(y)) throw new Error(`PDF baseline not found: ${value}`)
  return y
}

function textRuns(content: string): { text: string; x: number; y: number }[] {
  return [...content.matchAll(
    /1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\s*<([0-9A-F]+)> Tj/g,
  )].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
    text: Buffer.from(match[3], "hex").toString("ascii"),
  }))
}

describe("generateDebitMandatePdf", () => {
  it("renders the recurring and fee-loaded first debits as distinct amounts", async () => {
    const pdf = await generateDebitMandatePdf(fixture)
    const content = extractPdfContent(pdf)

    expect(content).toContain(pdfHex("Regular Recurring Debit"))
    expect(content).toContain(pdfHex("R 2,329.45"))
    expect(content).toContain(pdfHex("First Debit Amount"))
    expect(content).toContain(pdfHex("R 2,661.65"))
    expect(content).toContain(pdfHex("Initiation Fee Included in First Debit"))
    expect(content).toContain(pdfHex("R 332.20"))
    expect(content).toContain(pdfHex("R 2,329.45 per month"))
    expect(content).not.toContain(pdfHex("R 2,661.65 per month"))
  })

  it("prints the debit day when every debit shares one, and points at the schedule otherwise", async () => {
    const withDay = extractPdfContent(await generateDebitMandatePdf({ ...fixture, loan: { ...fixture.loan, repaymentDayOfMonth: 19 } }))
    expect(withDay).toContain(pdfHex("Debit Day of Month:"))
    expect(withDay).not.toContain(pdfHex("As per repayment schedule"))

    const { repaymentDayOfMonth: _omitted, ...loanWithoutDay } = fixture.loan
    const withoutDay = extractPdfContent(await generateDebitMandatePdf({ ...fixture, loan: loanWithoutDay }))
    expect(withoutDay).toContain(pdfHex("As per repayment schedule"))
  })

  it("populates the consumer banking fields and marks every unsigned output as draft", async () => {
    const pdf = await generateDebitMandatePdf(fixture)
    const content = extractPdfContent(pdf)

    expect(content).toContain(pdfHex("DRAFT - NOT AUTHORISED"))
    expect(content).toContain(pdfHex("DRAFT - NOT SIGNED"))
    expect(content).toContain(pdfHex("Test Bank"))
    expect(content).toContain(pdfHex("000001"))
    expect(content).toContain(pdfHex("1234567890"))
    expect(content).toContain(pdfHex("Cheque / Current"))
    expect(content).toContain(pdfHex(ACME_LENDER.legalName))
    expect(content).toContain(pdfHex(ACME_LENDER.ncrNumber))
    expect(content).toContain(pdfHex("Office 2001A - Main Road Centre"))
    expect(content).not.toContain(pdfHex("_______________________________________________"))
  })

  it("names each account type exactly, never defaulting to the other", async () => {
    // The label was once a two-way ternary, so anything not CHEQUE printed as
    // "Savings" — a false statement about the consumer's account on the
    // mandate their bank acts on. TRANSMISSION is retired, so the
    // two remaining types must still each print their own name.
    const cheque = extractPdfContent(await generateDebitMandatePdf({
      ...fixture, client: { ...fixture.client, accountType: "CHEQUE" as const },
    }))
    expect(cheque).toContain(pdfHex("Cheque"))
    expect(cheque).not.toContain(pdfHex("Savings"))

    const savings = extractPdfContent(await generateDebitMandatePdf({
      ...fixture, client: { ...fixture.client, accountType: "SAVINGS" as const },
    }))
    expect(savings).toContain(pdfHex("Savings"))
    expect(savings).not.toContain(pdfHex("Cheque"))
  })

  it("renders a signed portal authority without a draft watermark", async () => {
    const pdf = await generateDebitMandatePdf({
      ...fixture,
      authorization: {
        signedAt: new Date("2026-07-23T12:05:00.000Z"),
        method: "portal",
        signature: "Synthetic Customer",
        signatureSha256: "a".repeat(64),
        evidenceSha256: "b".repeat(64),
        sourceDocumentSha256: "c".repeat(64),
      },
    })
    const content = extractPdfContent(pdf)

    expect(content).toContain(pdfHex("SIGNED ELECTRONICALLY"))
    expect(content).toContain(pdfHex("Synthetic Customer"))
    expect(content).toContain(pdfHex("Electronic evidence: aaaaaaaaaaaaaaaa..."))
    expect(content).not.toContain(pdfHex("DRAFT - NOT AUTHORISED"))
    expect(content).not.toContain(pdfHex("DRAFT - NOT SIGNED"))
  })

  it("renders a bullet schedule as once-off and never as recurring monthly", async () => {
    const pdf = await generateDebitMandatePdf({
      ...fixture,
      loan: {
        ...fixture.loan,
        paymentFrequency: "ONCE_OFF",
        recurringDebitAmount: null,
        firstDebitAmount: 633_496,
        firstDebitInitiationFee: 57_500,
      },
    })
    const content = extractPdfContent(pdf)

    expect(content).toContain(pdfHex("once-off debit of R 6,334.96"))
    expect(content).toContain(pdfHex("Once-Off Debit Amount"))
    expect(content).toContain(pdfHex("Once-off"))
    expect(content).not.toContain(pdfHex("Regular Recurring Debit"))
    expect(content).not.toContain(pdfHex("per month"))
  })

  it("fails loudly when the registered creditor identity is incomplete", async () => {
    await expect(generateDebitMandatePdf({
      ...fixture,
      lender: { ...fixture.lender, registeredOfficeLines: [] },
    })).rejects.toBeInstanceOf(LenderIdentityError)
  })

  it("falls back to a text-only header without overlapping lines when no logo is passed", async () => {
    const pdf = await generateDebitMandatePdf(fixture)
    const content = extractPdfContent(pdf)
    const runs = textRuns(content)

    const nameRun = runs.find((r) => r.text === fixture.lender.legalName)
    const ncrRun = runs.find((r) => r.text === `NCR Reg: ${fixture.lender.ncrNumber}`)
    expect(nameRun).toBeDefined()
    expect(ncrRun).toBeDefined()
    // The regression this guards: both lines must NOT share the same (x, y) —
    // that renders one on top of the other, illegible, when the chip-based
    // header can't be drawn because there is no logo.
    expect(`${nameRun!.x},${nameRun!.y}`).not.toBe(`${ncrRun!.x},${ncrRun!.y}`)
  })

  it("draws the logo-chip header (NCR line indented past the chip) when a PNG logo is passed", async () => {
    const logo = Uint8Array.from(
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
    )
    const find = (pdf: Buffer) =>
      textRuns(extractPdfContent(pdf)).find((r) => r.text === `NCR Reg: ${fixture.lender.ncrNumber}`)
    const withLogo = find(await generateDebitMandatePdf({ ...fixture, logo }))
    const withoutLogo = find(await generateDebitMandatePdf(fixture))
    expect(withLogo).toBeDefined()
    expect(withLogo!.x).toBeGreaterThan(withoutLogo!.x)
  })

  it("throws LenderIdentityError when the NCR number is invalid", async () => {
    await expect(
      generateDebitMandatePdf({ ...fixture, lender: { ...fixture.lender, ncrNumber: "bad" } }),
    ).rejects.toBeInstanceOf(LenderIdentityError)
  })

  it("moves maximum-length account-holder and bank names to a safe continuation page", async () => {
    const pdf = await generateDebitMandatePdf({
      ...fixture,
      creditorBank: { ...fixture.creditorBank, bankName: `Creditor ${"Bank ".repeat(14)}`.slice(0, 80) },
      client: {
        ...fixture.client,
        firstName: "First ".repeat(10).trim(),
        lastName: "Last ".repeat(12).trim(),
        bankName: `Consumer ${"Bank ".repeat(14)}`.slice(0, 80),
      },
    })
    const parsed = await PDFDocument.load(pdf)
    const content = extractPdfContent(pdf)

    expect(parsed.getPageCount()).toBe(2)
    expect(textBaseline(content, "Witness Signature")).toBeGreaterThan(100)
    expect(textBaseline(content, "Witness Signature")).toBeGreaterThan(
      textBaseline(content, "Page 2 of 2") + 20,
    )
  })

  it("splits maximum-length unbroken banking tokens within the value column", async () => {
    const width = CONTENT_WIDTH - 164
    const scratch = await PDFDocument.create()
    const font = await scratch.embedFont(StandardFonts.Helvetica)
    for (const value of ["W".repeat(80), "A".repeat(120)]) {
      const lines = wrapTextToWidth(value, font, 9, width)
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.join("")).toBe(value)
      expect(lines.every((line) => font.widthOfTextAtSize(line, 9) <= width)).toBe(true)
    }

    const pdf = await generateDebitMandatePdf({
      ...fixture,
      creditorBank: { ...fixture.creditorBank, bankName: "W".repeat(80) },
      client: {
        ...fixture.client,
        firstName: "A".repeat(60),
        lastName: "B".repeat(59),
        bankName: "W".repeat(80),
      },
    })
    const parsed = await PDFDocument.load(pdf)
    const content = extractPdfContent(pdf)
    const unbrokenBankRuns = textRuns(content).filter((run) => /^W+$/.test(run.text))

    expect(parsed.getPageCount()).toBe(2)
    expect(textBaseline(content, "Witness Signature")).toBeGreaterThan(100)
    expect(unbrokenBankRuns.length).toBeGreaterThanOrEqual(4)
    expect(unbrokenBankRuns.every((run) =>
      run.x + font.widthOfTextAtSize(run.text, 9) <= MARGIN + CONTENT_WIDTH
    )).toBe(true)
  })

  it("is byte-stable for fixed legal and financial inputs", async () => {
    const pdf = await generateDebitMandatePdf(fixture)

    expect(createHash("sha256").update(pdf).digest("hex"))
      // Re-pinned in white-label phase 3 (was a3694684…): the logo is now an
      // input and this fixture passes none, so the header prints the name.
      // Re-pinned in phase 5 (was 65f48de6…): the fixture's lender identity
      // and office lines became neutral Acme values; derived by rendering.
      // Re-pinned in phase 6 (was 1b5c8992…): neutral palette, colour
      // operands only (see lib/pdf/charges-off-identity.test.ts).
      .toBe("1c102e2ab2e645c24814fbc2bb4add177a4e3d61b1eb4df9620b3fe6f890f728")
  })
})
