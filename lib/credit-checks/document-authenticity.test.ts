import { describe, expect, it } from "vitest"
import { documentAuthenticity } from "./document-authenticity"
import { codes, facts, statement, tx } from "./facts.test-helpers"

const clean = () => statement([tx("2026-07-25", "Payment Received: SALARY SYNTHCO", 1_845_000), tx("2026-07-26", "Card Purchase: SYNTH MART", -45_000)])

describe("documentAuthenticity", () => {
  it("raises nothing on a clean bank-produced statement", () => {
    expect(documentAuthenticity(facts({ statements: [clean()] }))).toEqual([])
  })

  it("raises BALANCE_MISMATCH when a text read's totals do not reach the closing balance", () => {
    const s = clean()
    s.read!.closingBalanceCents! += 10_000
    const out = documentAuthenticity(facts({ statements: [s] }))
    expect(codes(out)).toEqual(["BALANCE_MISMATCH"])
    expect(out[0].evidence).toMatchObject({ documentId: "doc-1", diffCents: -10_000 })
  })

  it("raises RUNNING_BALANCE_BREAK naming the row whose balance does not follow", () => {
    const s = clean()
    s.read!.transactions[1] = { ...s.read!.transactions[1], amountCents: -5_000 }
    s.read!.closingBalanceCents = s.read!.transactions[1].balanceCents
    const out = documentAuthenticity(facts({ statements: [s] }))
    expect(codes(out)).toEqual(["BALANCE_MISMATCH", "RUNNING_BALANCE_BREAK"])
    expect(out.find((c) => c.code === "RUNNING_BALANCE_BREAK")!.evidence).toMatchObject({ transactionIndexes: [1], pages: [1] })
  })

  it("never raises a balance flag on a vision read: a misread and a forgery look the same", () => {
    const s = clean()
    s.method = "VLM"
    s.read!.closingBalanceCents! += 10_000
    expect(documentAuthenticity(facts({ statements: [s] }))).toEqual([])
  })

  it("raises INCREMENTAL_UPDATE when the file was saved again after the original", () => {
    const s = clean()
    s.authenticity!.incrementalUpdates = 1
    expect(codes(documentAuthenticity(facts({ statements: [s] })))).toEqual(["INCREMENTAL_UPDATE"])
  })

  it("raises PRODUCER_UNEXPECTED for a known bank's statement re-saved by another program", () => {
    const s = clean()
    s.authenticity!.producer = "Microsoft® Word for Microsoft 365"
    expect(codes(documentAuthenticity(facts({ statements: [s] })))).toEqual(["PRODUCER_UNEXPECTED"])
  })

  it("requires a Capitec original to carry no creator at all, and FNB's to name its own", () => {
    const capitec = clean()
    capitec.authenticity!.creator = "Microsoft Word"
    expect(codes(documentAuthenticity(facts({ statements: [capitec] })))).toEqual(["PRODUCER_UNEXPECTED"])
    const fnb = clean()
    fnb.bank = "FNB"
    fnb.authenticity!.producer = "Compart MFFPDF I/O Filter 2023-09-19 11:31:13"
    fnb.authenticity!.creator = "Compart Docponent API (202310-STABLE)"
    expect(documentAuthenticity(facts({ statements: [fnb] }))).toEqual([])
    fnb.authenticity!.creator = "Microsoft Word"
    expect(codes(documentAuthenticity(facts({ statements: [fnb] })))).toEqual(["PRODUCER_UNEXPECTED"])
  })

  it("does not producer-check a scan: the scanner wrote that file", () => {
    const s = clean()
    s.authenticity!.producer = "SomeScanner 1.0"
    s.authenticity!.signals = ["TEXT_LAYER_ABSENT"]
    expect(documentAuthenticity(facts({ statements: [s] }))).toEqual([])
  })

  it("does not producer-check a bank with no allow-list", () => {
    const s = clean()
    s.bank = "TYMEBANK"
    s.authenticity!.producer = "Anything"
    expect(documentAuthenticity(facts({ statements: [s] }))).toEqual([])
  })

  it("raises MODIFIED_AFTER_CREATION past the tolerance, and not within it", () => {
    const later = clean()
    later.authenticity!.modifiedAt = "2026-10-03T08:00:00Z"
    expect(codes(documentAuthenticity(facts({ statements: [later] })))).toEqual(["MODIFIED_AFTER_CREATION"])
    const moment = clean()
    moment.authenticity!.modifiedAt = "2026-10-01T08:00:30Z"
    expect(documentAuthenticity(facts({ statements: [moment] }))).toEqual([])
  })

  it("raises HOLDER_NAME_MISMATCH when the statement names someone else", () => {
    const s = clean()
    s.read!.accountHolderName = "J SOAP"
    expect(codes(documentAuthenticity(facts({ statements: [s] })))).toEqual(["HOLDER_NAME_MISMATCH"])
  })

  it("raises STALE_STATEMENT when the statement ends more than 45 days before the application", () => {
    const s = clean()
    s.read!.periodEnd = "2026-08-20"
    expect(codes(documentAuthenticity(facts({ statements: [s] })))).toEqual(["STALE_STATEMENT"])
    s.read!.periodEnd = "2026-08-21"
    expect(documentAuthenticity(facts({ statements: [s] }))).toEqual([])
  })

  it("keys each flag to the analysis that raised it, so a new upload is new evidence", () => {
    const a = clean()
    a.authenticity!.incrementalUpdates = 1
    const b = { ...a, documentId: "doc-2", analysisId: "an-2" }
    const keys = documentAuthenticity(facts({ statements: [a, b] })).map((c) => c.key)
    expect(new Set(keys).size).toBe(2)
  })
})
