import { afterEach, describe, expect, it, vi } from "vitest"
import { FINGERPRINT_CLOCK, fingerprintInput, sha256 } from "@/scripts/nca-pdf-fingerprint"
import { generateSection129Pdf } from "./section129"
import { generateCertificateOfBalancePdf } from "./certificateOfBalance"
import { generateStatementPdf } from "./statement"

// While default charges are off (never live), the Section 129 notice, the
// certificate of balance and the statement generators must render this fixed
// input byte-for-byte as pinned. The pin covers the generators, not the
// figures a route feeds them: since 2026-10-19 the S129 routes state the
// settlement figure as the total obligation (section129NoticeAmounts).
// Re-pinned three times, each time proving the render moved by the
// named change only:
//   - white-label phase 3 (identity from a LenderIdentity, no logo): rendering
//     the new path with the forked lender's identity and logo reproduced its
//     hashes exactly; the Acme render differs in identity values only;
//   - the pre-push PII audit (8607cf61…, 961841b6…, d7d6fc32…): the fixture's
//     client ID number became an obviously synthetic one, nothing else;
//   - phase 6 (ededa8dc…, f9dda0bf…, 1b111cc3…): the neutral palette changed the
//     accent from bronze to indigo and warmed ink to a cool near-black. Every
//     indirect object of every NCA document was compared, old render vs new,
//     after mapping those two colour operands: identical.
// These come from scripts/nca-pdf-fingerprint.ts.
const MAIN = {
  s129: "1f625e917305214fac0895855ef48f19ddae8759025bde455bdfb272fcdc558f",
  cob: "1b0688e06b8580fbac845f6c8b546c3adaeaef0bf46e22f53b4ea3aa5a373a1a",
  statement: "1f4ba4fd9be563e2857b077a2dbef7752514ab952839da42ecb266e3b053136d",
}

afterEach(() => { vi.useRealTimers() })

describe("NCA documents with default charges off", () => {
  const { lender, client, s129Loan, cobLoan, asAt } = fingerprintInput

  it("renders the Section 129 notice byte-for-byte as pinned", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FINGERPRINT_CLOCK })
    expect(sha256(await generateSection129Pdf({ lender, client, loan: s129Loan, noticeDate: asAt }))).toBe(MAIN.s129)
  })

  it("renders the certificate of balance byte-for-byte as pinned", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FINGERPRINT_CLOCK })
    expect(sha256(await generateCertificateOfBalancePdf({ lender, client, loan: cobLoan, asAt }))).toBe(MAIN.cob)
  })

  it("renders the statement byte-for-byte as pinned", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FINGERPRINT_CLOCK })
    const { statementLoan, statementSchedule, statementPayments } = fingerprintInput
    expect(sha256(await generateStatementPdf({
      lender, client: { ...client, email: "fixture@example.invalid" }, loan: statementLoan, product: { name: "Micro Loan" },
      schedule: statementSchedule, payments: statementPayments, statementDate: asAt,
    }))).toBe(MAIN.statement)
  })
})
