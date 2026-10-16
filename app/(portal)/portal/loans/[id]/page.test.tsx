import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, it, expect, vi } from "vitest"

const { portalLoanCharges } = vi.hoisted(() => ({ portalLoanCharges: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/portal/loan-charges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/loan-charges")>()),
  portalLoanCharges,
}))
const { loanFindFirst } = vi.hoisted(() => ({ loanFindFirst: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    loan: { findFirst: loanFindFirst },
  },
}))
const defaultedLoan = () => ({
  id: "l1", clientId: "c1", tenantId: "t1", reference: "LN-1", status: "DEFAULTED" as string, daysInArrears: 25,
  principal: 200_000, totalRepayable: 216_900, totalPaid: 47_000, outstandingPrincipal: 169_900,
  product: { name: "Micro" }, payments: [],
  repaymentSchedule: [{
    id: "r1", installmentNo: 1, dueDate: new Date("2026-09-01"), totalDue: 216_900, totalPaid: 47_000,
    status: "PARTIAL",
  }],
})

import PortalLoanPage from "./page"
import { elizeScheduleAsAudited, kabeloScheduleAsAudited } from "@/lib/loan/__fixtures__/fairscore-audit-schedules"

const render = async () =>
  renderToStaticMarkup(await PortalLoanPage({ params: Promise.resolve({ id: "l1" }) }))
    .replace(/<!-- -->/g, "")

describe("portal loan page", () => {
  beforeEach(() => { loanFindFirst.mockResolvedValue(defaultedLoan()) })

  it("says what default charges the next payment amount includes", async () => {
    portalLoanCharges.mockResolvedValue({
      outstanding: 3_000, lines: [{ label: "Default interest", amount: 3_000 }], settlementAmount: 172_900,
    })
    const html = await render()
    const card = html.slice(html.indexOf("Next Payment Amount"))
    expect(card.slice(0, card.indexOf("</div>"))).toContain("Includes: Default interest R")
  })

  it("adds no line when no charges are owed", async () => {
    portalLoanCharges.mockResolvedValue({ outstanding: 0, lines: [], settlementAmount: null })
    expect(await render()).not.toContain("Includes:")
  })

  it("states a reversed (CANCELLED) loan's instalments as cancelled with R 0.00 due, and no instalment owed", async () => {
    portalLoanCharges.mockResolvedValue({ outstanding: 0, lines: [], settlementAmount: null })
    const base = defaultedLoan()
    loanFindFirst.mockResolvedValue({
      ...base, status: "CANCELLED", daysInArrears: 0, totalPaid: 0, outstandingPrincipal: 0,
      repaymentSchedule: [{ ...base.repaymentSchedule[0], totalPaid: 0, status: "CANCELLED" }],
    })
    const html = await render()
    expect(html).not.toContain("2,169.00")
    expect(html).not.toContain("2 169,00")
    const row = html.slice(html.indexOf("<tbody>"))
    expect(row).toContain("CANCELLED")
    expect(row).toMatch(/R\s?0[.,]00/)
    expect(html).not.toContain("/portal/payment")
    expect(html).not.toContain("Make a Payment")
  })

  it("offers a payment on a loan that is owed", async () => {
    portalLoanCharges.mockResolvedValue({ outstanding: 0, lines: [], settlementAmount: null })
    expect(await render()).toContain("/portal/payment")
  })

  it("shows Elize's future instalments as Upcoming, not Partial, although stored PARTIAL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-16T10:00:00.000Z"))
    portalLoanCharges.mockResolvedValue({ outstanding: 0, lines: [], settlementAmount: null })
    loanFindFirst.mockResolvedValue({
      ...defaultedLoan(), status: "ACTIVE", daysInArrears: 29,
      repaymentSchedule: elizeScheduleAsAudited(),
    })
    let html: string
    try {
      html = await render()
    } finally {
      vi.useRealTimers()
    }
    const body = html.slice(html.indexOf("<tbody>"))
    const rows = body.slice(0, body.indexOf("</tbody>")).split("<tr").slice(1)
    expect(rows).toHaveLength(18)
    expect(rows[4]).toContain("PARTIAL · OVERDUE")
    expect(rows[4]).toContain("bg-red-100")
    for (const row of rows.slice(5)) {
      expect(row).toContain("UPCOMING")
      expect(row).not.toContain("PARTIAL")
    }
  })

  it("shows Kabelo's unpaid past-due instalments as Overdue in red, from the due date not the stored status", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-16T10:00:00.000Z"))
    portalLoanCharges.mockResolvedValue({ outstanding: 0, lines: [], settlementAmount: null })
    loanFindFirst.mockResolvedValue({
      ...defaultedLoan(), status: "ACTIVE", daysInArrears: 137,
      // Stored PENDING, as the writers now store an unpaid row.
      repaymentSchedule: kabeloScheduleAsAudited().map((r) => (r.status === "PARTIAL" ? { ...r, status: "PENDING" } : r)),
    })
    let html: string
    try {
      html = await render()
    } finally {
      vi.useRealTimers()
    }
    const body = html.slice(html.indexOf("<tbody>"))
    const rows = body.slice(0, body.indexOf("</tbody>")).split("<tr").slice(1)
    // #4–#8 fell due 1 Jun–1 Oct 2026; #9 (1 Nov) is not yet due.
    for (const row of rows.slice(3, 8)) {
      expect(row).toContain(">OVERDUE<")
      expect(row).toContain("bg-red-100")
    }
    expect(rows[8]).toContain("UPCOMING")
  })

  // Fair Score audit 2026-10-16: the badge read the cron-stamped 27 days.
  it("counts the days overdue as of today from the schedule", async () => {
    portalLoanCharges.mockResolvedValue({ outstanding: 0, lines: [], settlementAmount: null })
    vi.useFakeTimers({ now: new Date("2026-10-16T10:00:00Z"), toFake: ["Date"] })
    try {
      const base = defaultedLoan()
      loanFindFirst.mockResolvedValue({
        ...base, status: "ACTIVE", daysInArrears: 27,
        repaymentSchedule: [{ ...base.repaymentSchedule[0], dueDate: new Date("2026-09-17T06:30:01Z"), principalDue: 166_900, interestDue: 50_000, feesDue: 0 }],
      })
      const html = await render()
      expect(html).toContain("29 days overdue")
      expect(html).not.toContain("27 days overdue")
    } finally {
      vi.useRealTimers()
    }
  })
})
