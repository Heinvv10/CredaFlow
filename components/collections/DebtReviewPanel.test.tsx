import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { DebtReviewPanel } from "./DebtReviewPanel"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const NOTICE = new Date("2026-10-01T00:00:00+02:00")
const render = (over: Partial<Parameters<typeof DebtReviewPanel>[0]> = {}) =>
  renderToStaticMarkup(<DebtReviewPanel loanId="loan-1" noticeAt={null} noticeRef={null} canManage {...over} />)

describe("DebtReviewPanel", () => {
  it("offers to record a notice when none is on file", () => {
    const html = render()
    expect(html).toContain("No debt-review notice recorded")
    expect(html).toContain("Record debt-review notice")
    expect(html).not.toContain("Under debt review")
  })

  it("shows the notice, its reference and that reminders are paused, and offers to clear it", () => {
    const html = render({ noticeAt: NOTICE, noticeRef: "DC-0001" })
    expect(html).toContain("Under debt review")
    expect(html).toContain("1 Oct 2026")
    expect(html).toContain("DC-0001")
    expect(html).toContain("Automated reminders to this borrower are paused")
    expect(html).toContain("Clear debt-review notice")
  })

  it("shows a recorded notice to a viewer who cannot manage it, with no control", () => {
    const html = render({ noticeAt: NOTICE, noticeRef: null, canManage: false })
    expect(html).toContain("Under debt review")
    expect(html).toContain("Not recorded")
    expect(html).not.toContain("Clear debt-review notice")
  })

  it("renders nothing for a viewer who cannot manage a loan with no notice", () => {
    expect(render({ canManage: false })).toBe("")
  })
})
