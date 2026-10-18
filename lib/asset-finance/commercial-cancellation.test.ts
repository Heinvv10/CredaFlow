import { describe, expect, it } from "vitest"
import { parseCommercialCancellation } from "./commercial-cancellation"

describe("actual commercial cancellation input", () => {
  const input = { cancelledOn: "2026-01-01", evidenceDocumentId: "TEST-notice", basis: "TEST verified termination notice", cancellationConfirmed: true }
  it("requires evidence and an explicit actual-cancellation confirmation", () => {
    expect(parseCommercialCancellation({ ...input, cancellationConfirmed: false })).toMatch(/not merely possession/)
    expect(parseCommercialCancellation({ ...input, evidenceDocumentId: "" })).toMatch(/evidence/)
    expect(parseCommercialCancellation({ ...input, cancelledOn: undefined, recoveredOn: "2026-01-01", completedOn: "2026-03-01" })).toMatch(/valid cancellation date/)
  })
  it("rejects impossible dates and retains the independently supplied cancellation date", () => {
    expect(parseCommercialCancellation({ ...input, cancelledOn: "2026-02-30" })).toMatch(/valid cancellation date/)
    expect(parseCommercialCancellation({ ...input, recoveredOn: "2026-02-01", completedOn: "2026-03-01" })).toMatchObject({ cancelledOn: "2026-01-01" })
  })
})
