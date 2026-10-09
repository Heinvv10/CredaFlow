import { beforeEach, describe, expect, it, vi } from "vitest"
import { biometricSubjectFingerprint } from "./biometric-evidence"
import { updateClientWithBiometricIdentityRevocation } from "./identity-revocation"

const findMany = vi.fn()
const updateMany = vi.fn()
const updateClient = vi.fn()
const createAudit = vi.fn()
const tx = {
  client: { update: updateClient },
  clientDocument: { findMany, updateMany },
  auditLog: { create: createAudit },
}

const previous = {
  id: "client-1",
  idNumber: "9001015009087",
  firstName: "Sipho",
  lastName: "Qatest",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  kycStatus: "VERIFIED" as const,
  kycVerifiedAt: new Date("2026-07-22T08:00:00.000Z"),
  kycVerifiedById: "officer-old",
  kycVerificationMethod: "SMILE_IDENTITY" as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  findMany.mockResolvedValue([{ id: "selfie-1" }, { id: "selfie-2" }])
  updateMany.mockResolvedValue({ count: 2 })
  updateClient.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...previous,
    ...data,
  }))
  createAudit.mockResolvedValue({ id: "audit-1" })
})

describe("updateClientWithBiometricIdentityRevocation", () => {
  it("atomically resets provenance, invalidates verified selfies, and audits hashed identity", async () => {
    const nextSubject = { ...previous, firstName: "Nomsa" }
    const result = await updateClientWithBiometricIdentityRevocation(tx as never, {
      tenantId: "tenant-1",
      clientId: previous.id,
      previous,
      nextSubject,
      where: { id: previous.id, tenantId: "tenant-1" },
      data: { firstName: nextSubject.firstName },
      actor: { userId: "officer-1", userEmail: "officer@example.test" },
      source: "staff_client_edit",
    })

    expect(updateClient).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        firstName: "Nomsa",
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["selfie-1", "selfie-2"] } }),
      data: expect.objectContaining({ verified: false, verifiedById: null }),
    }))
    expect(result.revocation).toEqual({
      reason: "client_identity_changed",
      source: "staff_client_edit",
      previousSubjectFingerprint: biometricSubjectFingerprint(previous),
      currentSubjectFingerprint: biometricSubjectFingerprint(nextSubject),
      invalidatedDocumentIds: ["selfie-1", "selfie-2"],
      invalidatedDocumentCount: 2,
    })
    expect(createAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_STATUS_CHANGED",
        oldValue: expect.objectContaining({
          subjectFingerprint: biometricSubjectFingerprint(previous),
          clientKyc: expect.objectContaining({ kycVerifiedById: "officer-old" }),
        }),
        newValue: expect.objectContaining({
          subjectFingerprint: biometricSubjectFingerprint(nextSubject),
          invalidatedDocumentIds: ["selfie-1", "selfie-2"],
          clientKyc: expect.objectContaining({ kycVerifiedById: null }),
        }),
      }),
    })
  })

  it("does not revoke evidence for an unrelated change", async () => {
    const result = await updateClientWithBiometricIdentityRevocation(tx as never, {
      tenantId: "tenant-1",
      clientId: previous.id,
      previous,
      nextSubject: previous,
      where: { id: previous.id, tenantId: "tenant-1" },
      data: { phone: "+27820000001" },
      actor: { userId: "officer-1", userEmail: "officer@example.test" },
      source: "staff_client_edit",
    })

    expect(result.revocation).toBeNull()
    expect(updateClient.mock.calls[0][0].data).toEqual({ phone: "+27820000001" })
    expect(findMany).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
    expect(createAudit).not.toHaveBeenCalled()
  })

  it("fails closed when every selected verified selfie was not invalidated", async () => {
    updateMany.mockResolvedValueOnce({ count: 1 })

    await expect(updateClientWithBiometricIdentityRevocation(tx as never, {
      tenantId: "tenant-1",
      clientId: previous.id,
      previous,
      nextSubject: { ...previous, lastName: "Changed" },
      where: { id: previous.id, tenantId: "tenant-1" },
      data: { lastName: "Changed" },
      actor: { userId: null, userEmail: "website-system" },
      source: "website_apply_returning_client",
    })).rejects.toThrow(/changed concurrently/i)
    expect(createAudit).not.toHaveBeenCalled()
  })
})
