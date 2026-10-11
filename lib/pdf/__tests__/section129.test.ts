// lib/pdf/__tests__/section129.test.ts
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { inflateSync } from "zlib"
import { generateSection129Pdf } from "../section129"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const baseInput = {
  lender: ACME_LENDER,
  client: {
    firstName: "Thandeka",
    lastName: "Mokoena",
    idNumber: "8501015000080",
    addressLine1: "45 Oak Avenue",
    city: "Soweto",
  },
  loan: {
    reference: "L-2026-0001",
    arrearsAmount: 12500,           // 12500 cents = R 125.00
    outstandingPrincipal: 500000,   // 500000 cents = R 5 000.00
    daysInArrears: 30,
  },
  noticeDate: new Date("2026-05-19"),
}

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
        } catch (err) {
          // Surface the failure: if pdf-lib ever switches compression filter (LZW, etc.)
          // our content assertions would silently pass on an empty parts[] without this.
          console.warn(`[section129.test] inflate failed: ${(err as Error).message}`)
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

describe("generateSection129Pdf", () => {
  it("renders a valid PDF for the happy path", async () => {
    const buf = await generateSection129Pdf(baseInput)
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF")
    expect(buf.length).toBeGreaterThan(1000)

    const content = extractPdfContent(buf)
    expect(content).toContain(pdfHex("NOTICE IN TERMS OF SECTION 129(1)(a)"))
    expect(content).toContain(pdfHex("NATIONAL CREDIT ACT 34 OF 2005"))
    expect(content).toContain(pdfHex("WARNING:"))
    expect(content).toContain(pdfHex("YOUR ACCOUNT IS IN ARREARS"))
    expect(content).toContain(pdfHex("L-2026-0001"))
  })

  it("renders without throwing when client has no address fields (regression: prod loans with null addressLine1/city)", async () => {
    const buf = await generateSection129Pdf({
      ...baseInput,
      client: {
        firstName: "Thandeka",
        lastName: "Mokoena",
        idNumber: "8501015000080",
        // addressLine1 and city omitted
      },
    })
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF")
  })

  it("contains no non-WinAnsi codepoints in any string literal of section129.ts (regression: ⚠ U+26A0 threw on every loan)", () => {
    // pdf-lib's StandardFont (Helvetica) uses WinAnsi (CP1252) encoding.
    // Any literal passed to drawText/page.drawText with a codepoint outside
    // the WinAnsi range causes generateSection129Pdf to throw — which is the
    // exact failure mode that makes every loan's notice fail.
    // We scan the source itself so the test fails when the bad glyph is
    // re-introduced, not just when the bad code path happens to run.
    const source = readFileSync(join(__dirname, "..", "section129.ts"), "utf8")

    // Strip line comments and block comments so non-WinAnsi chars in comments
    // (e.g. ── in section banners) don't false-positive.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")

    // WinAnsi-encodable codepoints: ASCII (0x20-0x7E), Latin-1 supplement (0xA0-0xFF
    // except 0xAD soft hyphen), plus the CP1252 0x80-0x9F extension block which
    // maps to specific Unicode codepoints.
    const winAnsiExtensions = new Set([
      0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
      0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
      0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
    ])
    const isWinAnsi = (cp: number) =>
      (cp >= 0x20 && cp <= 0x7E) ||
      (cp >= 0xA0 && cp <= 0xFF && cp !== 0xAD) ||
      cp === 0x09 || cp === 0x0A || cp === 0x0D ||
      winAnsiExtensions.has(cp)

    const offenders: { line: number; codepoint: string; char: string }[] = []
    stripped.split("\n").forEach((line, idx) => {
      for (const ch of line) {
        const cp = ch.codePointAt(0) ?? 0
        if (!isWinAnsi(cp)) {
          offenders.push({ line: idx + 1, codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`, char: ch })
        }
      }
    })

    expect(offenders).toEqual([])
  })
})
