import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import ExcelJS from "exceljs"

const requireApiRoleMock = vi.fn()
const getTenantFromRequestMock = vi.fn()
const complianceFindManyMock = vi.fn()
const auditFindManyMock = vi.fn()
const userFindManyMock = vi.fn()
const queryRawMock = vi.fn()
const logAuditMock = vi.fn()
const logAuditStrictMock = vi.fn()
const loanFindManyMock = vi.fn()
const applicationFindManyMock = vi.fn()
const getNcrReturnDataMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const policyFindManyMock = vi.fn()
const complaintFindManyMock = vi.fn()
const scheduleFindManyMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (role: string) => requireApiRoleMock(role),
}))
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: (req: unknown) => getTenantFromRequestMock(req),
  getTenantConfig: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    complianceRecord: {
      findMany: (args: unknown) => complianceFindManyMock(args),
    },
    loan: {
      findMany: (args: unknown) => loanFindManyMock(args),
    },
    loanApplication: {
      findMany: (args: unknown) => applicationFindManyMock(args),
    },
    tenantConfig: {
      findUnique: (args: unknown) => tenantConfigFindUniqueMock(args),
    },
    insurancePolicy: {
      findMany: (args: unknown) => policyFindManyMock(args),
    },
    complaint: {
      findMany: (args: unknown) => complaintFindManyMock(args),
    },
    branch: { findMany: async () => [] },
    repaymentSchedule: { findMany: (args: unknown) => scheduleFindManyMock(args) },
    payment: { findMany: async () => [] },
    auditLog: {
      findMany: (args: unknown) => auditFindManyMock(args),
    },
    user: {
      findMany: (args: unknown) => userFindManyMock(args),
    },
    $queryRaw: (query: unknown) => queryRawMock(query),
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => logAuditMock(args),
  logAuditStrict: (args: unknown) => logAuditStrictMock(args),
}))

vi.mock("@/lib/compliance/ncr-return", async () => {
  const actual = await vi.importActual<typeof import("@/lib/compliance/ncr-return")>(
    "@/lib/compliance/ncr-return",
  )
  return { ...actual, getNcrReturnData: (...a: unknown[]) => getNcrReturnDataMock(...a) }
})

import { GET } from "./route"
import { collectionsQueueWhere } from "@/lib/collections/queue"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

function request(query = "type=section129-log") {
  return new NextRequest(`https://staging.example.test/api/reports/export?${query}`)
}

const record = {
  id: "notice-1",
  referenceId: "loan-1",
  status: "COMPLETED",
  completedAt: new Date("2026-07-20T08:05:00.000Z"),
  createdAt: new Date("2026-07-20T08:00:00.000Z"),
  data: {
    lifecycle: "ISSUED",
    loanReference: "LN-1",
    clientName: "Synthetic Client",
    clientEmail: "synthetic@example.test",
    arrearsAmount: 20_000,
    outstandingPrincipal: 100_000,
    daysInArrears: 95,
    issuedAt: "2026-07-20T08:05:00.000Z",
  },
}

describe("GET reports export — compliance evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockImplementation(async (role: string) => ({
      user: role === "LOAN_ADMIN"
        ? { id: "admin-1", tenantId: "tenant-1", email: "admin@example.test", role: "LOAN_ADMIN" }
        : { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" },
    }))
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    complianceFindManyMock.mockResolvedValue([record])
    auditFindManyMock.mockResolvedValue([])
    userFindManyMock.mockResolvedValue([])
    queryRawMock.mockResolvedValue([])
    logAuditMock.mockResolvedValue(undefined)
    logAuditStrictMock.mockResolvedValue(undefined)
  })

  it("requires LOAN_ADMIN and strictly audits the PII-rich export before returning bytes", async () => {
    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("spreadsheetml")
    expect(requireApiRoleMock.mock.calls.map(([role]) => role)).toEqual(["READONLY", "LOAN_ADMIN"])
    expect(complianceFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", type: "SECTION_129_NOTICE" },
    }))
    expect(logAuditStrictMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      userId: "admin-1",
      userEmail: "admin@example.test",
      action: "SECTION_129_REGISTER_EXPORTED",
      entity: "ComplianceRecord",
      newValue: { rowCount: 1 },
    })
  })

  it("denies a READONLY viewer before querying or generating the register", async () => {
    requireApiRoleMock.mockImplementation(async (role: string) => role === "LOAN_ADMIN"
      ? { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
      : { user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } })

    const response = await GET(request())

    expect(response.status).toBe(403)
    expect(complianceFindManyMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("fails closed when export-access evidence cannot be persisted", async () => {
    logAuditStrictMock.mockRejectedValue(new Error("audit unavailable"))

    await expect(GET(request())).rejects.toThrow("audit unavailable")
  })

  it("exports visible document-access evidence with entity, staff, search, and date filters", async () => {
    queryRawMock.mockResolvedValue([{
      id: "access-1",
      documentId: "document-1",
      accessorType: "staff",
      accessorId: "staff-1",
      action: "download",
      ipAddress: "127.0.0.2",
      userAgent: "test-agent",
      createdAt: new Date("2026-07-20T08:05:00.000Z"),
    }])
    userFindManyMock.mockResolvedValue([{
      id: "staff-1",
      name: "Review Officer",
      email: "review@acme-lending.example",
    }])

    const response = await GET(request([
      "type=audit-log",
      "entity=ClientDocument",
      "userId=staff-1",
      "search=DOCUMENT_DOWNLOAD",
      "from=2026-07-01",
      "to=2026-07-31",
    ].join("&")))

    expect(response.status).toBe(200)
    expect(auditFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-1",
        entity: "ClientDocument",
        userId: "staff-1",
        createdAt: expect.objectContaining({ gte: expect.any(Date), lte: expect.any(Date) }),
        OR: expect.any(Array),
      }),
    }))
    expect(userFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1" },
    }))
    const sql = queryRawMock.mock.calls[0][0] as { strings: readonly string[]; values: unknown[] }
    expect(sql.strings.join(" ")).toMatch(/document\."tenantId" =/)
    expect(sql.strings.join(" ")).toMatch(/access\."accessorId" =/)
    expect(sql.strings.join(" ")).toMatch(/REGEXP_REPLACE/)
    expect(sql.values).toContain("tenant-1")
    expect(sql.values).toContain("staff-1")
    expect(sql.values).toContain("%DOCUMENT_DOWNLOAD%")

    const workbook = new ExcelJS.Workbook()
    const workbookBytes = await response.arrayBuffer() as unknown as Parameters<
      typeof workbook.xlsx.load
    >[0]
    await workbook.xlsx.load(workbookBytes)
    const worksheet = workbook.getWorksheet("Audit Log")
    expect(worksheet).toBeDefined()
    const columns = new Map<string, number>()
    worksheet?.getRow(1).eachCell((cell, column) => columns.set(cell.text, column))
    expect(worksheet?.getRow(2).getCell(columns.get("Action") ?? 0).text).toBe("DOCUMENT_DOWNLOAD")
    expect(worksheet?.getRow(2).getCell(columns.get("Entity") ?? 0).text).toBe("ClientDocument")
    expect(worksheet?.getRow(2).getCell(columns.get("Actor") ?? 0).text).toBe("review@acme-lending.example")
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "AUDIT_LOG_EXPORTED",
      newValue: expect.objectContaining({ rowCount: 1 }),
    }))
  })

  it("H4: hides STR rows from a LOAN_ADMIN's audit export, but not from the FIC compliance role", async () => {
    await GET(request("type=audit-log&entity=SuspiciousReportCase"))
    expect(auditFindManyMock).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        entity: "SuspiciousReportCase",
        AND: [{ NOT: [{ entity: "SuspiciousReportCase" }, { action: { startsWith: "STR_" } }] }],
      }),
    }))
    requireApiRoleMock.mockImplementation(async () => ({ user: { id: "co-1", tenantId: "tenant-1", email: "co@example.test", role: "ADMIN" } }))
    await GET(request("type=audit-log&entity=SuspiciousReportCase"))
    expect(auditFindManyMock.mock.lastCall?.[0]).not.toHaveProperty("where.AND")
  })

  it("does not query document access for a non-document entity export", async () => {
    const response = await GET(request("type=audit-log&entity=Loan"))

    expect(response.status).toBe(200)
    expect(queryRawMock).not.toHaveBeenCalled()
    expect(userFindManyMock).not.toHaveBeenCalled()
  })

  it("does not return audit workbook bytes when export-access evidence cannot be persisted", async () => {
    logAuditStrictMock.mockRejectedValue(new Error("audit unavailable"))

    await expect(GET(request("type=audit-log&entity=Loan"))).rejects.toThrow(
      "audit unavailable",
    )
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "AUDIT_LOG_EXPORTED",
    }))
  })
})

describe("GET reports export — ncr-quarterly workbook", () => {
  const ncrLines = [
    {
      key: "newAgreements", label: "New credit agreements entered",
      count: 7, value: 700_00, basis: "PERIOD" as const,
      note: "Principal advanced, by agreement start date.",
    },
    {
      key: "arrears", label: "Accounts in arrears (1+ days)",
      count: 8, value: 50_00, basis: "POSITION" as const, percentOfBook: 50,
      note: "Value is the arrears balance; the percentage is exposure at risk.",
    },
  ]

  const ncrData = {
    quarter: "2026-Q1",
    periodStart: new Date("2025-12-31T22:00:00Z"),
    periodEnd: new Date("2026-03-31T21:59:59.999Z"),
    quarterOpen: false,
    ncrNumber: ACME_LENDER.ncrNumber,
    collectibleBook: { count: 20, value: 1000_00 },
    lines: ncrLines,
    submittedAt: null,
    submittedByName: null,
    filed: null,
    positionIsStale: true,
  }

  const loanRow = {
    reference: "LN-1",
    principal: 500_00,
    interestRatePm: 5,
    outstandingPrincipal: 400_00,
    arrearsAmount: 50_00,
    daysInArrears: 40,
    startDate: new Date("2026-02-01T08:00:00Z"),
    client: { idNumber: "8801015000088", firstName: "Thandiwe", lastName: "Mokoena" },
    product: { name: "Short-Term Loan" },
  }

  async function sheets(res: Response) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    return wb
  }

  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockImplementation(async (role: string) => ({
      user: role === "LOAN_ADMIN"
        ? { id: "admin-1", tenantId: "tenant-1", email: "admin@example.test", role: "LOAN_ADMIN" }
        : { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" },
    }))
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    loanFindManyMock.mockResolvedValue([loanRow])
    getNcrReturnDataMock.mockResolvedValue(ncrData)
    logAuditStrictMock.mockResolvedValue(undefined)
  })

  it("draws every summary figure from the shared NCR source for the requested quarter", async () => {
    const res = await GET(request("type=ncr-quarterly&quarter=2026-Q1"))
    expect(res.status).toBe(200)
    expect(getNcrReturnDataMock).toHaveBeenCalledWith("tenant-1", "2026-Q1", expect.any(Date))
  })

  it("coerces an out-of-range quarter rather than querying it", async () => {
    await GET(request("type=ncr-quarterly&quarter=1999-Q1"))
    expect(getNcrReturnDataMock.mock.calls[0][1]).not.toBe("1999-Q1")
  })

  it("puts provenance on its own sheet so the figures keep one column shape", async () => {
    // Mixing {Metric, Value} header rows with the figure rows previously put
    // money in column B for the header block and column D for every figure,
    // because createWorkbook unions the keys of all rows.
    const wb = await sheets(await GET(request("type=ncr-quarterly&quarter=2026-Q1")))
    const names = wb.worksheets.map((w) => w.name)
    expect(names).toEqual(["Return Info", "NCR Summary", "Disbursements", "Arrears Register"])

    const summary = wb.getWorksheet("NCR Summary")!
    const header = (summary.getRow(1).values as unknown[]).slice(1)
    expect(header).toEqual(["Line", "Basis", "Count", "Value (R)", "% of book", "Note"])
    // Every figure row fills the same columns.
    for (const rowNum of [2, 3]) {
      expect(summary.getRow(rowNum).getCell(1).value).toBeTruthy()
      expect(summary.getRow(rowNum).getCell(4).value).not.toBe("")
    }
  })

  it("states money in rands and carries the basis note", async () => {
    const wb = await sheets(await GET(request("type=ncr-quarterly&quarter=2026-Q1")))
    const summary = wb.getWorksheet("NCR Summary")!
    expect(summary.getRow(2).getCell(4).value).toBe(700)
    expect(summary.getRow(3).getCell(6).value).toContain("exposure at risk")
    expect(summary.getRow(3).getCell(5).value).toBe(50)
  })

  it("carries the stale-position caveat onto the info sheet", async () => {
    const wb = await sheets(await GET(request("type=ncr-quarterly&quarter=2026-Q1")))
    const info = wb.getWorksheet("Return Info")!
    const values = info.getSheetValues().flat().map(String).join(" | ")
    expect(values).toContain("NOT the quarter end")
    expect(values).toContain("Not submitted")
    expect(values).toContain(ACME_LENDER.ncrNumber)
  })

  it("exports the filed figures and says so once a quarter is submitted", async () => {
    getNcrReturnDataMock.mockResolvedValue({
      ...ncrData,
      submittedAt: new Date("2026-04-05T08:00:00Z"),
      positionIsStale: false,
      filed: {
        collectibleBook: { count: 3, value: 111_00 },
        lines: [{ key: "arrears", label: "AS FILED", count: 1, value: 111_00, basis: "POSITION" as const }],
      },
    })
    const wb = await sheets(await GET(request("type=ncr-quarterly&quarter=2026-Q1")))
    const summary = wb.getWorksheet("NCR Summary")!
    expect(summary.getRow(2).getCell(1).value).toBe("AS FILED")
    expect(summary.getRow(2).getCell(2).value).toBe("Position as filed")
    const info = wb.getWorksheet("Return Info")!.getSheetValues().flat().map(String).join(" | ")
    expect(info).toContain("frozen at submission")
  })

  it("confines the arrears register to the collectible book", async () => {
    await GET(request("type=ncr-quarterly&quarter=2026-Q1"))
    const arrearsCall = loanFindManyMock.mock.calls
      .map(([a]) => a as { where: Record<string, unknown> })
      .find((a) => a.where.daysInArrears)
    expect(arrearsCall?.where.status).toEqual({
      in: ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"],
    })
  })

  it("leaves NON_NCA agreements off the disbursement and arrears sheets", async () => {
    await GET(request("type=ncr-quarterly&quarter=2026-Q1"))
    const wheres = loanFindManyMock.mock.calls.map(([a]) => (a as { where: Record<string, unknown> }).where)
    expect(wheres).toHaveLength(2)
    for (const where of wheres) expect(where).toMatchObject({ tenantId: "tenant-1", ncaRegime: "NCA" })
  })


  it("strictly audits the export, which carries client ID numbers", async () => {
    // Two sheets carry ID numbers and full names. Every other bulk identity
    // export in this handler writes an audit row; this branch did not.
    await GET(request("type=ncr-quarterly&quarter=2026-Q1"))
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      action: "NCR_QUARTERLY_EXPORTED",
      entity: "Report",
      entityId: "ncr-quarterly:2026-Q1",
    }))
  })
})

describe("ncr-quarterly export — role gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    loanFindManyMock.mockResolvedValue([])
    getNcrReturnDataMock.mockResolvedValue({
      quarter: "2026-Q1",
      periodStart: new Date("2025-12-31T22:00:00Z"),
      periodEnd: new Date("2026-03-31T21:59:59.999Z"),
      quarterOpen: false,
      ncrNumber: ACME_LENDER.ncrNumber,
      collectibleBook: { count: 0, value: 0 },
      lines: [],
      submittedAt: null,
      submittedByName: null,
      filed: null,
      positionIsStale: false,
      filedSnapshotUnreadable: false,
    })
    logAuditStrictMock.mockResolvedValue(undefined)
  })

  it("re-checks LOAN_ADMIN, like the other exports carrying ID numbers", async () => {
    // Two sheets carry client ID numbers and full names. The generic READONLY
    // export permission at the top of the handler is too broad for that, and
    // the sibling PII branches (section129-register, audit-log) upgrade the
    // same way.
    requireApiRoleMock.mockImplementation(async (role: string) => ({
      user: role === "LOAN_ADMIN"
        ? { id: "admin-1", tenantId: "tenant-1", email: "admin@example.test", role: "LOAN_ADMIN" }
        : { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" },
    }))
    await GET(request("type=ncr-quarterly&quarter=2026-Q1"))
    expect(requireApiRoleMock.mock.calls.map(([role]) => role)).toEqual(["READONLY", "LOAN_ADMIN"])
  })

  it("refuses a READONLY caller and produces no workbook", async () => {
    requireApiRoleMock.mockImplementation(async (role: string) =>
      role === "LOAN_ADMIN"
        ? { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
        : { user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } },
    )
    const res = await GET(request("type=ncr-quarterly&quarter=2026-Q1"))
    expect(res.status).toBe(403)
    expect(res.headers.get("content-type")).not.toContain("spreadsheetml")
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("names the upgraded principal in the audit row, not the READONLY guard", async () => {
    requireApiRoleMock.mockImplementation(async (role: string) => ({
      user: role === "LOAN_ADMIN"
        ? { id: "admin-1", tenantId: "tenant-1", email: "admin@example.test", role: "LOAN_ADMIN" }
        : { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" },
    }))
    await GET(request("type=ncr-quarterly&quarter=2026-Q1"))
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "admin-1",
      userEmail: "admin@example.test",
    }))
  })
})

describe("GET reports export — loans", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } })
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
  })

  it("states Total Paid as cash received, not the share applied to the instalments", async () => {
    loanFindManyMock.mockResolvedValue([{
      reference: "LN-1", principal: 200_000, totalInterest: 10_000, totalRepayable: 216_900,
      outstandingPrincipal: 166_900, totalPaid: 42_000, status: "DEFAULTED", daysInArrears: 25, arrearsAmount: 174_900,
      startDate: new Date("2026-08-01T08:00:00Z"), maturityDate: new Date("2026-09-01T08:00:00Z"), nextPaymentDate: null,
      client: { firstName: "Thandi", lastName: "Mocktest", idNumber: "9401020000082", phone: "0820000000", email: "t@example.test" },
      product: { name: "Micro" },
      // R500 cash of which R80 paid default charges; a waiver and a reversed receipt are not cash.
      payments: [
        { amount: 50_000, paymentMethod: "EFT", reversed: false, allocationStatus: "ALLOCATED" },
        { amount: 90, paymentMethod: "WAIVER", reversed: false, allocationStatus: "ALLOCATED" },
        { amount: 20_000, paymentMethod: "EFT", reversed: true, allocationStatus: "ALLOCATED" },
      ],
    }])
    const res = await GET(request("type=loans"))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer() as unknown as Parameters<typeof wb.xlsx.load>[0])
    const sheet = wb.getWorksheet("Active Loans")!
    const header = (sheet.getRow(1).values as unknown[]).indexOf("Total Paid")
    expect(sheet.getRow(2).getCell(header).value).toBe(500)
    expect(loanFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ payments: expect.anything() }),
    }))
  })
})

describe("GET reports export — default charges owing beside instalment arrears", () => {
  const LIVE = { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-09-27T08:00:00Z"), defaultChargesStoppedAt: null }
  const loan = {
    reference: "LN-7", principal: 200_000, totalInterest: 10_000, totalRepayable: 216_900,
    outstandingPrincipal: 200_000, totalPaid: 0, status: "DEFAULTED", daysInArrears: 45,
    arrearsAmount: 216_900, chargesOutstanding: 12_345,
    startDate: new Date("2026-07-01T08:00:00Z"), maturityDate: new Date("2026-08-01T08:00:00Z"), nextPaymentDate: null,
    client: { firstName: "Sipho", lastName: "Dlamini", idNumber: "9001016000087", phone: "0820000001", email: "s@example.test" },
    product: { name: "Micro" },
    payments: [],
  }

  async function cells(type: "loans" | "par", sheetName: string) {
    const res = await GET(request(`type=${type}`))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer() as unknown as Parameters<typeof wb.xlsx.load>[0])
    const sheet = wb.getWorksheet(sheetName)!
    const header = sheet.getRow(1).values as unknown[]
    const row = sheet.getRow(2)
    return (name: string) => row.getCell(header.indexOf(name)).value
  }

  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } })
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    loanFindManyMock.mockResolvedValue([loan])
  })

  for (const [type, sheetName, arrearsColumn] of [
    ["loans", "Active Loans", "Arrears Amount"],
    ["par", "PAR Report", "Arrears Amount (R)"],
  ] as const) {
    it(`${type}: states charges owing in rands while live and leaves instalment arrears alone`, async () => {
      tenantConfigFindUniqueMock.mockResolvedValue(LIVE)
      const cell = await cells(type, sheetName)
      expect(cell("Default Charges Owing (R)")).toBe(123.45)
      expect(cell(arrearsColumn)).toBe(2169)
      expect(tenantConfigFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" } }))
    })

    it(`${type}: keeps the column at 0 while charges are not live, whatever the stored figure`, async () => {
      tenantConfigFindUniqueMock.mockResolvedValue({ ...LIVE, defaultChargesStoppedAt: new Date("2026-10-01T08:00:00Z") })
      const cell = await cells(type, sheetName)
      expect(cell("Default Charges Owing (R)")).toBe(0)
      expect(cell(arrearsColumn)).toBe(2169)
    })
  }
})

describe("GET reports export — collections", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } })
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    tenantConfigFindUniqueMock.mockResolvedValue(null)
  })

  it("lists the collections queue exactly: its population and its client borrowers", async () => {
    const row = (reference: string, client: unknown) => ({
      reference, clientId: client ? "c1" : null, client, entity: client ? null : { legalName: "Synthetic Trading (Pty) Ltd" },
      product: { name: "Micro" }, daysInArrears: 12, arrearsAmount: 10_000, outstandingPrincipal: 50_000, status: "ACTIVE",
    })
    loanFindManyMock.mockResolvedValue([
      row("LN-PERSON", { firstName: "Sipho", lastName: "Dlamini", idNumber: "9001016000087", phone: "0820000001", email: "s@example.test" }),
      row("LN-ENTITY", null),
    ])
    const res = await GET(request("type=collections"))
    expect(loanFindManyMock.mock.calls[0][0].where).toEqual(collectionsQueueWhere("tenant-1", false))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer() as unknown as Parameters<typeof wb.xlsx.load>[0])
    const sheet = wb.getWorksheet("Collections Queue")!
    expect(sheet.rowCount).toBe(2)
    expect(sheet.getRow(2).getCell(1).value).toBe("LN-PERSON")
  })
})

describe("GET reports export — affordability register", () => {
  const decidedAt = new Date("2026-10-12T10:00:00Z")
  const application = (reference: string, status: string) => ({
    reference, status, approvedAt: decidedAt, approvedAmount: null, appliedAmount: 100_000, appliedTermDays: 30,
    netDisposableIncome: null, affordabilityNDI: null, totalExistingDebt: null, recklessLendingAssessed: true,
    recklessLendingNote: null, incomeVerificationMethod: null, submittedAt: null,
    client: { firstName: "Thandi", lastName: "Mocktest", idNumber: "9401020000082" },
    product: { name: "Micro" }, approvedBy: { name: "Demo Admin" },
  })

  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } })
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
  })

  it("fills Approved At for approved and disbursed applications, never for a declined one", async () => {
    applicationFindManyMock.mockResolvedValue([
      application("APP-A", "APPROVED"), application("APP-D", "DISBURSED"), application("APP-X", "DECLINED"),
    ])
    const res = await GET(request("type=affordability"))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer() as unknown as Parameters<typeof wb.xlsx.load>[0])
    const sheet = wb.getWorksheet("Affordability Register")!
    const col = (sheet.getRow(1).values as unknown[]).indexOf("Approved At")
    const cell = (row: number) => sheet.getRow(row).getCell(col).value
    expect(cell(2)).toBeTruthy()
    expect(cell(3)).toBeTruthy()
    expect(cell(4) ?? "").toBe("")
  })
})

describe("GET reports export — fsca-annual", () => {
  // The route opens no tenant frame, so the query's own filter is the
  // boundary. The mock behaves like the database: it applies the filters it
  // is given and nothing else.
  const policy = (policyNumber: string, tenantId: string) => ({
    policyNumber, tenantId, type: "CREDIT_LIFE", insurer: null, insurer_rel: { name: "Synthetic Insurer" },
    premiumAmount: 100, status: "ACTIVE", startDate: new Date("2026-03-01T08:00:00Z"), pprIssuedAt: null,
    client: { firstName: "Synthetic", lastName: tenantId },
  })
  const POLICIES = [policy("POL-A-1", "tenant-1"), policy("POL-B-1", "tenant-2")]

  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } })
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    policyFindManyMock.mockImplementation(async (args: { where?: Record<string, unknown> }) =>
      POLICIES.filter((p) => Object.entries(args.where ?? {}).every(([k, v]) => p[k as keyof typeof p] === v)))
    complaintFindManyMock.mockResolvedValue([])
  })

  it("lists only the requesting lender's policies", async () => {
    const res = await GET(request("type=fsca-annual"))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer() as unknown as Parameters<typeof wb.xlsx.load>[0])
    const sheet = wb.getWorksheet("Insurance Policies")!
    const col = (sheet.getRow(1).values as unknown[]).indexOf("Policy ID")
    const ids: unknown[] = []
    sheet.eachRow((row, n) => { if (n > 1) ids.push(row.getCell(col).value) })
    expect(ids).toEqual(["POL-A-1"])
  })
})

describe("GET reports export — the caller must belong to the host's tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    policyFindManyMock.mockResolvedValue([])
    complaintFindManyMock.mockResolvedValue([])
  })

  const asStaffOf = (tenantId: string | null) =>
    requireApiRoleMock.mockResolvedValue({ user: { id: "staff-1", tenantId, email: "staff@example.test", role: "LOAN_ADMIN" } })

  it("refuses staff of another lender on this lender's host: 403, no export", async () => {
    asStaffOf("tenant-2")
    const res = await GET(request("type=fsca-annual"))
    expect(res.status).toBe(403)
    expect(res.headers.get("content-type")).not.toMatch(/spreadsheetml/)
    expect(policyFindManyMock).not.toHaveBeenCalled()
    expect(complaintFindManyMock).not.toHaveBeenCalled()
  })

  it("serves staff of the host's lender: 200 workbook", async () => {
    asStaffOf("tenant-1")
    const res = await GET(request("type=fsca-annual"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/)
    expect(policyFindManyMock).toHaveBeenCalledOnce()
  })
})

describe("GET reports export — NCA regime", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } })
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    tenantConfigFindUniqueMock.mockResolvedValue(null)
    loanFindManyMock.mockResolvedValue([])
    applicationFindManyMock.mockResolvedValue([])
  })

  for (const type of ["affordability", "reckless-lending"]) {
    it(`${type}: the NCA consumer register leaves entity (asset finance) applications out`, async () => {
      const res = await GET(request(`type=${type}`))
      expect(res.status).toBe(200)
      expect(applicationFindManyMock).toHaveBeenCalledTimes(1)
      expect(applicationFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-1", entityId: null }),
      }))
    })
  }

  it("credit-agreements: the register of NCA credit agreements leaves NON_NCA agreements out", async () => {
    await GET(request("type=credit-agreements"))
    expect(loanFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-1", ncaRegime: "NCA" }),
    }))
  })

  it("par: the arrears aging keeps NON_NCA agreements and labels every row with its regime", async () => {
    loanFindManyMock.mockResolvedValue([{
      reference: "LN-AF-1", principal: 30_000_000, outstandingPrincipal: 25_000_000, arrearsAmount: 900_000,
      chargesOutstanding: 0, daysInArrears: 45, status: "ACTIVE", ncaRegime: "NON_NCA",
      client: null, entity: { legalName: "TEST Plant Hire (Pty) Ltd" }, product: { name: "Plant finance" },
    }])
    const res = await GET(request("type=par"))
    expect((loanFindManyMock.mock.calls[0][0] as { where: Record<string, unknown> }).where).not.toHaveProperty("ncaRegime")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer() as unknown as Parameters<typeof wb.xlsx.load>[0])
    const sheet = wb.getWorksheet("PAR Report")
    const header = (sheet?.getRow(1).values ?? []) as unknown[]
    expect(sheet?.getRow(2).getCell(header.indexOf("Regime")).value).toBe("NON_NCA")
    expect(sheet?.getRow(2).getCell(header.indexOf("Client")).value).toBe("TEST Plant Hire (Pty) Ltd")
  })
})

describe("GET reports export — branch reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "readonly-1", tenantId: "tenant-1", email: "readonly@example.test", role: "READONLY" } })
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
    loanFindManyMock.mockResolvedValue([])
    scheduleFindManyMock.mockResolvedValue([])
  })

  it("leaves a reversed loan's CANCELLED instalments out of expected collections, and keeps written-off ones", async () => {
    await GET(request("type=reconciliation"))
    expect(scheduleFindManyMock).toHaveBeenCalledTimes(1)
    expect(scheduleFindManyMock.mock.calls[0][0].where.status).toEqual({ not: "CANCELLED" })
  })
})
