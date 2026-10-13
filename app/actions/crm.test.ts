import { describe, it, expect, vi, beforeEach } from "vitest"

const requireMinRoleMock = vi.fn()
const getDefaultTenantIdMock = vi.fn()
const transactionMock = vi.fn()
const logAuditMock = vi.fn()
const revalidatePathMock = vi.fn()
const redirectMock = vi.fn()
const loanFindManyMock = vi.fn()
const crossSellFindManyMock = vi.fn()
const crossSellCreateManyMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireMinRole: (r: string) => requireMinRoleMock(r) }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: () => getDefaultTenantIdMock() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => transactionMock(fn),
    loan: { findMany: (a: unknown) => loanFindManyMock(a) },
    crossSellOpportunity: {
      findMany: (a: unknown) => crossSellFindManyMock(a),
      createMany: (a: unknown) => crossSellCreateManyMock(a),
    },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePathMock(p) }))
vi.mock("next/navigation", () => ({ redirect: (p: string) => redirectMock(p) }))
vi.mock("@/lib/contact/provision", () => ({ provisionContactForClient: vi.fn() }))

import {
  updateLeadStatus,
  reassignLead,
  resetStrandedConvertedLead,
  addLeadActivity,
  generateCrossSellOpportunities,
} from "./crm"

// Server actions mask thrown error messages behind a generic digest in
// production builds — updateLeadStatus must return validation failures as
// { ok: false, error } instead of throwing, so LeadDetailClient's error
// state (and the kanban drag handler) can show the real reason instead of
// a raw digest.
describe("updateLeadStatus — typed result for validation failures", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireMinRoleMock.mockResolvedValue({ id: "u1", email: "officer@acme-lending.example", tenantId: "t1" })
    getDefaultTenantIdMock.mockResolvedValue("default-tenant")
  })

  it("returns ok:false instead of throwing for an invalid status", async () => {
    const result = await updateLeadStatus("lead-1", "NOT_A_REAL_STATUS")
    expect(result).toEqual({ ok: false, error: "Invalid status" })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("returns ok:false instead of throwing for a direct CONVERTED transition", async () => {
    const result = await updateLeadStatus("lead-1", "CONVERTED")
    expect(result).toEqual({
      ok: false,
      error: "Leads can only be converted via the convert flow, not a direct status update.",
    })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("returns ok:false instead of throwing when the lead is already CONVERTED (the live repro)", async () => {
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        lead: {
          findFirst: vi.fn().mockResolvedValue({ status: "CONVERTED" }),
          update: vi.fn(),
        },
      }
      return fn(tx)
    })
    const result = await updateLeadStatus("lead-1", "QUALIFIED")
    expect(result).toEqual({ ok: false, error: "Cannot change status of a converted lead" })
    expect(logAuditMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it("returns ok:false instead of throwing when the lead no longer exists", async () => {
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        lead: {
          findFirst: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      }
      return fn(tx)
    })
    const result = await updateLeadStatus("lead-1", "QUALIFIED")
    expect(result).toEqual({ ok: false, error: "Lead not found" })
  })

  it("returns ok:true with the updated lead and logs the audit trail on a valid transition", async () => {
    const updatedLead = { id: "lead-1", status: "QUALIFIED" }
    transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        lead: {
          findFirst: vi.fn().mockResolvedValue({ status: "CONTACTED" }),
          update: vi.fn().mockResolvedValue(updatedLead),
        },
      }
      return fn(tx)
    })
    const result = await updateLeadStatus("lead-1", "QUALIFIED")
    expect(result).toEqual({ ok: true, lead: updatedLead })
    expect(logAuditMock).toHaveBeenCalledTimes(1)
    expect(revalidatePathMock).toHaveBeenCalledWith("/crm/leads")
    expect(revalidatePathMock).toHaveBeenCalledWith("/crm/leads/lead-1")
  })
})

describe("resetStrandedConvertedLead — migration recovery state", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireMinRoleMock.mockResolvedValue({ id: "u1", email: "officer@acme-lending.example", tenantId: "t1" })
    getDefaultTenantIdMock.mockResolvedValue("default-tenant")
  })

  it("atomically clears only a migration-marked stranded row and writes its audit", async () => {
    const tx = {
      lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    }
    transactionMock.mockImplementation(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx))

    await resetStrandedConvertedLead("lead-1")

    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: {
        id: "lead-1",
        tenantId: "t1",
        status: "CONVERTED",
        convertedToClientId: null,
        convertedToApplicationId: null,
        conversionRecoveryRequired: true,
      },
      data: {
        status: "QUALIFIED",
        statusChangedAt: expect.any(Date),
        conversionRecoveryRequired: false,
      },
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "LEAD_STATUS_CHANGED",
        entityId: "lead-1",
        oldValue: { status: "CONVERTED", conversionRecoveryRequired: true },
        newValue: { status: "QUALIFIED", conversionRecoveryRequired: false },
      }),
    })
    expect(redirectMock).toHaveBeenCalledWith("/crm/leads/lead-1/convert")
  })

  it("refuses a row without the persisted recovery marker and writes no audit", async () => {
    const tx = {
      lead: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: vi.fn() },
    }
    transactionMock.mockImplementation(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx))

    await expect(resetStrandedConvertedLead("lead-1"))
      .rejects.toThrow("Lead is not a stranded conversion")
    expect(tx.auditLog.create).not.toHaveBeenCalled()
    expect(redirectMock).not.toHaveBeenCalled()
  })
})

// `Lead.assignedToId` has no FK and neither Lead nor User is in
// TENANT_SCOPED_MODELS, so the DB will happily store any string a caller
// sends. These assertions pin the only thing standing between a hostile
// assignedToId and the column: the in-transaction revalidation.
describe("reassignLead — assignee revalidation", () => {
  type TxLead = { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> }
  type TxUser = { findFirst: ReturnType<typeof vi.fn> }

  function mockTx(opts: {
    lead?: { assignedToId: string | null } | null
    assignee?: { id: string } | null
    writeCount?: number
  }) {
    const tx = {
      lead: {
        findFirst: vi.fn().mockResolvedValue(opts.lead === undefined ? { assignedToId: null } : opts.lead),
        updateMany: vi.fn().mockResolvedValue({ count: opts.writeCount ?? 1 }),
      } as TxLead,
      user: {
        findFirst: vi.fn().mockResolvedValue(opts.assignee === undefined ? { id: "u2" } : opts.assignee),
      } as TxUser,
    }
    transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    return tx
  }

  beforeEach(() => {
    vi.clearAllMocks()
    requireMinRoleMock.mockResolvedValue({ id: "u1", email: "officer@acme-lending.example", tenantId: "t1" })
    getDefaultTenantIdMock.mockResolvedValue("default-tenant")
  })

  it("gates on the CREDIT_OFFICER role", async () => {
    mockTx({})
    await reassignLead("lead-1", "u2")
    expect(requireMinRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
  })

  it("rejects an assignee outside the tenant and never writes", async () => {
    // The whole point of the feature's security control: a caller POSTing
    // another tenant's user id must not have it persisted.
    const tx = mockTx({ assignee: null })

    const result = await reassignLead("lead-1", "other-tenant-user")

    expect(result).toEqual({ ok: false, error: "That staff member can no longer be assigned leads" })
    expect(tx.lead.updateMany).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("looks the assignee up scoped to the tenant AND to active staff", async () => {
    const tx = mockTx({})
    await reassignLead("lead-1", "u2")
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: { id: "u2", tenantId: "t1", active: true },
      select: { id: true },
    })
  })

  it("scopes both the read and the write to the tenant", async () => {
    const tx = mockTx({})
    await reassignLead("lead-1", "u2")
    expect(tx.lead.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lead-1", tenantId: "t1" } })
    )
    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { id: "lead-1", tenantId: "t1", assignedToId: null },
      data: { assignedToId: "u2" },
    })
  })

  it("compare-and-swaps on the owner it read, so the audit oldValue cannot be stale", async () => {
    // READ COMMITTED means a concurrent reassign committing after our read is
    // visible to our write. Without assignedToId in the predicate the write
    // would land anyway and we would audit an owner that was already gone.
    const tx = mockTx({ lead: { assignedToId: "u9" } })

    await reassignLead("lead-1", "u2")

    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { id: "lead-1", tenantId: "t1", assignedToId: "u9" },
      data: { assignedToId: "u2" },
    })
  })

  it("reports a lost compare-and-swap as a conflict instead of auditing a wrong oldValue", async () => {
    mockTx({ lead: { assignedToId: "u9" }, writeCount: 0 })

    const result = await reassignLead("lead-1", "u2")

    expect(result).toEqual({
      ok: false,
      error: "This lead was reassigned by someone else — reload and try again",
    })
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("unassigns without an assignee lookup", async () => {
    const tx = mockTx({ lead: { assignedToId: "u2" } })

    const result = await reassignLead("lead-1", null)

    expect(result).toEqual({ ok: true, assignedToId: null })
    expect(tx.user.findFirst).not.toHaveBeenCalled()
    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { id: "lead-1", tenantId: "t1", assignedToId: "u2" },
      data: { assignedToId: null },
    })
  })

  it("returns ok:false rather than throwing when the lead does not exist", async () => {
    mockTx({ lead: null })
    const result = await reassignLead("lead-1", "u2")
    expect(result).toEqual({ ok: false, error: "Lead not found" })
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("returns a typed result rather than throwing P2025 when the lead is deleted mid-transaction", async () => {
    // update() would throw an unhandled P2025 here; updateMany + count===0
    // keeps the delete race on the same typed-result path.
    mockTx({ writeCount: 0 })
    const result = await reassignLead("lead-1", "u2")
    expect(result.ok).toBe(false)
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("is a no-op that skips the write and the audit when the owner is unchanged", async () => {
    const tx = mockTx({ lead: { assignedToId: "u2" } })

    const result = await reassignLead("lead-1", "u2")

    expect(result).toEqual({ ok: true, assignedToId: "u2" })
    expect(tx.lead.updateMany).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })

  it("audits the real old and new owner on a successful reassign", async () => {
    mockTx({ lead: { assignedToId: "u9" } })

    const result = await reassignLead("lead-1", "u2")

    expect(result).toEqual({ ok: true, assignedToId: "u2" })
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: "u1",
        userEmail: "officer@acme-lending.example",
        action: "LEAD_ASSIGNED",
        entity: "Lead",
        entityId: "lead-1",
        oldValue: { assignedToId: "u9" },
        newValue: { assignedToId: "u2" },
      })
    )
    expect(revalidatePathMock).toHaveBeenCalledWith("/crm/leads/lead-1")
  })
})

// The default tenant (deployment env) differs from the staff member's tenant in
// every test above; these pin that writes follow the authenticated user.
describe("crm actions — tenant comes from the authenticated staff user, not the default", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireMinRoleMock.mockResolvedValue({ id: "u1", email: "officer@acme-lending.example", tenantId: "t1" })
    requireMinRoleMock.mockResolvedValue({ id: "u1", email: "officer@acme-lending.example", tenantId: "t1" })
    getDefaultTenantIdMock.mockResolvedValue("default-tenant")
  })

  it("generateCrossSellOpportunities reads, writes and audits under the user's tenant", async () => {
    loanFindManyMock.mockResolvedValue([{ clientId: "c1" }])
    crossSellFindManyMock.mockResolvedValue([])
    crossSellCreateManyMock.mockResolvedValue({ count: 1 })

    await generateCrossSellOpportunities()

    expect(loanFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", status: "ACTIVE" } }))
    expect(crossSellCreateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ tenantId: "t1", clientId: "c1" })] }),
    )
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }))
    expect(getDefaultTenantIdMock).not.toHaveBeenCalled()
  })

  it("updateLeadStatus scopes the lead read/write and the audit to the user's tenant; a cross-tenant lead is not found", async () => {
    const tx = { lead: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() } }
    transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))

    const result = await updateLeadStatus("other-tenant-lead", "QUALIFIED")

    expect(result).toEqual({ ok: false, error: "Lead not found" })
    expect(tx.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "other-tenant-lead", tenantId: "t1" } }))
    expect(tx.lead.update).not.toHaveBeenCalled()
  })

  it("updateLeadStatus audits under the user's tenant on success", async () => {
    const tx = {
      lead: {
        findFirst: vi.fn().mockResolvedValue({ status: "CONTACTED" }),
        update: vi.fn().mockResolvedValue({ id: "lead-1" }),
      },
    }
    transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    await updateLeadStatus("lead-1", "QUALIFIED")
    expect(tx.lead.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "lead-1", tenantId: "t1" } }))
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }))
  })

  it("addLeadActivity refuses a cross-tenant lead and scopes the lookup to the user's tenant", async () => {
    const tx = { lead: { findFirst: vi.fn().mockResolvedValue(null) }, crmActivity: { create: vi.fn() } }
    transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))

    const result = await addLeadActivity({ leadId: "other-tenant-lead", type: "NOTE", subject: "s" })

    expect(result.ok).toBe(false)
    expect(tx.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "other-tenant-lead", tenantId: "t1" } }))
    expect(tx.crmActivity.create).not.toHaveBeenCalled()
  })

  it("addLeadActivity writes the activity and audit under the user's tenant", async () => {
    const tx = {
      lead: { findFirst: vi.fn().mockResolvedValue({ id: "lead-1" }), update: vi.fn() },
      crmActivity: { create: vi.fn().mockResolvedValue({ id: "a1" }) },
    }
    transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))

    await addLeadActivity({ leadId: "lead-1", type: "NOTE", subject: "s" })

    expect(tx.crmActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1" }) }),
    )
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }))
  })

  it("resetStrandedConvertedLead audits under the user's tenant", async () => {
    const tx = {
      lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "a" }) },
    }
    transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    await resetStrandedConvertedLead("lead-1")
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "t1" }) })
  })
})
