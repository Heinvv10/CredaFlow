// lib/pdf/__tests__/faisDisclosure.test.ts
import { describe, it, expect } from "vitest"
import { inflateSync } from "zlib"
import { generateFaisDisclosurePdf } from "../faisDisclosure"
import { extractPdfTextRuns } from "./pdf-test-utils"
import { LenderIdentityError } from "../../config/identity-schema"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const fixtureInput = {
  lender: ACME_LENDER,
  client: { firstName: "Thandeka", lastName: "Mokoena", idNumber: "8501015000080" },
  advisor: { name: "Bongani Zulu", designation: "Insurance Officer" },
  product: { type: "FUNERAL_COVER" as const, name: "Family Funeral Cover", insurer: "Acme Lending" },
  policyDraft: { sumAssured: 50000, premiumAmount: 420, term: "12 months" },
}

/** Extract all decompressed content from a PDF buffer.
 *  pdf-lib encodes text as hex strings (<HEXHEX>) in FlateDecode content streams.
 *  This helper decompresses all streams and returns the combined text for assertion. */
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

/** Encode a plain ASCII string as the uppercase hex sequence pdf-lib embeds in content streams. */
function pdfHex(s: string): string {
  return Buffer.from(s, "ascii").toString("hex").toUpperCase()
}

describe("generateFaisDisclosurePdf", () => {
  it("renders a non-empty PDF starting with the PDF magic bytes", async () => {
    const buf = await generateFaisDisclosurePdf(fixtureInput)
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF")
  })

  it("includes the advisor name, product name, and disclosure marker", async () => {
    const buf = await generateFaisDisclosurePdf(fixtureInput)
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("Bongani Zulu"))
    expect(content).toContain(pdfHex("Family Funeral Cover"))
    expect(content).toContain(pdfHex("FAIS Disclosure"))
  })

  it("includes the client name + ID number", async () => {
    const buf = await generateFaisDisclosurePdf(fixtureInput)
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("Thandeka Mokoena"))
    expect(content).toContain(pdfHex("8501015000080"))
  })

  it("renders the FULL statutory body without clipping a clause, even under long names", async () => {
    // The overflow guard must paginate so NO clause is drawn off the bottom of
    // the page. Stress with long names + the bundled-credit-life input shape
    // (ncrNumber + insurer present, which pushes the body lowest), then assert
    // the LAST clauses survive: Clause 5 (benefits, GCOC s7(1)(c)) and Clause 10
    // (FAIS Ombud). Each FAIS_DISCLOSURE_BODY entry is one drawText line, so a
    // heading substring is contiguous in the content stream.
    const buf = await generateFaisDisclosurePdf({
      lender: { ...ACME_LENDER, legalName: "Acme Lending Holdings (Pty) Ltd" },
      client: { firstName: "Thandiwe", lastName: "Mthembu-Ngcobo", idNumber: "9401010000080" },
      advisor: { name: "Lerato Dlamini-Mokoena", designation: "Credit Officer" },
      product: { type: "CREDIT_LIFE" as const, name: "Acme Credit Life", insurer: "Clientele Life" },
      policyDraft: { sumAssured: 20000, premiumAmount: 90 },
    })
    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("Nature and extent of benefits")) // Clause 5 heading
    expect(content).toContain(pdfHex("faisombud.co.za")) // Clause 10 Ombud (last content)
  })

  it("prints the lender's FSP number (not an advisor-level one) and its NCR number", async () => {
    const content = extractPdfContent(await generateFaisDisclosurePdf(fixtureInput))
    expect(content).toContain(pdfHex(ACME_LENDER.fspNumber!))
    expect(content).toContain(pdfHex(ACME_LENDER.ncrNumber))
    expect(content).not.toContain(pdfHex("pending legal proof"))
  })

  it("throws LenderIdentityError when the lender FSP number is empty", async () => {
    await expect(
      generateFaisDisclosurePdf({ ...fixtureInput, lender: { ...fixtureInput.lender, fspNumber: "" } }),
    ).rejects.toBeInstanceOf(LenderIdentityError)
  })

  it("falls back to a text-only header without overlapping lines when no logo is passed", async () => {
    const buf = await generateFaisDisclosurePdf(fixtureInput)
    const runs = extractPdfTextRuns(buf)

    const nameRun = runs.find((r) => r.text === fixtureInput.lender.legalName)
    const subtitleRun = runs.find((r) => r.text === "FAIS Disclosure (General Code of Conduct, sections 4, 5 + 7)")
    expect(nameRun).toBeDefined()
    expect(subtitleRun).toBeDefined()
    expect(`${nameRun!.x},${nameRun!.y}`).not.toBe(`${subtitleRun!.x},${subtitleRun!.y}`)
  })

  it("renders a valid PDF on the logo-chip path when a PNG logo is passed", async () => {
    const logo = Uint8Array.from(
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
    )
    const buf = await generateFaisDisclosurePdf({ ...fixtureInput, logo })
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF")
    expect(buf.length).toBeGreaterThan((await generateFaisDisclosurePdf(fixtureInput)).length)
  })
})
