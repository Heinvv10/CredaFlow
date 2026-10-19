import { writeFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  FINGERPRINT_CLOCK, sha256,
  boundaryLoanInput, boundaryStartDate, boundaryAgreementInput, boundaryStatementInput,
  variantStatementInputs, noticesMovedAgreementInput,
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

// Notices that do not fit page 1 move to page 2 and the schedule now starts
// under them there (Fair Score audit 2026-10-16: "PASQ page 2 nearly blank";
// layout approved by Hein 2026-10-19). Before this the same input rendered the
// notices alone on page 2 and the schedule from page 3. Proof: NCA_PIN_DUMP=<dir> writes the
// four PDFs for review; 12 rows fit under the notices, 60 continue onto a further page.
const NOTICES_MOVED = {
  pasq12: "c440592dba7c246efaa37ea254de9e5dfa4d792e2de80de05d89a1c184cc1add",
  agreement12: "f6b47e899c00b2534a2ede9f6db08707a21165f5a82906bfa169fadaec9c1e0d",
  pasq60: "ecdf313cc0cf7ad76ebee9470ccf21b5fe0bed752d5c20ba361f16237ab5696e",
  agreement60: "8bb3541dff05b7fe72be6c892b3515da7448615177c7b4c6415e51f4b8b5f806",
}

describe("documents whose notices move to page 2", () => {
  it.each([
    ["pasq", 12], ["agreement", 12], ["pasq", 60], ["agreement", 60],
  ] as const)("renders the %s with %i instalments byte-for-byte as pinned", async (variant, rows) => {
    vi.useFakeTimers({ toFake: ["Date"], now: FINGERPRINT_CLOCK })
    const calc = calculateLoan(boundaryLoanInput(rows), boundaryStartDate)
    const pdf = await generateCreditAgreementPdf(noticesMovedAgreementInput(variant, calc))
    if (process.env.NCA_PIN_DUMP) writeFileSync(`${process.env.NCA_PIN_DUMP}/${variant}${rows}.pdf`, pdf)
    expect(sha256(pdf)).toBe(NOTICES_MOVED[`${variant}${rows}`])
  })
})
