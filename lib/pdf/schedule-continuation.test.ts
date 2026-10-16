import { afterEach, describe, expect, it, vi } from "vitest"
import {
  FINGERPRINT_CLOCK, sha256,
  boundaryLoanInput, boundaryStartDate, boundaryAgreementInput, boundaryStatementInput,
  variantStatementInputs,
} from "@/scripts/nca-pdf-fingerprint"
import { calculateLoan } from "@/lib/loan-calculator"
import { generateCreditAgreementPdf } from "./creditAgreement"
import { generateStatementPdf } from "./statement"

// The longest tables that fitted one page before continuation pages existed:
// 38 agreement/PASQ schedule rows, 37 statement schedule rows and 38 payment
// history rows. Pinned on the code that silently truncated longer tables, so a
// document that already printed in full must stay byte-for-byte what it was.
// These come from scripts/nca-pdf-fingerprint.ts.
// agreement38 / pasq38 re-pinned 2026-10-16 (Fair Score audit B6, NCA wording —
// legal sign-off gate): the fixture offers no credit life, and the only change
// to either document is one added table row, "Credit Life" / "Not offered — no
// credit-life cover is included", after "Total Interest". Same 4 pages; every
// other text run identical (decoded content-stream diff in the PR). Previous:
// agreement38 715aaf12…e282, pasq38 a5881ac1…3009.
const BOUNDARY = {
  agreement38: "9ec43db3421811cd7b1f8450d93664de1eae62cbb7534238076533467ad5bbaa",
  pasq38: "ed43544b8ce6d243e34124139fe1c70993b08f2c41c815161a41906dd9544b84",
  statement37: "abf4499d41ec6441669197aa8e4d622c9b1bc226dc3c6569b7e182afe1bf3c7b",
}

// Statements whose payment history carries charge rows (30), reversed-payment
// notes (30 payments, 8 reversed) and "of which … default charges" lines (20),
// each still fitting on three pages. Rendered on f5887b6, before continuation
// pages, and reproduced unchanged by the code after them.
const VARIANTS = {
  statementCharges: "b3a1397a713bef4489c37d4acac4e8829e23a9db395f3fc84b8f2f43adce0f45",
  statementReversed: "d678a2e9eaac103575a1e2e1ab0f5fbad017f367938ba5f09053d3b63024f057",
  statementOfWhich: "10005bf5dba901286f9175e7959068a5df203f82d8d2e31022d529dd6ea265d7",
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

describe("statements whose history fits on one page", () => {
  const inputs = variantStatementInputs()
  it.each(Object.keys(VARIANTS) as Array<keyof typeof VARIANTS>)("renders %s byte-for-byte as pinned", async (key) => {
    vi.useFakeTimers({ toFake: ["Date"], now: FINGERPRINT_CLOCK })
    expect(sha256(await generateStatementPdf(inputs[key]))).toBe(VARIANTS[key])
  })
})
