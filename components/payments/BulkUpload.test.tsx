// @vitest-environment jsdom
// jsdom for FileReader, which the full component reads the CSV with.
import { renderToStaticMarkup } from "react-dom/server"
import { act, create, type ReactTestInstance } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BulkUpload, BulkUploadRecorded } from "./BulkUpload"

describe("BulkUploadRecorded", () => {
  it("F5: says how many rows were held for reconciliation and recorded as refund due", () => {
    const html = renderToStaticMarkup(<BulkUploadRecorded
      held={[{ id: "h1", row: 2, loanRef: "LN-1", amount: 10_000, reason: "Default charges would re-open this settled loan" }]}
      refundDue={[{ id: "r1", row: 3, loanRef: "LN-2", amount: 500 }]}
    />)
    expect(html).toContain("1 held for reconciliation")
    expect(html).toContain("1 recorded as refund due")
    expect(html).toContain("Row 2 — LN-1")
  })

  it("renders nothing when every row booked normally", () => {
    expect(renderToStaticMarkup(<BulkUploadRecorded held={[]} refundDue={[]} />)).toBe("")
  })
})

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("")
}

describe("BulkUpload", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it("R6-2: shows the held and refund-due rows from the upload result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      processed: 0, skipped: 0, errors: [], payments: [],
      held: [{ id: "h1", row: 1, loanRef: "LN-1", amount: 20_000, reason: "Loan status is WRITTEN_OFF" }],
      refundDue: [{ id: "r1", row: 2, loanRef: "LN-2", amount: 5_000 }],
    }))))
    let tree!: ReturnType<typeof create>
    await act(async () => { tree = create(<BulkUpload />) })
    const csv = new File(["reference,amount,method\nLN-1,200,EFT\nLN-2,50,EFT\n"], "p.csv", { type: "text/csv" })
    await act(async () => {
      tree.root.findByProps({ type: "file" }).props.onChange({ target: { files: [csv] } })
    })
    await vi.waitFor(() => expect(text(tree.root)).toContain("Upload 2 payments"))
    const upload = tree.root.findAll((n) => n.type === "button" && text(n).startsWith("Upload "))[0]
    await act(async () => { await upload.props.onClick() })

    const shown = text(tree.root)
    expect(shown).toContain("1 held for reconciliation")
    expect(shown).toContain("Row 1 — LN-1")
    expect(shown).toContain("Loan status is WRITTEN_OFF")
    expect(shown).toContain("1 recorded as refund due")
    expect(shown).toContain("Row 2 — LN-2")
  })
})
