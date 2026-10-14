import ExcelJS from "exceljs"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { facts, statement, tx } from "@/lib/credit-checks/facts.test-helpers"
import { computeInsights } from "@/lib/statement-analysis/insights"

const authMock = vi.fn()
const findApplication = vi.fn()
const insightsMock = vi.fn()
const logAccessMock = vi.fn()
const auditMock = vi.fn()

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findFirst: (a: unknown) => findApplication(a) } } }))
vi.mock("@/lib/credit-checks/statement-insights", () => ({ applicationStatementInsights: (...a: unknown[]) => insightsMock(...a) }))
vi.mock("@/lib/document-auth", () => ({ logDocumentContentAccess: (a: unknown) => logAccessMock(a) }))
vi.mock("@/lib/audit", () => ({ AuditAction: { STATEMENT_EXPORTED: "STATEMENT_EXPORTED" }, logAuditStrict: (a: unknown) => auditMock(a) }))

import { GET } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }
const url = "https://acme.example/api/applications/app-1/statement-export"
const get = (headers: Record<string, string> = {}) => GET(new NextRequest(url, { headers }), ctx)
const session = (role: string) => ({ user: { id: "u1", email: "officer@test.invalid", role, tenantId: "t1" } })

function loaded() {
  const s = statement([tx("2026-07-02", "Card Purchase: SHOPRITE", -84_550), tx("2026-07-25", "Payment Received: SALARY SYNTHCO", 1_845_000)])
  const f = facts({ statements: [s], declaredExpensesCents: 300_000 })
  const insights = computeInsights([{ documentId: s.documentId, bank: s.bank, balanceCheck: s.balanceCheck, read: s.read! }], { clientName: f.clientName, declaredExpensesCents: 300_000 })
  return { facts: f, insights, read: [s], unread: 0 }
}

beforeEach(() => {
  vi.resetAllMocks()
  authMock.mockResolvedValue(session("CREDIT_OFFICER"))
  findApplication.mockResolvedValue({ reference: "APP-2026-0001" })
  insightsMock.mockResolvedValue(loaded())
  logAccessMock.mockResolvedValue(undefined)
  auditMock.mockResolvedValue(undefined)
})

describe("GET /api/applications/[id]/statement-export", () => {
  it("returns an .xlsx named by the application reference, with Summary, Transactions and Monthly sheets", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="statements-APP-2026-0001-\d{4}-\d{2}-\d{2}\.xlsx"$/)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Transactions", "Monthly"])
    const tx = wb.getWorksheet("Transactions")!
    expect(JSON.stringify((tx.getRow(2).values as unknown[]).slice(1))).toBe(JSON.stringify([1, "2026-07-02", "Card Purchase: SHOPRITE", -845.5, 154.5, "FOOD", 1, "yes"]))
    expect(wb.getWorksheet("Monthly")!.getRow(2).getCell(1).value).toBe("2026-07")
    // Money-out columns only: no income category can hold a debit.
    expect((wb.getWorksheet("Monthly")!.getRow(1).values as unknown[]).join("|")).not.toMatch(/SALARY_INCOME|OTHER_INCOME/)
    expect(wb.getWorksheet("Summary")!.getRow(7).getCell(7).value).toBe("PASS")
  })

  it("strips the reference to safe filename characters and is never cached", async () => {
    findApplication.mockResolvedValue({ reference: 'APP/1"; x=y' })
    const res = await get()
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="statements-APP1xy-\d{4}-\d{2}-\d{2}\.xlsx"$/)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it("writes an access-log row for every statement and an audit row, before serving the file", async () => {
    await get()
    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({ documentIds: ["doc-1"], staffUserId: "u1", action: "statement_export" }))
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", userId: "u1", action: "STATEMENT_EXPORTED", entity: "LoanApplication", entityId: "app-1" }))
  })

  it("serves nothing when the audit row cannot be written", async () => {
    auditMock.mockRejectedValue(new Error("db down"))
    await expect(get()).rejects.toThrow("db down")
  })

  it("refuses READONLY staff (403) and a client session", async () => {
    authMock.mockResolvedValue(session("READONLY"))
    expect((await get()).status).toBe(403)
    authMock.mockResolvedValue(session("CLIENT"))
    expect((await get()).status).toBe(403)
    expect(insightsMock).not.toHaveBeenCalled()
    expect(logAccessMock).not.toHaveBeenCalled()
  })

  it("is CREDIT_OFFICER and up: the role just below is refused, the one above allowed, no session is 401", async () => {
    authMock.mockResolvedValue(session("INSURANCE_OFFICER"))
    expect((await get()).status).toBe(403)
    authMock.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
    expect(insightsMock).not.toHaveBeenCalled()
    authMock.mockResolvedValue(session("LOAN_ADMIN"))
    expect((await get()).status).toBe(200)
  })

  it("refuses a cross-site request before anything else", async () => {
    expect((await get({ "sec-fetch-site": "cross-site" })).status).toBe(403)
    expect(authMock).not.toHaveBeenCalled()
  })

  it("is tenant-scoped: another tenant's application is not found and nothing is logged", async () => {
    findApplication.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
    expect(findApplication).toHaveBeenCalledWith({ where: { id: "app-1", tenantId: "t1" }, select: { reference: true } })
    expect(logAccessMock).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
  })
})
