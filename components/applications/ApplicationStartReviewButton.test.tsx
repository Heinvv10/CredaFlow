import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ApplicationStartReviewButton } from "./ApplicationStartReviewButton"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe("ApplicationStartReviewButton", () => {
  it("renders the start action for a submitted application", () => {
    const html = renderToStaticMarkup(
      <ApplicationStartReviewButton applicationId="application-1" />,
    )

    expect(html).toContain("Start Review")
    expect(html).not.toContain("Retry Bureau Enquiry")
  })

  it("renders an explicit bureau retry action for an application under review", () => {
    const html = renderToStaticMarkup(
      <ApplicationStartReviewButton applicationId="application-1" mode="retry" />,
    )

    expect(html).toContain("Retry Bureau Enquiry")
  })
})
