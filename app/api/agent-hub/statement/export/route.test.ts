import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import ExcelJS from "exceljs"

const requireApiRoleMock = vi.fn()
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...a: unknown[]) => requireApiRoleMock(...a) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_r: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }) }))
// Named mocks (same indirection as requireApiRoleMock above), not inline
// vi.fn().mockResolvedValue([]) in the factory: vi.resetAllMocks() below wipes
// an implementation set inside the factory (it only runs once, at import
// time), so an inline resolvedValue would silently become `undefined` after
// the first reset. Re-armed in beforeEach so every test starts from the same
// real-Prisma-shaped baseline ([] on a miss, never undefined).
const referralEventFindManyMock = vi.fn()
const loanFindManyMock = vi.fn()
const agentFindManyMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    referralEvent: { findMany: (...a: unknown[]) => referralEventFindManyMock(...a) },
    loan: { findMany: (...a: unknown[]) => loanFindManyMock(...a) },
    referralAgent: { findMany: (...a: unknown[]) => agentFindManyMock(...a) },
  },
}))
const logAuditStrictMock = vi.fn()
vi.mock("@/lib/audit", () => ({ logAuditStrict: (...a: unknown[]) => logAuditStrictMock(...a) }))

import { GET } from "./route"

const URL_BASE = "https://app.test/api/agent-hub/statement/export"

function eventFor(id: string, agentId: string | null, cents: number) {
  return {
    id,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    agentId,
    amountCents: 100000,
    commissionCents: cents,
    commissionStatus: "PENDING",
    metadata: {},
  }
}

describe("GET /api/agent-hub/statement/export", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "staff@example.invalid" } })
    logAuditStrictMock.mockResolvedValue(undefined)
    referralEventFindManyMock.mockResolvedValue([])
    loanFindManyMock.mockResolvedValue([])
    agentFindManyMock.mockResolvedValue([{ id: "a1", displayName: "Test Agent" }])
  })

  it("requires LOAN_ADMIN on the route itself", async () => {
    await GET(new NextRequest(`${URL_BASE}?agentId=a1`))
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
  })

  it("refuses when the guard rejects, and audits nothing", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response("no", { status: 403 }) })
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=a1`))
    expect(res.status).toBe(403)
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("rejects a missing agentId with 400", async () => {
    const res = await GET(new NextRequest(URL_BASE))
    expect(res.status).toBe(400)
  })

  it("rejects a blank agentId with 400 rather than exporting every agent", async () => {
    // `?agentId=` must not widen to the whole roster — absence is not "all".
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=`))
    expect(res.status).toBe(400)
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("audits every successful export", async () => {
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=a1`))
    expect(res.status).toBe(200)
    expect(logAuditStrictMock).toHaveBeenCalled()
  })

  // An unresolvable/foreign agentId (tenant-scoped lookup) must 404 before
  // any event query or audit write — no POPIA access-register row for an
  // agent that doesn't exist in this tenant, and no cuid-as-filename fallback.
  it("404s on an unknown or foreign agentId, and audits nothing", async () => {
    agentFindManyMock.mockResolvedValue([])
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=ghost`))
    expect(res.status).toBe(404)
    expect(referralEventFindManyMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("404s when only SOME requested agents resolve, rather than exporting a partial book", async () => {
    // The dangerous case: two ids asked for, one found. Returning 200 here
    // would hand back a workbook that looks complete but silently omits an
    // agent, and a payout run against it would short them.
    agentFindManyMock.mockResolvedValue([{ id: "a1", displayName: "Test Agent" }])
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=a1&agentId=ghost`))
    expect(res.status).toBe(404)
    expect(referralEventFindManyMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("writes ONE audit row per agent, keyed to that agent, on a multi-agent export", async () => {
    // POPIA: exporting three agents is three access events. A single row would
    // leave two agents with no record their commission history was read.
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Agent One" },
      { id: "a2", displayName: "Agent Two" },
      { id: "a3", displayName: "Agent Three" },
    ])
    referralEventFindManyMock.mockResolvedValue([eventFor("e1", "a1", 5000), eventFor("e2", "a1", 3000), eventFor("e3", "a2", 1000)])

    const res = await GET(new NextRequest(`${URL_BASE}?agentId=a1&agentId=a2&agentId=a3`))
    expect(res.status).toBe(200)
    expect(logAuditStrictMock).toHaveBeenCalledTimes(3)

    const byEntityId = new Map(
      logAuditStrictMock.mock.calls.map(([arg]) => [(arg as { entityId: string }).entityId, arg as { newValue: Record<string, unknown> }]),
    )
    expect([...byEntityId.keys()].sort()).toEqual(["a1", "a2", "a3"])
    // Each row reports THIS agent's rows, not the workbook's total.
    expect(byEntityId.get("a1")!.newValue.rowCount).toBe(2)
    expect(byEntityId.get("a2")!.newValue.rowCount).toBe(1)
    // An agent with no referrals in the period is still an access event, and
    // must be honest that nothing was found rather than be omitted.
    expect(byEntityId.get("a3")!.newValue.rowCount).toBe(0)
    expect(byEntityId.get("a1")!.newValue.exportScope).toBe("SELECTION")
    expect(byEntityId.get("a1")!.newValue.agentCount).toBe(3)
  })

  it("returns no bytes when an agent's audit write fails partway through", async () => {
    // The route claims a partial failure aborts the download, over-recording
    // access rather than under-recording it. Nothing verified that claim.
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Agent One" },
      { id: "a2", displayName: "Agent Two" },
      { id: "a3", displayName: "Agent Three" },
    ])
    logAuditStrictMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("audit store unavailable"))

    await expect(GET(new NextRequest(`${URL_BASE}?agentId=a1&agentId=a2&agentId=a3`))).rejects.toThrow(
      "audit store unavailable",
    )
    // Stopped at the failure: the third agent was never recorded, and no
    // workbook reached the caller.
    expect(logAuditStrictMock).toHaveBeenCalledTimes(2)
  })

  it("audits every agent on an all-agents export and marks the scope", async () => {
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Agent One" },
      { id: "a2", displayName: "Agent Two" },
    ])
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=__all__`))
    expect(res.status).toBe(200)
    expect(logAuditStrictMock).toHaveBeenCalledTimes(2)
    expect((logAuditStrictMock.mock.calls[0][0] as { newValue: { exportScope: string } }).newValue.exportScope).toBe("ALL_AGENTS")
  })

  it("does not filter events by agentId when exporting all agents", async () => {
    // "all" must omit the filter rather than pass the roster in an `in`, so an
    // agent created after the roster query still appears.
    agentFindManyMock.mockResolvedValue([{ id: "a1", displayName: "Agent One" }])
    await GET(new NextRequest(`${URL_BASE}?agentId=__all__`))
    const where = (referralEventFindManyMock.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where).not.toHaveProperty("agentId")
  })

  it("scopes the event query to the chosen agents when a selection is given", async () => {
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Agent One" },
      { id: "a2", displayName: "Agent Two" },
    ])
    await GET(new NextRequest(`${URL_BASE}?agentId=a1&agentId=a2`))
    const where = (referralEventFindManyMock.mock.calls[0][0] as { where: { agentId: { in: string[] } } }).where
    expect(where.agentId.in).toEqual(["a1", "a2"])
  })

  it("names a multi-agent workbook by its scope, not by one agent", async () => {
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Agent One" },
      { id: "a2", displayName: "Agent Two" },
    ])
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=a1&agentId=a2&from=2026-08-01&to=2026-08-31`))
    expect(res.headers.get("Content-Disposition")).toContain("2-agents")
  })

  it("keeps the single-agent filename unchanged", async () => {
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=a1&from=2026-08-01&to=2026-08-31`))
    expect(res.headers.get("Content-Disposition")).toContain("Test-Agent")
  })
})

// The status code, the audit rows and the filename can all be correct while the
// bytes the operator actually opens are wrong. These read the workbook back —
// same pattern as app/api/reports/export/route.test.ts — because the per-agent
// subtotal in this file IS the figure a payout is made against.
describe("GET /api/agent-hub/statement/export — workbook contents", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "staff@example.invalid" } })
    logAuditStrictMock.mockResolvedValue(undefined)
    referralEventFindManyMock.mockResolvedValue([])
    loanFindManyMock.mockResolvedValue([])
    agentFindManyMock.mockResolvedValue([{ id: "a1", displayName: "Test Agent" }])
  })

  async function sheetFrom(res: Response) {
    const workbook = new ExcelJS.Workbook()
    const bytes = (await res.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0]
    await workbook.xlsx.load(bytes)
    const worksheet = workbook.getWorksheet("Statement")
    if (!worksheet) throw new Error("Statement worksheet missing")
    const columns = new Map<string, number>()
    worksheet.getRow(1).eachCell((cell, column) => columns.set(cell.text, column))
    // Collected up front rather than assigned inside the eachRow callback:
    // TypeScript cannot track a closure assignment and narrows the captured
    // variable to `never`, which made every `.commission` read a type error.
    const borrowerCol = columns.get("Borrower") ?? 0
    const commissionCol = columns.get("Commission (R)") ?? 0
    const labelled: { label: string; commission: number }[] = []
    worksheet.eachRow((r) => {
      labelled.push({ label: r.getCell(borrowerCol).text, commission: Number(r.getCell(commissionCol).value ?? 0) })
    })
    const cellsIn = (label: string) => labelled.find((r) => r.label === label) ?? null
    return { worksheet, columns, cellsIn }
  }

  it("writes each agent's OWN subtotal, not the workbook total", async () => {
    // The mutation this exists to catch: using the grand total for every
    // "Subtotal — X" row. Both agents would then read 90.00 and a payout run
    // would overpay whoever is checked first.
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Agent One" },
      { id: "a2", displayName: "Agent Two" },
    ])
    referralEventFindManyMock.mockResolvedValue([
      eventFor("e1", "a1", 5000),
      eventFor("e2", "a1", 3000),
      eventFor("e3", "a2", 1000),
    ])

    const res = await GET(new NextRequest(`${URL_BASE}?agentId=a1&agentId=a2`))
    const { cellsIn } = await sheetFrom(res)

    expect(cellsIn("Subtotal — Agent One")?.commission).toBe(80)
    expect(cellsIn("Subtotal — Agent Two")?.commission).toBe(10)
    expect(cellsIn("Net owed (all selected agents)")?.commission).toBe(90)
  })

  it("subtotals in the workbook sum to the grand total in the workbook", async () => {
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Agent One" },
      { id: "a2", displayName: "Agent Two" },
    ])
    referralEventFindManyMock.mockResolvedValue([
      eventFor("e1", "a1", 5000),
      eventFor("e2", "a2", 2500),
    ])
    const res = await GET(new NextRequest(`${URL_BASE}?agentId=a1&agentId=a2`))
    const { cellsIn } = await sheetFrom(res)
    const one = cellsIn("Subtotal — Agent One")!.commission
    const two = cellsIn("Subtotal — Agent Two")!.commission
    expect(one + two).toBe(cellsIn("Net owed (all selected agents)")!.commission)
  })

  it("adds the Agent column only on a multi-agent workbook", async () => {
    agentFindManyMock.mockResolvedValue([
      { id: "a1", displayName: "Agent One" },
      { id: "a2", displayName: "Agent Two" },
    ])
    referralEventFindManyMock.mockResolvedValue([eventFor("e1", "a1", 5000)])
    const { columns, worksheet } = await sheetFrom(await GET(new NextRequest(`${URL_BASE}?agentId=a1&agentId=a2`)))
    expect(columns.has("Agent")).toBe(true)
    // The row must actually carry the name, not just declare the column.
    const agentCol = columns.get("Agent")!
    expect(worksheet.getRow(2).getCell(agentCol).text).toBe("Agent One")
  })

  it("omits the Agent column and keeps the original footer on a single-agent workbook", async () => {
    referralEventFindManyMock.mockResolvedValue([eventFor("e1", "a1", 5000)])
    const { columns, cellsIn } = await sheetFrom(await GET(new NextRequest(`${URL_BASE}?agentId=a1`)))
    expect(columns.has("Agent")).toBe(false)
    expect(cellsIn("Net owed (pending + payable)")?.commission).toBe(50)
    // A single-agent workbook must not grow subtotal rows.
    expect(cellsIn("Subtotal — Test Agent")).toBeNull()
  })

  it("attributes and audits an agent whose rows are in the workbook but not in the roster", async () => {
    // The all-agents query is deliberately unfiltered by agentId, so an event
    // whose agentId is absent from the roster still lands in the workbook. The
    // live source is the snapshot race between the roster and events queries
    // (an agent created between them); ON DELETE SET NULL is NOT the source —
    // it nulls the column, which is the separate "Unassigned" case also
    // covered below. Before this was fixed, the
    // roster drove the layout: no Agent column, no subtotals, and one lump
    // "Net owed" of R11,160 on a statement whose only named agent was owed R50.
    agentFindManyMock.mockResolvedValue([{ id: "a1", displayName: "Real Agent" }])
    referralEventFindManyMock.mockResolvedValue([
      eventFor("e1", "a1", 5000),
      eventFor("e2", "orphan-agent-id", 999900),
      eventFor("e3", null, 111100),
    ])

    const res = await GET(new NextRequest(`${URL_BASE}?agentId=__all__`))
    const { columns, cellsIn } = await sheetFrom(res)

    // Attribution is present, so the rows cannot read as one agent's.
    expect(columns.has("Agent")).toBe(true)
    expect(cellsIn("Subtotal — Real Agent")?.commission).toBe(50)
    // Unattributable money is visible under its own heading rather than folded
    // silently into a total someone would pay against.
    expect(cellsIn("Subtotal — Unknown agent")?.commission).toBe(9999)
    expect(cellsIn("Subtotal — Unassigned")?.commission).toBe(1111)

    // Every agent whose rows are inside the file has an access record.
    const entityIds = logAuditStrictMock.mock.calls.map(([a]) => (a as { entityId: string }).entityId)
    expect(entityIds).toContain("a1")
    expect(entityIds).toContain("orphan-agent-id")
    // The grouping bucket is not a person and must never be written as one.
    expect(entityIds).not.toContain("__unknown__")
  })

  it("writes commission as a summable number, not a formatted string", async () => {
    referralEventFindManyMock.mockResolvedValue([eventFor("e1", "a1", 5000)])
    const { worksheet, columns } = await sheetFrom(await GET(new NextRequest(`${URL_BASE}?agentId=a1`)))
    const cell = worksheet.getRow(2).getCell(columns.get("Commission (R)")!)
    expect(typeof cell.value).toBe("number")
    expect(cell.value).toBe(50)
  })
})

describe("GET /api/agent-hub/statement/export — selection bounds", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "staff@example.invalid" } })
    logAuditStrictMock.mockResolvedValue(undefined)
    referralEventFindManyMock.mockResolvedValue([])
    loanFindManyMock.mockResolvedValue([])
    agentFindManyMock.mockResolvedValue([{ id: "a1", displayName: "Test Agent" }])
  })

  it("rejects more agents than the cap without touching the database", async () => {
    const params = Array.from({ length: 201 }, (_, i) => `agentId=agent-${i}`).join("&")
    const res = await GET(new NextRequest(`${URL_BASE}?${params}`))
    expect(res.status).toBe(400)
    expect(agentFindManyMock).not.toHaveBeenCalled()
    expect(referralEventFindManyMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("accepts one agent repeated past the cap, because the cap counts distinct agents", async () => {
    const params = Array.from({ length: 250 }, () => "agentId=a1").join("&")
    const res = await GET(new NextRequest(`${URL_BASE}?${params}`))
    expect(res.status).toBe(200)
    expect(logAuditStrictMock).toHaveBeenCalledTimes(1)
  })
})
