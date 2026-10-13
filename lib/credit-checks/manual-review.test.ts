import { describe, expect, it } from "vitest"
import { manualReview } from "./manual-review"
import { codes, facts, statement } from "./facts.test-helpers"
import type { ApplicationFacts } from "./types"

const payslip = { documentId: "slip-1", validated: true, matchesClient: true, netPayCents: 1_845_000, payDate: "2026-09-25" }
const withSlip = (over: Partial<ApplicationFacts> = {}) => facts({ payslip, ...over })

describe("manualReview", () => {
  it("raises nothing for a verified text read of a profiled bank with a payslip on file", () => {
    expect(manualReview(withSlip())).toEqual([])
  })

  it("raises NO_STATEMENT when the application has no bank statement", () => {
    expect(codes(manualReview(withSlip({ statements: [] })))).toEqual(["NO_STATEMENT"])
  })

  it("raises NO_PAYSLIP when statements exist but no payslip does", () => {
    expect(codes(manualReview(facts()))).toEqual(["NO_PAYSLIP"])
  })

  it("raises UNVERIFIED_READ for a vision read that fails or cannot run the balance check", () => {
    expect(codes(manualReview(withSlip({ statements: [statement([], { method: "VLM", balanceCheck: "FAIL" })] })))).toEqual(["UNVERIFIED_READ"])
    expect(codes(manualReview(withSlip({ statements: [statement([], { method: "VLM", balanceCheck: "NOT_APPLICABLE" })] })))).toEqual(["UNVERIFIED_READ"])
    expect(manualReview(withSlip({ statements: [statement([], { method: "VLM", balanceCheck: "PASS" })] }))).toEqual([])
  })

  it("raises UNVERIFIED_READ for a text read without both balances", () => {
    expect(codes(manualReview(withSlip({ statements: [statement([], { balanceCheck: "NOT_APPLICABLE" })] })))).toEqual(["UNVERIFIED_READ"])
  })

  it("raises UNREADABLE for a statement no reader could read, or one too long to read", () => {
    const unreadable = statement([], { state: "UNREADABLE", read: null, balanceCheck: "NOT_APPLICABLE", method: "VLM" })
    const unsupported = statement([], { state: "UNSUPPORTED", read: null, balanceCheck: "NOT_APPLICABLE", method: "VLM", documentId: "doc-2", analysisId: "an-2" })
    expect(codes(manualReview(withSlip({ statements: [unreadable, unsupported] })))).toEqual(["UNREADABLE", "UNREADABLE"])
  })

  it("raises NOT_READ for a statement waiting for the vision reader or missing its file", () => {
    const pending = (pendingReason: "vlm" | "file_missing") =>
      statement([], { state: "PENDING", pendingReason, read: null, analysisId: null, contentSha256: null, method: null, balanceCheck: null, authenticity: null })
    const out = manualReview(withSlip({ statements: [pending("vlm")] }))
    expect(codes(out)).toEqual(["NOT_READ"])
    expect(out[0].summary).toContain("vision reader")
    expect(manualReview(withSlip({ statements: [pending("file_missing")] }))[0].summary).toContain("could not be found")
  })

  it("raises NOT_READ_NO_CONSENT for a statement uploaded without POPIA consent", () => {
    const s = statement([], { state: "PENDING", pendingReason: "consent", read: null, analysisId: null, contentSha256: null, method: null, balanceCheck: null, authenticity: null })
    expect(codes(manualReview(withSlip({ statements: [s] })))).toEqual(["NOT_READ_NO_CONSENT"])
  })

  it("raises AUTHENTICITY_UNCHECKED for a reconciling read the file checks could not cover", () => {
    const signals = (s: string[]) => ({ producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: s })
    const photo = statement([], { method: "VLM", bank: null, authenticity: signals(["NOT_A_PDF"]) })
    const scan = statement([], { method: "VLM", authenticity: signals(["TEXT_LAYER_ABSENT"]) })
    const unprofiled = statement([], { method: "VLM", bank: "NEDBANK" })
    const forgedInfo = statement([], { authenticity: signals(["METADATA_AMBIGUOUS"]) })
    for (const s of [photo, scan, unprofiled, forgedInfo]) {
      expect(codes(manualReview(withSlip({ statements: [s] })))).toEqual(["AUTHENTICITY_UNCHECKED"])
    }
  })

  it("raises READ_INCOMPLETE for a read without the holder or the period", () => {
    const noHolder = statement([])
    noHolder.read!.accountHolderName = null
    expect(codes(manualReview(withSlip({ statements: [noHolder] })))).toEqual(["READ_INCOMPLETE"])
    const noPeriod = statement([])
    noPeriod.read!.periodEnd = null
    expect(codes(manualReview(withSlip({ statements: [noPeriod] })))).toEqual(["READ_INCOMPLETE"])
  })

  it("raises STATEMENT_DELETED for each read statement since deleted, with or without statements left", () => {
    expect(codes(manualReview(withSlip({ deletedStatementIds: ["gone-1"] })))).toEqual(["STATEMENT_DELETED"])
    expect(codes(manualReview(withSlip({ statements: [], deletedStatementIds: ["gone-1", "gone-2"] }))))
      .toEqual(["NO_STATEMENT", "STATEMENT_DELETED", "STATEMENT_DELETED"])
  })

  it("names the missing PDF tools rather than the vision reader", () => {
    const s = statement([], { state: "PENDING", pendingReason: "reader_unavailable", read: null, analysisId: null, contentSha256: null, method: null, balanceCheck: null, authenticity: null })
    const out = manualReview(withSlip({ statements: [s] }))
    expect(codes(out)).toEqual(["NOT_READ"])
    expect(out[0].summary).toContain("PDF tools")
  })

  it("raises every concern about a statement, so clearing one cannot hide another", () => {
    const signals = (x: string[]) => ({ producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: x })
    const photo = statement([], { method: "VLM", bank: null, balanceCheck: "FAIL", authenticity: signals(["NOT_A_PDF"]) })
    photo.read!.accountHolderName = null
    expect(codes(manualReview(withSlip({ statements: [photo] })))).toEqual(["AUTHENTICITY_UNCHECKED", "READ_INCOMPLETE", "UNVERIFIED_READ"])
  })

  it("raises AUTHENTICITY_UNCHECKED for a profiled bank whose layout the text reader did not recognise", () => {
    const s = statement([], { method: "VLM", authenticity: { producer: "OpenPDF 2.0.2", creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: ["TEXT_LAYOUT_UNRECOGNISED"] } })
    expect(codes(manualReview(withSlip({ statements: [s] })))).toEqual(["AUTHENTICITY_UNCHECKED"])
  })

  it("says a statement with contradictory metadata may be altered, not that it is long", () => {
    const s = statement([], { state: "UNSUPPORTED", read: null, method: "VLM", balanceCheck: "NOT_APPLICABLE", authenticity: { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: ["METADATA_AMBIGUOUS"] } })
    expect(manualReview(withSlip({ statements: [s] }))[0].summary).toContain("possibly altered")
  })

  it("raises PAYSLIP_DELETED and PRIOR_OPEN_FLAGS for each one", () => {
    const prior = { id: "app-declined", reference: "APP-0001", status: "DECLINED" }
    const out = manualReview(withSlip({ deletedPayslipIds: ["slip-old"], priorOpenFlagApplications: [prior] }))
    expect(codes(out)).toEqual(["PAYSLIP_DELETED", "PRIOR_OPEN_FLAGS"])
    const flag = out.find((c) => c.code === "PRIOR_OPEN_FLAGS")!
    expect(flag.evidence).toEqual({ applicationId: "app-declined", reference: "APP-0001", status: "DECLINED" })
    expect(flag.summary).toContain("APP-0001 (declined)")
  })

  it("raises PAYSLIP_NOT_READ for a payslip on file that was not extracted, in place of NO_PAYSLIP", () => {
    const out = manualReview(facts({ unreadPayslipIds: ["slip-failed"] }))
    expect(codes(out)).toEqual(["PAYSLIP_NOT_READ"])
    expect(out[0].evidence).toEqual({ payslipDocumentId: "slip-failed" })
  })

  it("says contradictory metadata may mean an altered file, on a statement that was read too", () => {
    const s = statement([], { authenticity: { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: ["METADATA_AMBIGUOUS"] } })
    expect(manualReview(withSlip({ statements: [s] }))[0].summary).toContain("possibly altered")
  })
})

