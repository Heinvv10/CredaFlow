import { describe, expect, it } from "vitest"
import { manualReview } from "./manual-review"
import { codes, facts, statement, tx } from "./facts.test-helpers"
import type { ApplicationFacts, StatementFacts } from "./types"

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
    const unprofiled = statement([], { method: "VLM", bank: "TYMEBANK" })
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
  it("raises AUTHENTICITY_UNCHECKED for a profiled bank's PDF that names no producer or creator", () => {
    const bare = { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: [] }
    // Discovery's app writes no metadata, so its producer check passes — and would for any stripped file.
    const stripped = statement([], { bank: "DISCOVERY", authenticity: bare })
    expect(codes(manualReview(withSlip({ statements: [stripped] })))).toEqual(["AUTHENTICITY_UNCHECKED"])
    // A creator alone is metadata to check (Nedbank writes no producer).
    const nedbank = statement([], { bank: "NEDBANK", authenticity: { ...bare, creator: "OpenText Exstream Version 16.6.60 64-bit" } })
    expect(manualReview(withSlip({ statements: [nedbank] }))).toEqual([])
  })
})


describe("manualReview: a boundary row the account's adjacent statement agrees with", () => {
  /** Each boundary flag as "doc CODE neighbour", the neighbour being the statement it agrees with or "-". */
  const boundary = (out: Array<{ code: string; key: string; evidence: Record<string, unknown> }>) =>
    out.filter((c) => c.code === "FIRST_ROW_UNVERIFIED" || c.code === "LAST_ROW_UNVERIFIED")
      .map((c) => `${c.key.split(":")[0]} ${c.code} ${(c.evidence.chainedWith as { documentId?: string } | undefined)?.documentId ?? "-"}`).sort()
  /** A Discovery-like statement: no opening or closing printed, both derived from the rows. */
  function derived(id: string, periodStart: string, periodEnd: string, openingCents: number, amounts: number[], over: Partial<StatementFacts> = {}): StatementFacts {
    let running = openingCents
    const rows = amounts.map((a, i) => tx(periodStart.replace(/\d{2}$/, String(i + 2).padStart(2, "0")), "SYNTH", a, (running += a)))
    const s = statement(rows, {
      documentId: id, analysisId: `an-${id}`, contentSha256: `sha-${id}`, bank: "DISCOVERY",
      authenticity: { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: ["OPENING_DERIVED", "CLOSING_DERIVED"] },
      ...over,
    })
    Object.assign(s.read!, { periodStart, periodEnd, openingBalanceCents: openingCents, closingBalanceCents: running })
    return s
  }
  const june = (over: Partial<StatementFacts> = {}) => derived("a", "2026-06-01", "2026-06-30", 100_000, [500_000, -20_000], over)
  const july = (opening = 580_000, over: Partial<StatementFacts> = {}) => derived("b", "2026-07-01", "2026-07-31", opening, [-30_000, 450_000], over)
  const run = (...statements: StatementFacts[]) => boundary(manualReview(withSlip({ statements })))
  const unchained = ["a FIRST_ROW_UNVERIFIED -", "a LAST_ROW_UNVERIFIED -", "b FIRST_ROW_UNVERIFIED -", "b LAST_ROW_UNVERIFIED -"]
  const chained = ["a FIRST_ROW_UNVERIFIED -", "a LAST_ROW_UNVERIFIED b", "b FIRST_ROW_UNVERIFIED a", "b LAST_ROW_UNVERIFIED -"]

  it("raises both boundaries of a lone statement whose bank prints neither balance, with no neighbour", () => {
    expect(run(july())).toEqual(["b FIRST_ROW_UNVERIFIED -", "b LAST_ROW_UNVERIFIED -"])
  })

  it("still raises the boundary two consecutive statements share, and names the statement it agrees with", () => {
    // The client uploads both: agreement is a hint for the officer, never a reason not to look.
    expect(run(june(), july())).toEqual(chained)
    expect(run(july(), june())).toEqual(chained)
    const out = manualReview(withSlip({ statements: [june(), july()] }))
    expect(out.find((c) => c.code === "FIRST_ROW_UNVERIFIED" && c.key.startsWith("b:"))!.evidence.chainedWith)
      .toEqual({ documentId: "a", periodStart: "2026-06-01", periodEnd: "2026-06-30", closingCents: 580_000 })
    expect(out.find((c) => c.code === "LAST_ROW_UNVERIFIED" && c.key.startsWith("a:"))!.evidence.chainedWith)
      .toEqual({ documentId: "b", periodStart: "2026-07-01", periodEnd: "2026-07-31", openingCents: 580_000 })
  })

  it("chains a statement that starts on the day the previous one ended, as FNB and Nedbank date them", () => {
    const b = july()
    b.read!.periodStart = "2026-06-30"
    expect(run(june(), b)).toEqual(chained)
  })

  it("chains holder names that differ only in case, spacing or punctuation", () => {
    const b = july()
    b.read!.accountHolderName = "t.  tester"
    expect(run(june(), b)).toEqual(chained)
  })

  it("names no neighbour when the opening differs from the previous closing by a cent", () => {
    expect(run(june(), july(580_001))).toEqual(unchained)
  })

  it("names no neighbour for another account, another bank, or an account number or holder not read", () => {
    const otherAccount = july()
    otherAccount.read!.accountNumberLast4 = "0002"
    expect(run(june(), otherAccount)).toEqual(unchained)
    expect(run(june(), july(580_000, { bank: "ABSA" }))).toEqual(unchained)
    const noAccount = july()
    noAccount.read!.accountNumberLast4 = null
    const a = june()
    a.read!.accountNumberLast4 = null
    expect(run(a, noAccount)).toEqual(unchained)
    const otherHolder = july()
    otherHolder.read!.accountHolderName = "S SOMEONE"
    expect(run(june(), otherHolder)).toEqual(unchained)
    const noHolder = july()
    noHolder.read!.accountHolderName = null
    expect(run(june(), noHolder)).toEqual(unchained)
    // Neither read a holder: two blanks are not a match.
    const blank = june()
    blank.read!.accountHolderName = null
    expect(run(blank, noHolder)).toEqual(unchained)
  })

  it("names no neighbour for periods that leave a gap, overlap, start together, run backwards or are missing", () => {
    const gap = july()
    gap.read!.periodStart = "2026-07-02"
    expect(run(june(), gap)).toEqual(unchained)
    const overlap = july()
    overlap.read!.periodStart = "2026-06-29"
    expect(run(june(), overlap)).toEqual(unchained)
    // Both start on the same day: the "previous" one is no earlier.
    const sameStart = derived("a", "2026-06-30", "2026-06-30", 100_000, [500_000, -20_000])
    const fromSameDay = july()
    fromSameDay.read!.periodStart = "2026-06-30"
    expect(run(sameStart, fromSameDay)).toEqual(unchained)
    // An inverted previous period, ending the day before the next begins.
    const inverted = derived("a", "2026-07-15", "2026-06-30", 100_000, [500_000, -20_000])
    expect(run(inverted, july())).toEqual(unchained)
    const invertedNext = july()
    invertedNext.read!.periodEnd = "2026-06-30"
    expect(run(june(), invertedNext)).toEqual(unchained)
    const noPeriod = july()
    noPeriod.read!.periodStart = null
    expect(run(june(), noPeriod)).toEqual(unchained)
  })

  it("names no neighbour that is a vision read, does not reconcile, is the same bytes, or carries an authenticity finding", () => {
    expect(run(june(), july(580_000, { method: "VLM" }))).toEqual(unchained)
    expect(run(june(), july(580_000, { balanceCheck: "FAIL" }))).toEqual(unchained)
    expect(run(june(), july(580_000, { contentSha256: "sha-a" }))).toEqual(unchained)
    const edited = { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 1, signals: ["OPENING_DERIVED", "CLOSING_DERIVED"] }
    // The edited file is the neighbour of the other's boundary only: its own flags still say nothing about agreement.
    expect(run(june({ authenticity: edited }), july())).toEqual(["a FIRST_ROW_UNVERIFIED -", "a LAST_ROW_UNVERIFIED b", "b FIRST_ROW_UNVERIFIED -", "b LAST_ROW_UNVERIFIED -"])
    expect(run(june(), july(580_000, { authenticity: { ...edited, incrementalUpdates: 0, producer: "Microsoft® Word for Microsoft 365" } })))
      .toEqual(["a FIRST_ROW_UNVERIFIED -", "a LAST_ROW_UNVERIFIED -", "b FIRST_ROW_UNVERIFIED a", "b LAST_ROW_UNVERIFIED -"])
  })
})
