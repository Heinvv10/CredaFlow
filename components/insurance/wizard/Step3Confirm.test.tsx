import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { Step3Confirm } from "./Step3Confirm"
import type { PolicyDraftData } from "./types"

// Fair Score audit row 117: the confirm step printed the locale format
// ("R 20 000,00") while the policy list prints "R 20,000.00".
const data = {
  clientId: "c1",
  advisorId: "a1",
  type: "FUNERAL_COVER",
  insurer: "Example Underwriters (fictional)",
  sumAssured: "20000",
  premiumAmount: "118",
  commissionRate: "20",
  startDate: "2026-10-01",
  linkedLoanRef: "",
} as unknown as PolicyDraftData

describe("Step3Confirm money format", () => {
  it("prints cover, premium and commission in the house format", () => {
    const html = renderToStaticMarkup(
      <Step3Confirm data={data} clients={[]} advisors={[]} error={null} submitting={false} onBack={vi.fn()} onSubmit={vi.fn()} />,
    )
    expect(html).toContain("R 20,000.00")
    expect(html).toContain("R 118.00")
    expect(html).toContain("R 23.60 a month")
    expect(html).not.toMatch(/R 20\s000,00/)
  })
})
