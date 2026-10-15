/**
 * The xref-stream check's safety net: whatever throws inside it, the save is
 * counted rather than the upload or the read failing.
 */
import { describe, expect, it, vi } from "vitest"
import { original, wordSave } from "./fixtures/revisions"
import { countIncrementalUpdates } from "./pdf-revisions"

vi.mock("./pdf-object-headers", () => ({
  objectHeaders: () => {
    throw new RangeError("Maximum call stack size exceeded")
  },
}))

describe("countIncrementalUpdates when the xref-stream check throws", () => {
  it("counts the save instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    // Word's own tail: a no-op whenever the check completes, but this one reaches the (throwing) header scan.
    const o = original({ xrefStreams: 1 })
    expect(countIncrementalUpdates(Buffer.from(wordSave(o.pdf, o.trailer, `/XRefStm ${o.xrefStreams[0]}`), "latin1"))).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[statement-analysis]"), { error: "RangeError" })
    warn.mockRestore()
  })
})
