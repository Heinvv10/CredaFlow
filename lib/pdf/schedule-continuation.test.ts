import { afterEach, describe, expect, it, vi } from "vitest"
import {
  FINGERPRINT_CLOCK, sha256,
  boundaryLoanInput, boundaryStartDate, boundaryAgreementInput, boundaryStatementInput,
} from "@/scripts/nca-pdf-fingerprint"
import { calculateLoan } from "@/lib/loan-calculator"
import { generateCreditAgreementPdf } from "./creditAgreement"
import { generateStatementPdf } from "./statement"

// The longest tables that fitted one page before continuation pages existed:
// 38 agreement/PASQ schedule rows, 37 statement schedule rows and 38 payment
// history rows. Pinned on the code that silently truncated longer tables, so a
// document that already printed in full must stay byte-for-byte what it was.
// These come from scripts/nca-pdf-fingerprint.ts.
const BOUNDARY = {
  agreement38: "715aaf12662573c1138eb5179a7bf2ff7c45f3c47c57174d43c62727e415e282",
  pasq38: "a5881ac186e9b4f5c73ec5b65dfd0acfc9aeb2ef5c317493a93ba794ce273009",
  statement37: "abf4499d41ec6441669197aa8e4d622c9b1bc226dc3c6569b7e182afe1bf3c7b",
}

afterEach(() => { vi.useRealTimers() })

describe("NCA documents at the one-page table boundary", () => {
  const calc38 = calculateLoan(boundaryLoanInput(38), boundaryStartDate)

  it("has a 38-row schedule in the fixture", () => {
    expect(calc38.schedule).toHaveLength(38)
  })

  it("renders the 38-instalment credit agreement byte-for-byte as pinned", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FINGERPRINT_CLOCK })
    expect(sha256(await generateCreditAgreementPdf(boundaryAgreementInput("agreement", calc38)))).toBe(BOUNDARY.agreement38)
  })

  it("renders the 38-instalment quotation byte-for-byte as pinned", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FINGERPRINT_CLOCK })
    expect(sha256(await generateCreditAgreementPdf(boundaryAgreementInput("pasq", calc38)))).toBe(BOUNDARY.pasq38)
  })

  it("renders the 37-row schedule, 38-payment statement byte-for-byte as pinned", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FINGERPRINT_CLOCK })
    expect(sha256(await generateStatementPdf(boundaryStatementInput(37, 38)))).toBe(BOUNDARY.statement37)
  })
})
