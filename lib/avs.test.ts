// lib/avs.test.ts
// Mocks must be hoisted BEFORE the SUT import (pattern: lib/notifications.test.ts)
import { describe, it, expect, vi, beforeEach } from "vitest"

const tenantConfigFindUniqueMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const avsCheckCreateMock = vi.fn()
const auditLogCreateMock = vi.fn()
const queryRawMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: (a: unknown) => tenantConfigFindUniqueMock(a) },
    client: { findUnique: (a: unknown) => clientFindUniqueMock(a) },
    avsCheck: { create: (a: unknown) => avsCheckCreateMock(a) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({
      $queryRaw: (a: unknown) => queryRawMock(a),
      client: { findUnique: (a: unknown) => clientFindUniqueMock(a) },
      avsCheck: { create: (a: unknown) => avsCheckCreateMock(a) },
      auditLog: { create: (a: unknown) => auditLogCreateMock(a) },
    }),
  },
}))

import { avsWireAccountType, evaluateAvsGate, runAvsCheck } from "./avs"
import { avsSubjectFingerprint } from "@/lib/compliance/avs-subject"
import { registerProvider } from "@/lib/integrations/collections/registry"
import type {
  AvsChecks,
  AvsRequest,
  CollectionProvider,
} from "@/lib/integrations/collections/types"

const avsClient = {
  id: "c1",
  idNumber: "9001015800086",
  firstName: "T",
  lastName: "Client",
  bankName: "FNB",
  bankAccountNumber: "62000000000",
  bankBranchCode: "250655",
  accountType: "CHEQUE",
}

const passingAvs = {
  clientId: avsClient.id,
  applicationId: "app1",
  subjectFingerprint: avsSubjectFingerprint(avsClient),
  passed: true,
}

describe("evaluateAvsGate (pure)", () => {
  it("fails when no check exists", () => {
    expect(evaluateAvsGate(null, avsClient, "app1").ok).toBe(false)
  })
  it("fails when evidence belongs to a different application", () => {
    expect(evaluateAvsGate({ ...passingAvs, applicationId: "app2" }, avsClient, "app1").ok).toBe(false)
  })
  it("fails when any provider-facing subject or bank field changed", () => {
    expect(evaluateAvsGate(passingAvs, { ...avsClient, bankBranchCode: "000000" }, "app1").ok).toBe(false)
    expect(evaluateAvsGate(passingAvs, { ...avsClient, lastName: "Changed" }, "app1").ok).toBe(false)
  })
  it("fails when the latest check failed", () => {
    expect(evaluateAvsGate({ ...passingAvs, passed: false }, avsClient, "app1").ok).toBe(false)
  })
  it("passes only on application-bound evidence for the exact current subject", () => {
    expect(evaluateAvsGate(passingAvs, avsClient, "app1")).toEqual({ ok: true, reason: null })
  })
  it("fails when the client has no bank account captured", () => {
    expect(evaluateAvsGate(passingAvs, { ...avsClient, bankAccountNumber: null }, "app1").ok).toBe(false)
  })
  it("refuses a simulated AVS pass on a deployed build that has not declared the simulated rail", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    try {
      expect(evaluateAvsGate({ ...passingAvs, provider: "simulated" }, avsClient, "app1")).toEqual({
        ok: false, reason: "Simulated AVS evidence is not accepted on this deployment",
      })
      expect(evaluateAvsGate({ ...passingAvs, provider: "netcash" }, avsClient, "app1").ok).toBe(true)
      vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-collections")
      expect(evaluateAvsGate({ ...passingAvs, provider: "simulated" }, avsClient, "app1").ok).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("runAvsCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tenantConfigFindUniqueMock.mockResolvedValue({
      collectionProvider: "netcash", avsProvider: null,
      netcashRiskReportsKey: null, netcashDebitOrderKey: null,
    })
    clientFindUniqueMock.mockResolvedValue({
      id: "c1", tenantId: "t1", firstName: "T", lastName: "Client",
      idNumber: "9001015800086", bankName: "FNB", bankAccountNumber: "62000000000",
      bankBranchCode: "250655", accountType: "CHEQUE",
    })
    avsCheckCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "avs1", ...data }))
    auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
  })

  it("persists a check and writes an audit row (dry-run provider passes)", async () => {
    const result = await runAvsCheck({
      tenantId: "t1", clientId: "c1", applicationId: "app1",
      actor: { id: "u1", email: "staff@x.co" },
    })
    expect(result.passed).toBe(true)
    expect(avsCheckCreateMock).toHaveBeenCalledOnce()
    const data = avsCheckCreateMock.mock.calls[0][0].data
    expect(data.tenantId).toBe("t1")
    expect(data.provider).toBe("netcash")
    expect(data.subjectFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(queryRawMock).toHaveBeenCalledTimes(2)
    expect(queryRawMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      values: ["affordability-application:t1:app1"],
    }))
    expect(queryRawMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      values: ["affordability-client:t1:c1"],
    }))
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AVS_CHECK_RUN",
        entity: "AvsCheck",
        entityId: "avs1",
      }),
    })
  })

  it("does not persist a result when bank details change during the provider call", async () => {
    clientFindUniqueMock
      .mockResolvedValueOnce({
        id: "c1", tenantId: "t1", firstName: "T", lastName: "Client",
        idNumber: "9001015800086", bankName: "FNB", bankAccountNumber: "62000000000",
        bankBranchCode: "250655", accountType: "CHEQUE",
      })
      .mockResolvedValueOnce({
        idNumber: "9001015800086", firstName: "T", lastName: "Client",
        bankName: "FNB", bankAccountNumber: "62000000099",
        bankBranchCode: "250655", accountType: "CHEQUE",
      })

    await expect(runAvsCheck({
      tenantId: "t1", clientId: "c1", applicationId: "app1",
      actor: { id: "u1", email: "staff@x.co" },
    })).rejects.toThrow(/changed during AVS verification/i)
    expect(avsCheckCreateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("fails the evidence transaction when the mandatory audit insert fails", async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    await expect(runAvsCheck({
      tenantId: "t1", clientId: "c1", applicationId: "app1",
      actor: { id: "u1", email: "staff@x.co" },
    })).rejects.toThrow("audit unavailable")
    expect(avsCheckCreateMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
  })

  it("rejects when the client has incomplete bank details", async () => {
    clientFindUniqueMock.mockResolvedValue({
      id: "c1", tenantId: "t1", firstName: "T", lastName: "Client",
      idNumber: "9001015800086", bankName: null, bankAccountNumber: null,
      bankBranchCode: null, accountType: null,
    })
    await expect(runAvsCheck({ tenantId: "t1", clientId: "c1", actor: { id: "u1", email: "e" } }))
      .rejects.toThrow(/bank details/i)
  })

  // The account type used to be collapsed to CHEQUE unless it was SAVINGS, so
  // a transmission account was verified against an account the consumer does
  // not hold. Assert on what actually reaches the provider, not on the value
  // persisted alongside it — the latter is the unmapped input and would pass
  // whatever the mapping did.
  it.each([
    ["SAVINGS", "SAVINGS"],
    ["CHEQUE", "CHEQUE"],
    // OTHER has no representation on the Netcash wire and AVS is mandatory for
    // every disbursement, so it is submitted as CHEQUE knowingly. For such a
    // client the AVS result does not verify the account TYPE; it still verifies
    // holder, ID, account number and branch, which is what AVS is for.
    ["OTHER", "CHEQUE"],
  ])("sends %s to the provider verbatim", async (onFile, expected) => {
    const seen: AvsRequest[] = []
    registerProvider({
      id: "capture-avs",
      verifyAccount: async (req: AvsRequest) => {
        seen.push(req)
        return { passed: true, checks: {} as AvsChecks, raw: null }
      },
    } as unknown as CollectionProvider)
    tenantConfigFindUniqueMock.mockResolvedValue({
      collectionProvider: "capture-avs", avsProvider: "capture-avs",
      netcashRiskReportsKey: null, netcashDebitOrderKey: null,
    })
    clientFindUniqueMock.mockResolvedValue({
      id: "c1", tenantId: "t1", firstName: "T", lastName: "Client",
      idNumber: "9001015800086", bankName: "FNB", bankAccountNumber: "62000000000",
      bankBranchCode: "250655", accountType: onFile,
    })

    await runAvsCheck({
      tenantId: "t1", clientId: "c1", applicationId: "app1",
      actor: { id: "u1", email: "staff@x.co" },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].accountType).toBe(expected)
  })

  it("refuses to submit a retired TRANSMISSION account at all", async () => {
    // THIS is the case that distinguishes the mapping from the old inline
    // `=== "SAVINGS" ? "SAVINGS" : "CHEQUE"` ternary. That ternary produced the
    // same answer as the mapping for CHEQUE, SAVINGS and OTHER, so a test over
    // only those three cannot fail if someone reinstates it — the whole table
    // above passes against the bug. A transmission account is the one input
    // where silent coercion and failing closed differ.
    const seen: AvsRequest[] = []
    registerProvider({
      id: "transmission-capture-avs",
      verifyAccount: async (req: AvsRequest) => {
        seen.push(req)
        return { passed: true, checks: {} as AvsChecks, raw: null }
      },
    } as unknown as CollectionProvider)
    tenantConfigFindUniqueMock.mockResolvedValue({
      collectionProvider: "transmission-capture-avs",
      avsProvider: "transmission-capture-avs",
      netcashRiskReportsKey: null, netcashDebitOrderKey: null,
    })
    clientFindUniqueMock.mockResolvedValue({
      id: "c1", tenantId: "t1", firstName: "T", lastName: "Client",
      idNumber: "9001015800086", bankName: "FNB", bankAccountNumber: "62000000000",
      bankBranchCode: "250655", accountType: "TRANSMISSION",
    })

    await expect(runAvsCheck({
      tenantId: "t1", clientId: "c1", applicationId: "app1",
      actor: { id: "u1", email: "staff@x.co" },
    })).rejects.toThrow(/TRANSMISSION/)
    expect(seen).toHaveLength(0)
  })
})

describe("avsWireAccountType", () => {
  it("submits an OTHER account as CHEQUE", () => {
    // The Netcash wire has two values and AVS is mandatory for EVERY
    // disbursement, so an OTHER client has to be submitted as something. The
    // cost is explicit: for that client the AVS result does not verify the
    // account type. It still verifies holder, ID, account number and branch,
    // which is what AVS is actually for.
    expect(avsWireAccountType("OTHER")).toBe("CHEQUE")
  })

  it("refuses to submit a retired TRANSMISSION account", () => {
    // Fails closed rather than verifying the account as something it is not.
    expect(() => avsWireAccountType("TRANSMISSION")).toThrow(/TRANSMISSION/)
  })

  it("records the client's REAL account type on the AvsCheck row", async () => {
    // The row is evidence of what we hold, not of what we put on the wire. If
    // these two ever collapse into one value the audit trail starts asserting
    // that an OTHER account was verified AS a cheque account, which is not what
    // happened.
    registerProvider({
      id: "row-capture-avs",
      verifyAccount: async () => ({ passed: true, checks: {} as AvsChecks, raw: null }),
    } as unknown as CollectionProvider)
    tenantConfigFindUniqueMock.mockResolvedValue({
      collectionProvider: "row-capture-avs", avsProvider: "row-capture-avs",
      netcashRiskReportsKey: null, netcashDebitOrderKey: null,
    })
    clientFindUniqueMock.mockResolvedValue({
      id: "client-1",
      tenantId: "tenant-1",
      idNumber: "9001010001080",
      firstName: "Lindiwe",
      lastName: "Testperson",
      bankName: "Discovery Bank",
      bankAccountNumber: "10000020011",
      bankBranchCode: "679000",
      accountType: "OTHER",
    })
    avsCheckCreateMock.mockResolvedValue({ id: "avs-1", passed: true })
    auditLogCreateMock.mockResolvedValue({})

    await runAvsCheck({
      tenantId: "tenant-1",
      clientId: "client-1",
      actor: { id: "user-1", email: "staff@acme-lending.example" },
    })

    expect(avsCheckCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accountType: "OTHER" }),
      }),
    )
  })
})
