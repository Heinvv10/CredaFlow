import { describe, expect, it, vi } from "vitest"
import { recentStatementSince } from "./statement-needed"

// A returning client (Thembeka, Fair Score audit 2026-10-16): applied on
// 16 Oct with only April's statement on file. The credit checks read statements
// uploaded from 90 days before the application, so NO_STATEMENT blocks approval.

function db(applications: Date[], statements: Date[]) {
  return {
    loanApplication: { findMany: vi.fn(async () => applications.map((createdAt) => ({ createdAt }))) },
    clientDocument: { findMany: vi.fn(async () => statements.map((createdAt) => ({ createdAt }))) },
  } as unknown as Parameters<typeof recentStatementSince>[0]
}

const APPLIED = new Date("2026-10-16T08:00:00.000Z")
const WINDOW_START = new Date("2026-07-18T08:00:00.000Z")

describe("recentStatementSince", () => {
  it("asks for a statement when the only one on file predates the checks' window", async () => {
    expect(await recentStatementSince(db([APPLIED], [new Date("2026-04-10T06:00:00.000Z")]), "t1", "c1")).toEqual(WINDOW_START)
  })

  it("is satisfied by a statement inside the window, even one uploaded after applying", async () => {
    expect(await recentStatementSince(db([APPLIED], [new Date("2026-10-16T09:00:00.000Z")]), "t1", "c1")).toBeNull()
    expect(await recentStatementSince(db([APPLIED], [WINDOW_START]), "t1", "c1")).toBeNull()
  })

  it("asks nothing when no application awaits a decision", async () => {
    const reader = db([], [])
    expect(await recentStatementSince(reader, "t1", "c1")).toBeNull()
    expect(reader.loanApplication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", clientId: "c1", status: { in: ["SUBMITTED", "UNDER_REVIEW"] } },
    }))
  })
})
