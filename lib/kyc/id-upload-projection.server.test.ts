import { beforeEach, describe, expect, it, vi } from "vitest"

const readCompositeKycStateMock = vi.fn()

vi.mock("@/lib/kyc/document-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kyc/document-state")>()),
  readCompositeKycState: (...args: unknown[]) => readCompositeKycStateMock(...args),
}))

import {
  readKycBeforeIdUpload,
  reprojectKycAfterIdUpload,
  type IdUploadProjectionTransaction,
} from "./id-upload-projection.server"

const verifiedAt = new Date("2026-07-22T10:00:00.000Z")
const base = {
  id: "client-1",
  idNumber: "0000000000000",
  firstName: "Test",
  lastName: "Person",
  dateOfBirth: null,
  kycManualRejectionActive: false,
  kycManualRejectionAt: null,
  kycManualRejectionById: null,
  kycManualRejectionReason: null,
  kycManualRejectionResolvedAt: null,
  kycManualRejectionResolvedById: null,
  kycManualRejectionResolutionReason: null,
}
const verifiedClient = {
  ...base,
  kycStatus: "VERIFIED" as const,
  kycVerifiedAt: verifiedAt,
  kycVerifiedById: "officer-1",
  kycVerificationMethod: "PHYSICAL" as const,
}
const pendingState = {
  kycStatus: "PENDING" as const,
  kycVerifiedAt: null,
  kycVerifiedById: null,
  kycVerificationMethod: null,
}
const pendingClient = { ...base, ...pendingState }
const failedClient = { ...base, ...pendingState, kycStatus: "FAILED" as const }

const findUnique = vi.fn()
const update = vi.fn()
const auditCreate = vi.fn()
const tx = {
  client: { findUnique, update },
  auditLog: { create: auditCreate },
} as unknown as IdUploadProjectionTransaction

const args = {
  tenantId: "tenant-1",
  clientId: "client-1",
  documentId: "doc-new",
  actor: { type: "client" as const, email: "client@example.test" },
}

function derived(state: {
  kycStatus: "PENDING" | "VERIFIED" | "FAILED"
  kycVerifiedAt: Date | null
  kycVerifiedById: string | null
  kycVerificationMethod: "PHYSICAL" | "BIOMETRIC" | null
}) {
  readCompositeKycStateMock.mockResolvedValue({
    state: {
      kycStatus: state.kycStatus,
      kycVerifiedAt: state.kycVerifiedAt,
      kycVerifiedById: state.kycVerifiedById,
      kycVerificationMethod: state.kycVerificationMethod,
    },
    missingCoreDocuments: ["ID_COPY"],
    coreDocumentGaps: [{ docType: "ID_COPY", state: "awaiting_verification" }],
  })
}

describe("reprojectKycAfterIdUpload", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    update.mockImplementation(async ({ data }: { data: object }) => ({ ...verifiedClient, ...data }))
  })

  it("re-derives a still-VERIFIED client to PENDING, writes it and audits it with the actor", async () => {
    // The database did not move it: the evidence it checks still holds.
    findUnique.mockResolvedValue(verifiedClient)
    derived(pendingState)

    await expect(reprojectKycAfterIdUpload(tx, { ...args, before: verifiedClient })).resolves.toEqual({ changed: true })

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "client-1", tenantId: "tenant-1" },
      data: pendingState,
    }))
    expect(auditCreate).toHaveBeenCalledTimes(1)
    const { data } = auditCreate.mock.calls[0][0]
    expect(data).toEqual(expect.objectContaining({
      tenantId: "tenant-1",
      action: "KYC_STATUS_CHANGED",
      entity: "Client",
      entityId: "client-1",
      userId: null,
      userEmail: "client@example.test",
    }))
    expect(data.oldValue.clientKyc.kycStatus).toBe("VERIFIED")
    expect(data.newValue).toEqual(expect.objectContaining({
      reason: "id_document_uploaded",
      documentId: "doc-new",
      demotedByDatabase: false,
      missingCoreDocuments: ["ID_COPY"],
    }))
    expect(data.newValue.clientKyc.kycStatus).toBe("PENDING")
  })

  it("audits with the actor when the insert's database trigger already demoted the client, without rewriting it", async () => {
    // before the insert: VERIFIED. After it: PENDING (the trigger did that,
    // leaving only a system audit row with no actor).
    findUnique.mockResolvedValue(pendingClient)
    derived(pendingState)

    await expect(reprojectKycAfterIdUpload(tx, { ...args, before: verifiedClient })).resolves.toEqual({ changed: true })

    expect(update).not.toHaveBeenCalled()
    expect(auditCreate).toHaveBeenCalledTimes(1)
    const { data } = auditCreate.mock.calls[0][0]
    expect(data.userEmail).toBe("client@example.test")
    expect(data.oldValue.clientKyc.kycStatus).toBe("VERIFIED")
    expect(data.newValue.clientKyc.kycStatus).toBe("PENDING")
    expect(data.newValue.demotedByDatabase).toBe(true)
  })

  it("records the staff actor on a staff upload", async () => {
    findUnique.mockResolvedValue(pendingClient)
    derived(pendingState)

    await reprojectKycAfterIdUpload(tx, {
      ...args, before: verifiedClient, actor: { type: "staff", userId: "officer-2" },
    })

    expect(auditCreate.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ userId: "officer-2", userEmail: null }),
    )
  })

  it("writes nothing when the upload left the stored status as it was", async () => {
    findUnique.mockResolvedValue(pendingClient)
    derived(pendingState)

    await expect(reprojectKycAfterIdUpload(tx, { ...args, before: pendingClient })).resolves.toEqual({ changed: false })
    expect(update).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("never promotes a client to VERIFIED from an upload", async () => {
    findUnique.mockResolvedValue(pendingClient)
    derived(verifiedClient)

    await expect(reprojectKycAfterIdUpload(tx, { ...args, before: pendingClient })).resolves.toEqual({ changed: false })
    expect(update).not.toHaveBeenCalled()
  })

  it("does not rewrite or audit a client VERIFIED both before and after, though the derived provenance differs", async () => {
    findUnique.mockResolvedValue(verifiedClient)
    derived({ ...verifiedClient, kycVerifiedAt: new Date("2026-07-23T00:00:00.000Z"), kycVerificationMethod: "BIOMETRIC" })

    await expect(reprojectKycAfterIdUpload(tx, { ...args, before: verifiedClient })).resolves.toEqual({ changed: false })
    expect(update).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("moves FAILED to PENDING, audited, when the refused ID has been replaced", async () => {
    findUnique.mockResolvedValue(failedClient)
    derived(pendingState)

    await expect(reprojectKycAfterIdUpload(tx, { ...args, before: failedClient })).resolves.toEqual({ changed: true })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: pendingState }))
    expect(auditCreate.mock.calls[0][0].data.oldValue.clientKyc.kycStatus).toBe("FAILED")
  })

  it("does nothing without a pre-upload snapshot or for a client outside the tenant", async () => {
    await expect(reprojectKycAfterIdUpload(tx, { ...args, before: null })).resolves.toEqual({ changed: false })
    findUnique.mockResolvedValue(null)
    await expect(reprojectKycAfterIdUpload(tx, { ...args, before: verifiedClient })).resolves.toEqual({ changed: false })
    expect(readCompositeKycStateMock).not.toHaveBeenCalled()
  })
})

describe("readKycBeforeIdUpload", () => {
  it("reads the client scoped to the tenant", async () => {
    findUnique.mockResolvedValue(verifiedClient)

    await expect(readKycBeforeIdUpload(tx, { tenantId: "tenant-1", clientId: "client-1" })).resolves.toBe(verifiedClient)
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "client-1", tenantId: "tenant-1" },
    }))
  })
})
