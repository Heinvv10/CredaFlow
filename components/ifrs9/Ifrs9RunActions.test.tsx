import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { Ifrs9RunActions } from "./Ifrs9RunActions"

describe("IFRS 9 run actions", () => {
  it("tells a non-administrator it needs one, and offers no run", () => {
    const html = renderToStaticMarkup(<Ifrs9RunActions months={[{ periodKey: "2026-09", currentRunId: null }]} canRun={false} />)
    expect(html).toContain("needs an administrator")
    expect(html).not.toContain("Run analysis now")
  })

  it("offers the analysis run and a late run for a month with none", () => {
    const html = renderToStaticMarkup(<Ifrs9RunActions months={[{ periodKey: "2026-09", currentRunId: null }]} canRun />)
    expect(html).toContain("Run analysis now")
    expect(html).toContain("2026-09 (no run yet)")
    expect(html).toContain("Add late run")
  })

  it("offers to replace the current run of a month that has one", () => {
    const html = renderToStaticMarkup(<Ifrs9RunActions months={[{ periodKey: "2026-09", currentRunId: "r1" }]} canRun />)
    expect(html).toContain("2026-09 (replace its run)")
    expect(html).toContain("Replace run")
  })

  it("has no month-end form when every ended month is closed", () => {
    const html = renderToStaticMarkup(<Ifrs9RunActions months={[]} canRun />)
    expect(html).toContain("Run analysis now")
    expect(html).not.toContain("Month-end run for an ended, open month")
  })
})
