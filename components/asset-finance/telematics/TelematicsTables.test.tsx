import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))

import type { AlertRow } from "@/lib/telematics/alerts"
import type { HeldReadingRow } from "@/lib/telematics/held-readings"
import { AlertsTable, HeldReadingsTable } from "./TelematicsTables"

// The work queue at 390 px (browser review of PR #222): below md each row is
// a stacked card that carries its own actions, so nothing is scrolled off a
// narrow screen; the table is the md-and-up layout.
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })

async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(element) })
  return renderer
}
const buttonsIn = (node: ReactTestInstance) => node.findAllByType("button").map((b) => b.children.join(""))
const classOf = (node: ReactTestInstance) => String(node.props.className ?? "")

const alert: AlertRow = {
  id: "al-1", kind: "TAMPER", queue: "SERVICING", status: "OPEN", occurrences: 2, firstOccurredAt: new Date("2030-06-01T10:00:00Z"),
  lastOccurredAt: new Date("2030-06-02T10:00:00Z"), assetId: "as-1", assetLabel: "TEST EX-1 (SER1)", loanId: "loan-1", loanReference: "LN-1", simulated: true, resolutionNote: null,
}
const held: HeldReadingRow = {
  id: "h-1", loanId: "loan-1", loanReference: "LN-1", readingDate: "2030-06-01", value: 1_200, unit: "HOURS", reason: "LOWER", status: "HELD", simulated: true, decisionNote: null,
}

describe("tracker work queue on a narrow screen", () => {
  it("stacks each alert as a card with its actions, hidden from md up, beside the md-and-up table", async () => {
    const r = await render(<AlertsTable alerts={[alert]} canWork />)
    const cards = r.root.findByProps({ "data-testid": "alert-cards" })
    expect(classOf(cards)).toContain("md:hidden")
    expect(buttonsIn(cards)).toEqual(["Acknowledge", "Resolve"])
    expect(cards.findAllByType("a").map((a) => a.props.href)).toEqual(["/loans/loan-1", "/asset-finance/assets/as-1"])
    const table = r.root.findAllByType("table")[0]
    expect(classOf(table.parent!)).not.toContain("md:hidden")
    expect(r.root.findAll((n) => classOf(n) === "hidden md:block")).toHaveLength(1)
  })

  it("does the same for held readings, and shows no action without the permission", async () => {
    const r = await render(<HeldReadingsTable held={[held]} canManage />)
    expect(buttonsIn(r.root.findByProps({ "data-testid": "held-cards" }))).toEqual(["Accept", "Reject"])
    const readOnly = await render(<AlertsTable alerts={[alert]} canWork={false} />)
    expect(buttonsIn(readOnly.root)).toEqual([])
  })
})
