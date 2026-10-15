import { beforeEach, describe, expect, it, vi } from "vitest"

type Row = { id: string; status: string; route: string; recoveredOn: Date; withdrawnReason: string | null; createdAt: number }
const mocks = vi.hoisted(() => ({ rows: [] as Row[], surrenders: [] as { id: string; requestedOn: Date }[], loan: { ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE" } }))

// A fake recovery table that honours the status filters the loader passes (a plain status, `not`, `notIn`), newest first when asked.
const matches = (row: Row, where: { status?: string | { not?: string; notIn?: string[] } }) => {
  const status = where.status
  if (status === undefined) return true
  if (typeof status === "string") return row.status === status
  return (status.not === undefined || row.status !== status.not) && (status.notIn === undefined || !status.notIn.includes(row.status))
}
const ordered = (rows: Row[], orderBy?: unknown) => (orderBy ? [...rows].sort((a, b) => b.createdAt - a.createdAt) : rows)
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findFirst: async () => mocks.loan },
    recovery: {
      findFirst: async ({ where, orderBy }: { where: Parameters<typeof matches>[1]; orderBy?: unknown }) => ordered(mocks.rows, orderBy).find((r) => matches(r, where)) ?? null,
      findMany: async ({ where, orderBy }: { where: Parameters<typeof matches>[1]; orderBy?: unknown }) => ordered(mocks.rows, orderBy).filter((r) => matches(r, where)),
    },
    surrenderRequest: { findMany: async () => mocks.surrenders, findFirst: async () => null },
  },
}))
const viewCalls: unknown[][] = []
vi.mock("@/lib/asset-finance/recovery-view", () => ({ loadStaffRecoveryView: async (...args: unknown[]) => { viewCalls.push(args); return { id: args[1], surrenderRequestId: null } } }))
vi.mock("@/lib/asset-finance/legal-matter-view", () => ({ getLegalMatterView: vi.fn() }))

import { loadRecoveryPanelData } from "./recovery-panel-data"

const row = (id: string, status: string, createdAt: number, over: Partial<Row> = {}): Row => ({
  id, status, createdAt, route: "NON_NCA_VOLUNTARY", recoveredOn: new Date("2026-10-01T00:00:00Z"), withdrawnReason: null, ...over,
})

beforeEach(() => {
  viewCalls.length = 0
  mocks.rows = []
  mocks.surrenders = []
  mocks.loan = { ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE" }
})

describe("loadRecoveryPanelData", () => {
  it("shows the live recovery, ignoring older withdrawn ones", async () => {
    mocks.rows = [row("old", "WITHDRAWN", 1, { withdrawnReason: "Debtor paid in full" }), row("live", "LISTED", 2)]
    expect(await loadRecoveryPanelData("t-1", "l-1")).toMatchObject({ kind: "recovery", view: { id: "live" } })
  })

  it("asks for the refund's bank details only when told to (a manager), and never by default", async () => {
    mocks.rows = [row("live", "SURPLUS_HELD", 1)]
    await loadRecoveryPanelData("t-1", "l-1")
    await loadRecoveryPanelData("t-1", "l-1", { bankDetails: true })
    expect(viewCalls.map((c) => c[2])).toEqual([{ bankDetails: false }, { bankDetails: true }])
  })

  it("offers the record form again when the latest recovery is withdrawn, with the withdrawn one as history", async () => {
    mocks.rows = [row("w1", "WITHDRAWN", 1, { withdrawnReason: "Debtor paid in full" })]
    const data = await loadRecoveryPanelData("t-1", "l-1")
    expect(data).toMatchObject({ kind: "record", canRecord: true, withdrawn: [{ id: "w1", reason: "Debtor paid in full", recoveredOn: "2026-10-01", route: "NON_NCA_VOLUNTARY" }] })
  })

  it("keeps a closed recovery as the current one", async () => {
    mocks.rows = [row("done", "CLOSED", 1)]
    expect(await loadRecoveryPanelData("t-1", "l-1")).toMatchObject({ kind: "recovery", view: { id: "done" } })
  })

  it("shows only the history for an NCA loan with no surrender left to follow", async () => {
    mocks.loan = { ncaRegime: "NCA", contractType: "INSTALMENT_SALE" }
    mocks.rows = [row("w1", "WITHDRAWN", 1, { route: "NCA_S127_SURRENDER", withdrawnReason: "Surrender withdrawn by the debtor" })]
    expect(await loadRecoveryPanelData("t-1", "l-1")).toMatchObject({ kind: "record", canRecord: false, withdrawn: [{ route: "NCA_S127_SURRENDER" }] })
  })

  it("offers an NCA loan's surrenders that have no recovery, and shows nothing when there is neither a surrender nor history", async () => {
    mocks.loan = { ncaRegime: "NCA", contractType: "INSTALMENT_SALE" }
    expect(await loadRecoveryPanelData("t-1", "l-1")).toEqual({ kind: "none" })
    mocks.surrenders = [{ id: "s-1", requestedOn: new Date("2026-10-02T00:00:00Z") }]
    expect(await loadRecoveryPanelData("t-1", "l-1")).toMatchObject({ kind: "record", canRecord: true, surrenders: [{ value: "s-1" }] })
  })
})
