import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRoleMock,
  leadFindUniqueMock,
  clientFindFirstMock,
  transactionMock,
  productFindUniqueMock,
  txClientCreateMock,
  txClientFindUniqueMock,
  applicationFindFirstMock,
  applicationCreateMock,
  leadUpdateMock,
  activityCreateMock,
  promoteContactMock,
  auditLogCreateMock,
  queryRawMock,
} = vi.hoisted(() => ({
  requireApiRoleMock: vi.fn(),
  leadFindUniqueMock: vi.fn(),
  clientFindFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  productFindUniqueMock: vi.fn(),
  txClientCreateMock: vi.fn(),
  txClientFindUniqueMock: vi.fn(),
  applicationFindFirstMock: vi.fn(),
  applicationCreateMock: vi.fn(),
  leadUpdateMock: vi.fn(),
  activityCreateMock: vi.fn(),
  promoteContactMock: vi.fn(),
  auditLogCreateMock: vi.fn(),
  queryRawMock: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: () => requireApiRoleMock(),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string }) => unknown) =>
    callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: { findUnique: (...args: unknown[]) => leadFindUniqueMock(...args) },
    client: { findFirst: (...args: unknown[]) => clientFindFirstMock(...args) },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}))
vi.mock("@/lib/contact/provision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contact/provision")>()
  return {
    ...actual,
    resolveContactForLeadConversion: (...args: unknown[]) => promoteContactMock(...args),
  }
})
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("@/lib/utils", () => ({
  generateReference: (prefix: string) => `${prefix}-TEST-1`,
}))

import { POST } from "./route"

const context = { params: Promise.resolve({ id: "lead-1" }) }
function request() {
  return new NextRequest("http://localhost/api/crm/leads/lead-1/convert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idNumber: "8001015000086",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.test",
      phone: "+27821234567",
      employmentStatus: "EMPLOYED",
      employerName: "Test Employer",
      monthlyIncome: 15_000,
      monthlyExpenses: 8_000,
      appliedAmount: 5_000,
      appliedTermDays: 30,
      productId: "product-1",
      purpose: "Household costs",
    }),
  })
}

function recoveryRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/crm/leads/lead-1/convert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idNumber: "8001015000086",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.test",
      phone: "+27821234567",
      employmentStatus: "EMPLOYED",
      employerName: "Test Employer",
      monthlyIncome: 15_000,
      monthlyExpenses: 8_000,
      appliedAmount: 5_000,
      appliedTermDays: 30,
      productId: "product-1",
      purpose: "Household costs",
      recoveryReason: "Verified historical conversion evidence",
      ...overrides,
    }),
  })
}

const product = {
  id: "product-1",
  active: true,
  interestRatePm: 0.03,
  interestModel: "DAILY_ACCRUAL",
  initiationFeePct: 0.15,
  initiationFeeMax: 105_000,
  monthlyServiceFee: 6_900,
}
const client = {
  id: "client-1",
  reference: "CLT-TEST-1",
  idNumber: "8001015000086",
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.test",
  phone: "+27821234567",
  whatsapp: null,
  monthlyIncome: 1_500_000,
  monthlyExpenses: 800_000,
}
const snapshotClient = {
  ...client,
  grossMonthlyIncome: null,
  monthlyIncome: 1_500_000,
  monthlyExpenses: 800_000,
  expenseBreakdown: {
    id: "expense-1",
    updatedAt: new Date("2026-07-18T10:00:00.000Z"),
    housing: 0,
    transport: 0,
    food: 0,
    education: 0,
    insurance: 0,
    clothing: 0,
    entertainment: 0,
    medical: 0,
    other: 800_000,
    belowMleJustification: null,
  },
  debtObligations: [],
}
const reusedContactResolution = {
  contact: {
    id: "contact-client",
    status: "CLIENT",
    leadId: "lead-earlier",
    primaryEmail: "jane@example.test",
    primaryPhone: "27821234567",
    primaryWaJid: null,
  },
  created: false,
  resolution: "REUSED_CLIENT_CONTACT",
  previous: { clientId: "client-1", leadId: "lead-earlier", status: "CLIENT" },
  preExistingIdentities: [],
  createdIdentities: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({
    user: { id: "officer-1", name: "Loan Officer", email: "officer@example.test" },
  })
  leadFindUniqueMock.mockResolvedValue({ id: "lead-1", status: "QUALIFIED" })
  clientFindFirstMock.mockResolvedValue(null)
  productFindUniqueMock.mockResolvedValue(product)
  txClientCreateMock.mockResolvedValue(client)
  txClientFindUniqueMock.mockResolvedValue(snapshotClient)
  applicationCreateMock.mockResolvedValue({
    id: "app-1",
    reference: "APP-TEST-1",
  })
  leadUpdateMock.mockResolvedValue({ id: "lead-1" })
  activityCreateMock.mockResolvedValue({ id: "activity-1" })
  promoteContactMock.mockResolvedValue({
    contact: {
      id: "contact-1",
      clientId: "client-1",
      leadId: "lead-1",
      status: "CLIENT",
      primaryEmail: "jane@example.test",
      primaryPhone: "27821234567",
      primaryWaJid: null,
    },
    created: false,
    resolution: "PROMOTED_LEAD_CONTACT",
    previous: { clientId: null, leadId: "lead-1", status: "LEAD" },
    preExistingIdentities: [],
    createdIdentities: [],
  })
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  queryRawMock
    .mockResolvedValueOnce([{
      id: "lead-1",
      status: "QUALIFIED",
      convertedToClientId: null,
    }])
    .mockResolvedValue([{ id: "locked" }])
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    $queryRaw: queryRawMock,
    loanProduct: { findUnique: productFindUniqueMock },
    client: {
      create: txClientCreateMock,
      findFirst: clientFindFirstMock,
      findUnique: txClientFindUniqueMock,
    },
    loanApplication: {
      create: applicationCreateMock,
      findFirst: applicationFindFirstMock,
    },
    lead: { update: leadUpdateMock },
    crmActivity: { create: activityCreateMock },
    auditLog: { create: auditLogCreateMock },
  }))
})

describe("POST /api/crm/leads/[id]/convert affordability evidence", () => {
  it("rejects below-MLE lead expenses without creating partial client records", async () => {
    const belowMleRequest = new NextRequest("http://localhost/api/crm/leads/lead-1/convert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idNumber: "8001015000086",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.test",
        phone: "+27821234567",
        monthlyIncome: 10_000,
        monthlyExpenses: 0,
        appliedAmount: 5_000,
        appliedTermDays: 30,
        productId: "product-1",
        purpose: "Household costs",
      }),
    })

    const response = await POST(belowMleRequest, context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/Regulation 23A minimum/i)
    expect(transactionMock).not.toHaveBeenCalled()
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).not.toHaveBeenCalled()
  })

  it("creates the submitted application with a complete immutable v3 snapshot", async () => {
    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      clientId: "client-1",
      applicationId: "app-1",
      applicationReference: "APP-TEST-1",
      recovered: false,
      alreadyConverted: false,
    })
    const leadLock = queryRawMock.mock.calls[0][0]
    expect(leadLock.strings.join(" ")).toContain("FOR UPDATE")
    expect(leadLock.values).toEqual(["lead-1", "tenant-1"])
    expect(productFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "product-1", tenantId: "tenant-1" },
    })
    expect(productFindUniqueMock).toHaveBeenCalledTimes(2)
    expect(queryRawMock).toHaveBeenCalledTimes(4)
    expect(queryRawMock.mock.invocationCallOrder[3]).toBeLessThan(
      productFindUniqueMock.mock.invocationCallOrder[1],
    )
    const data = applicationCreateMock.mock.calls[0][0].data
    expect(data.affordabilityResult).toEqual(expect.objectContaining({
      schemaVersion: 3,
      submission: expect.objectContaining({
        policyVersion: "submission-ndi-v3",
        capturedById: "officer-1",
        inputs: expect.objectContaining({
          monthlyIncomeCents: 1_500_000,
          monthlyExpensesCents: 800_000,
          principalCents: 500_000,
          termDays: 30,
        }),
        expenses: expect.objectContaining({
          source: "CLIENT_BREAKDOWN",
          sourceId: "expense-1",
          breakdownTotalCents: 800_000,
        }),
        calculator: expect.objectContaining({
          version: "loan-calculator-v3",
          pricingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    }))
    expect(data.netDisposableIncome).toBe(700_000)
    expect(data.affordabilityNDI).toBe(700_000 - data.affordabilityResult.submission.inputs.proposedInstalmentCents)
    expect(promoteContactMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: "tenant-1",
      leadId: "lead-1",
      clientId: "client-1",
      email: "jane@example.test",
    }))
    expect(leadUpdateMock).toHaveBeenCalledWith({
      where: { id: "lead-1", tenantId: "tenant-1" },
      data: expect.objectContaining({
        status: "CONVERTED",
        convertedToClientId: "client-1",
      }),
    })
    expect(auditLogCreateMock).toHaveBeenCalledTimes(4)
    expect(auditLogCreateMock).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        action: "CONTACT_PROMOTED_LEAD_TO_CLIENT",
        entityId: "contact-1",
        oldValue: expect.objectContaining({ leadId: "lead-1", status: "LEAD" }),
        newValue: expect.objectContaining({
          leadId: "lead-1",
          clientId: "client-1",
          status: "CLIENT",
          primaryEmail: "jane@example.test",
          primaryPhone: "27821234567",
          primaryWaJid: null,
        }),
      }),
    })
    expect(auditLogCreateMock).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        action: "APPLICATION_SUBMITTED_BY_STAFF",
        entityId: "app-1",
        newValue: expect.objectContaining({
          source: "crm_lead_conversion",
          leadId: "lead-1",
          snapshotSchemaVersion: 3,
          decisionFingerprint: data.affordabilityResult.submission.decisionFingerprint,
        }),
      }),
    })
    expect(auditLogCreateMock).toHaveBeenNthCalledWith(3, {
      data: expect.objectContaining({
        action: "CLIENT_CREATED",
        entityId: "client-1",
      }),
    })
    expect(auditLogCreateMock).toHaveBeenNthCalledWith(4, {
      data: expect.objectContaining({
        action: "LEAD_CONVERTED",
        entityId: "lead-1",
        newValue: expect.objectContaining({
          convertedToClientId: "client-1",
          convertedToApplicationId: "app-1",
        }),
      }),
    })
  })

  it("fails closed when the mandatory submission audit cannot be written", async () => {
    auditLogCreateMock.mockImplementation((args: { data?: { action?: string } }) => {
      if (args.data?.action === "APPLICATION_SUBMITTED_BY_STAFF") {
        return Promise.reject(new Error("audit unavailable"))
      }
      return Promise.resolve({ id: "audit-other" })
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(500)
    expect(applicationCreateMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "APPLICATION_SUBMITTED_BY_STAFF" }),
    })
    expect(leadUpdateMock).not.toHaveBeenCalled()
    expect(activityCreateMock).not.toHaveBeenCalled()
  })

  it("returns the existing conversion idempotently and reconciles a stale QUALIFIED projection", async () => {
    promoteContactMock.mockResolvedValueOnce(reusedContactResolution)
    txClientFindUniqueMock.mockResolvedValueOnce({
      ...snapshotClient,
      id: "client-existing",
    })
    queryRawMock.mockReset().mockResolvedValueOnce([{
      id: "lead-1",
      status: "QUALIFIED",
      convertedToClientId: "client-existing",
      convertedToApplicationId: "app-existing",
      conversionRecoveryRequired: false,
    }])
    applicationFindFirstMock.mockResolvedValueOnce({
      id: "app-existing",
      reference: "APP-EXISTING",
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      clientId: "client-existing",
      applicationId: "app-existing",
      applicationReference: "APP-EXISTING",
      alreadyConverted: true,
    })
    expect(leadUpdateMock).toHaveBeenCalledWith({
      where: { id: "lead-1", tenantId: "tenant-1" },
      data: {
        status: "CONVERTED",
        statusChangedAt: expect.any(Date),
        conversionRecoveryRequired: false,
      },
    })
    expect(auditLogCreateMock).toHaveBeenCalledTimes(2)
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CONTACT_REUSED_FOR_LEAD_CONVERSION",
        entity: "Contact",
        entityId: "contact-client",
        newValue: expect.objectContaining({
          conversionLeadId: "lead-1",
          clientId: "client-existing",
          resolution: "REUSED_CLIENT_CONTACT",
        }),
      }),
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "LEAD_STATUS_CHANGED",
        oldValue: expect.objectContaining({ status: "QUALIFIED" }),
        newValue: expect.objectContaining({
          status: "CONVERTED",
          reason: "reconciled_existing_client_link",
        }),
      }),
    })
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).not.toHaveBeenCalled()
    expect(productFindUniqueMock).not.toHaveBeenCalled()
  })

  it("repairs a completed conversion whose Client Contact has no originating Lead", async () => {
    txClientFindUniqueMock.mockResolvedValueOnce({
      ...snapshotClient,
      id: "client-existing",
    })
    promoteContactMock.mockResolvedValueOnce({
      contact: {
        id: "contact-client",
        clientId: "client-existing",
        leadId: "lead-1",
        status: "CLIENT",
        primaryEmail: "jane@example.test",
        primaryPhone: "27821234567",
        primaryWaJid: null,
      },
      created: false,
      resolution: "LINKED_CLIENT_CONTACT",
      previous: {
        clientId: "client-existing",
        leadId: null,
        status: "CLIENT",
      },
      preExistingIdentities: [],
      createdIdentities: [],
    })
    queryRawMock.mockReset().mockResolvedValueOnce([{
      id: "lead-1",
      status: "CONVERTED",
      convertedToClientId: "client-existing",
      convertedToApplicationId: "app-existing",
      conversionRecoveryRequired: false,
    }])
    applicationFindFirstMock.mockResolvedValueOnce({
      id: "app-existing",
      reference: "APP-EXISTING",
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect((await response.json()).alreadyConverted).toBe(true)
    expect(promoteContactMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "tenant-1",
        leadId: "lead-1",
        clientId: "client-existing",
        reuseExistingClientContact: true,
      }),
    )
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CONTACT_PROMOTED_LEAD_TO_CLIENT",
        entity: "Contact",
        entityId: "contact-client",
        oldValue: expect.objectContaining({
          clientId: "client-existing",
          leadId: null,
        }),
        newValue: expect.objectContaining({
          leadId: "lead-1",
          clientId: "client-existing",
          resolution: "LINKED_CLIENT_CONTACT",
          reason: "reconciled_completed_lead_conversion",
          primaryEmail: "jane@example.test",
          primaryPhone: "27821234567",
          primaryWaJid: null,
        }),
      }),
    })
    expect(leadUpdateMock).not.toHaveBeenCalled()
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).not.toHaveBeenCalled()
  })

  it("does not rewrite an already-consistent converted lead on a repeated request", async () => {
    promoteContactMock.mockResolvedValueOnce(reusedContactResolution)
    txClientFindUniqueMock.mockResolvedValueOnce({
      ...snapshotClient,
      id: "client-existing",
    })
    queryRawMock.mockReset().mockResolvedValueOnce([{
      id: "lead-1",
      status: "CONVERTED",
      convertedToClientId: "client-existing",
      convertedToApplicationId: "app-existing",
      conversionRecoveryRequired: false,
    }])
    applicationFindFirstMock.mockResolvedValueOnce({
      id: "app-existing",
      reference: "APP-EXISTING",
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect((await response.json()).alreadyConverted).toBe(true)
    expect(leadUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CONTACT_REUSED_FOR_LEAD_CONVERSION",
        entity: "Contact",
        entityId: "contact-client",
        newValue: expect.objectContaining({
          conversionLeadId: "lead-1",
          clientId: "client-existing",
          resolution: "REUSED_CLIENT_CONTACT",
          reason: "reconciled_completed_lead_conversion",
        }),
      }),
    })
    expect(promoteContactMock).toHaveBeenCalledOnce()
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).not.toHaveBeenCalled()
  })

  it("returns 409 for the legacy stranded state instead of creating a duplicate", async () => {
    queryRawMock.mockReset().mockResolvedValueOnce([{
      id: "lead-1",
      status: "CONVERTED",
      convertedToClientId: null,
      convertedToApplicationId: null,
    }])

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/incomplete/i)
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).not.toHaveBeenCalled()
  })

  it("performs the duplicate-client check under the lead lock", async () => {
    clientFindFirstMock.mockResolvedValueOnce({
      id: "client-existing",
      idNumber: "8001015000086",
      email: "other@example.test",
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/ID number/)
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      clientFindFirstMock.mock.invocationCallOrder[0],
    )
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).not.toHaveBeenCalled()
  })

  it("rejects an orphaned or cross-tenant client link without reconciling the lead", async () => {
    queryRawMock.mockReset().mockResolvedValueOnce([{
      id: "lead-1",
      status: "QUALIFIED",
      convertedToClientId: "client-invalid",
      convertedToApplicationId: null,
    }])
    txClientFindUniqueMock.mockResolvedValueOnce(null)

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/invalid cross-record link/i)
    expect(leadUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("requires staff to select from exact audited candidates instead of guessing the newest application", async () => {
    queryRawMock
      .mockReset()
      .mockResolvedValueOnce([{
        id: "lead-1",
        status: "CONVERTED",
        convertedToClientId: "client-1",
        convertedToApplicationId: null,
        conversionRecoveryRequired: true,
      }])
      .mockResolvedValueOnce([{
        id: "app-audited",
        reference: "APP-AUDITED",
      }])
    txClientFindUniqueMock.mockResolvedValueOnce(client)

    const response = await POST(recoveryRequest(), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Select the exact audited application before completing recovery.",
      candidates: [{ id: "app-audited", reference: "APP-AUDITED" }],
    })
    expect(applicationFindFirstMock).not.toHaveBeenCalled()
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).not.toHaveBeenCalled()
    expect(leadUpdateMock).not.toHaveBeenCalled()
  })

  it("links a staff-selected same-tenant audited application and records the recovery reason", async () => {
    queryRawMock
      .mockReset()
      .mockResolvedValueOnce([{
        id: "lead-1",
        status: "CONVERTED",
        convertedToClientId: "client-1",
        convertedToApplicationId: null,
        conversionRecoveryRequired: true,
      }])
      .mockResolvedValueOnce([{
        id: "app-audited",
        reference: "APP-AUDITED",
      }])
      .mockResolvedValueOnce([{
        id: "app-audited",
        reference: "APP-AUDITED",
      }])
    txClientFindUniqueMock.mockResolvedValueOnce(client)
    promoteContactMock.mockResolvedValueOnce(reusedContactResolution)

    const response = await POST(recoveryRequest({
      recoveryApplicationId: "app-audited",
      recoveryReason: "Selected from the original submission audit",
    }), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      clientId: "client-1",
      applicationId: "app-audited",
      applicationReference: "APP-AUDITED",
      recovered: true,
      alreadyConverted: true,
    })
    expect(promoteContactMock).toHaveBeenCalledOnce()
    expect(leadUpdateMock).toHaveBeenCalledWith({
      where: { id: "lead-1", tenantId: "tenant-1" },
      data: {
        status: "CONVERTED",
        convertedToApplicationId: "app-audited",
        conversionRecoveryRequired: false,
      },
    })
    expect(auditLogCreateMock).toHaveBeenCalledTimes(2)
    expect(auditLogCreateMock).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        action: "CONTACT_REUSED_FOR_LEAD_CONVERSION",
        entityId: "contact-client",
        newValue: expect.objectContaining({
          clientId: "client-1",
          resolution: "REUSED_CLIENT_CONTACT",
          primaryEmail: "jane@example.test",
          primaryPhone: "27821234567",
          primaryWaJid: null,
        }),
      }),
    })
    expect(auditLogCreateMock).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        action: "LEAD_CONVERSION_RECOVERED",
        entityId: "lead-1",
        newValue: expect.objectContaining({
          convertedToApplicationId: "app-audited",
          recoveryReason: "Selected from the original submission audit",
          method: "selected_audited_application",
        }),
      }),
    })
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).not.toHaveBeenCalled()
  })

  it("rechecks ownership after the application lock and rejects a competing recovery claim", async () => {
    queryRawMock
      .mockReset()
      .mockResolvedValueOnce([{
        id: "lead-1",
        status: "CONVERTED",
        convertedToClientId: "client-1",
        convertedToApplicationId: null,
        conversionRecoveryRequired: true,
      }])
      .mockResolvedValueOnce([{
        id: "app-audited",
        reference: "APP-AUDITED",
      }])
      .mockResolvedValueOnce([])
    txClientFindUniqueMock.mockResolvedValueOnce(client)

    const response = await POST(recoveryRequest({
      recoveryApplicationId: "app-audited",
      recoveryReason: "Selected from the original submission audit",
    }), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/invalid cross-record link/i)
    expect(queryRawMock).toHaveBeenCalledTimes(3)
    expect(promoteContactMock).not.toHaveBeenCalled()
    expect(leadUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("resumes a client-only conversion by creating an application without duplicating the client", async () => {
    queryRawMock
      .mockReset()
      .mockResolvedValueOnce([{
        id: "lead-1",
        status: "CONVERTED",
        convertedToClientId: "client-1",
        convertedToApplicationId: null,
        conversionRecoveryRequired: true,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "locked" }])
    txClientFindUniqueMock
      .mockResolvedValueOnce(client)
      .mockResolvedValueOnce(snapshotClient)
    promoteContactMock.mockResolvedValueOnce(reusedContactResolution)

    const response = await POST(recoveryRequest(), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      clientId: "client-1",
      applicationId: "app-1",
      applicationReference: "APP-TEST-1",
      recovered: true,
      alreadyConverted: false,
    })
    expect(txClientCreateMock).not.toHaveBeenCalled()
    expect(applicationCreateMock).toHaveBeenCalledOnce()
    expect(leadUpdateMock).toHaveBeenCalledWith({
      where: { id: "lead-1", tenantId: "tenant-1" },
      data: {
        status: "CONVERTED",
        convertedToClientId: "client-1",
        convertedToApplicationId: "app-1",
        conversionRecoveryRequired: false,
      },
    })
    expect(auditLogCreateMock).toHaveBeenCalledTimes(3)
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CONTACT_REUSED_FOR_LEAD_CONVERSION",
        newValue: expect.objectContaining({ resolution: "REUSED_CLIENT_CONTACT" }),
      }),
    })
    expect(auditLogCreateMock).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CLIENT_CREATED" }),
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "LEAD_CONVERSION_RECOVERED",
        newValue: expect.objectContaining({
          recoveryReason: "Verified historical conversion evidence",
          method: "created_replacement_application",
        }),
      }),
    })
  })

  it("fails closed when the transactional conversion audit cannot be written", async () => {
    auditLogCreateMock.mockImplementation((args: { data?: { action?: string } }) => {
      if (args.data?.action === "LEAD_CONVERTED") {
        return Promise.reject(new Error("audit unavailable"))
      }
      return Promise.resolve({ id: "audit-other" })
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(500)
    expect(txClientCreateMock).toHaveBeenCalledOnce()
    expect(applicationCreateMock).toHaveBeenCalledOnce()
    expect(leadUpdateMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledTimes(4)
  })
  it("refuses to convert a lead linked to a client recorded as deceased", async () => {
    // The lead was linked while the client was alive; the death was recorded
    // afterwards. Conversion originates a LoanApplication, so it must refuse.
    txClientFindUniqueMock.mockResolvedValueOnce({
      ...snapshotClient,
      id: "client-existing",
      deceasedAt: new Date("2026-08-01T00:00:00.000Z"),
    })
    queryRawMock.mockReset().mockResolvedValueOnce([{
      id: "lead-1",
      status: "QUALIFIED",
      convertedToClientId: "client-existing",
      convertedToApplicationId: null,
      conversionRecoveryRequired: false,
    }])

    const response = await POST(request(), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/deceased/i)
    expect(applicationCreateMock).not.toHaveBeenCalled()
  })

  it("refuses to convert a lead linked to a blacklisted client", async () => {
    txClientFindUniqueMock.mockResolvedValueOnce({
      ...snapshotClient,
      id: "client-existing",
      blacklisted: true,
    })
    queryRawMock.mockReset().mockResolvedValueOnce([{
      id: "lead-1",
      status: "QUALIFIED",
      convertedToClientId: "client-existing",
      convertedToApplicationId: null,
      conversionRecoveryRequired: false,
    }])

    const response = await POST(request(), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/blacklisted/i)
    expect(applicationCreateMock).not.toHaveBeenCalled()
  })
})
