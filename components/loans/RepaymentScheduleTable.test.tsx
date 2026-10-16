import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RepaymentScheduleTable } from "./RepaymentScheduleTable"
import { elizeScheduleAsAudited } from "@/lib/loan/__fixtures__/fairscore-audit-schedules"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

afterEach(() => { vi.useRealTimers() })

function badges(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody"))
  return body.split("<tr").slice(1).map((row) => row.split("<td")[8] ?? "")
}

describe("RepaymentScheduleTable", () => {
  it("shows Elize's unpaid future instalments as Upcoming, not the PARTIAL they were stored as", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-16T10:00:00.000Z"))
    const html = renderToStaticMarkup(
      <RepaymentScheduleTable loanId="loan-1" schedule={elizeScheduleAsAudited()} allowAdminActions />,
    )
    const shown = badges(html)
    expect(shown).toHaveLength(18)
    expect(shown[4]).toContain("PARTIAL")
    for (const cell of shown.slice(5)) {
      expect(cell).toContain("UPCOMING")
      expect(cell).not.toContain("PARTIAL")
    }
  })
})
