import { beforeEach, describe, expect, it, vi } from "vitest"

const readCompositeKycStateMock = vi.fn()

vi.mock("@/lib/kyc/document-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kyc/document-state")>()),
  readCompositeKycState: (...args: unknown[]) => readCompositeKycStateMock(...args),
}))

import {
  reprojectKycAfterIdUpload,
  type IdUploadProjectionTransaction,
} from "./id-upload-projection.server"

const verifiedAt = new Date("2026-07-22T10:00:00.000Z")
const verifiedClient = {
  id: "client-1",
  idNumber: "0000000000000",
  firstName: "Test",
  lastName: "Person",
  dateOfBirth: null,
  kycStatus: "VERIFIED" as const,
  kycVerifiedAt: verifiedAt,
  kycVerifiedById: "officer-1",
  kycVerificationMethod: "PHYSICAL" as const,
  kycManualRejectionActive: false,
}
const pendingState = {
  kycStatus: "PENDING" as const,
  kycVerifiedAt: null,
  kycVerifiedById: null,
  kycVerificationMethod: null,
}

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

function derived(state: typeof pendingState | typeof verifiedClient) {
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

  it("downgrades a VERIFIED client to the derived PENDING state and audits it", async () => {
    findUnique.mockResolvedValue(verifiedClient)
    derived(pendingState)

    await expect(reprojectKycAfterIdUpload(tx, args)).resolves.toEqual({ changed: true })

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
      missingCoreDocuments: ["ID_COPY"],
    }))
    expect(data.newValue.clientKyc.kycStatus).toBe("PENDING")
  })

  it("records the staff actor on a staff upload", async () => {
    findUnique.mockResolvedValue(verifiedClient)
    derived(pendingState)

    await reprojectKycAfterIdUpload(tx, { ...args, actor: { type: "staff", userId: "officer-2" } })

    expect(auditCreate.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ userId: "officer-2", userEmail: null }),
    )
  })

  it("writes nothing when the stored status already matches the derived state", async () => {
    findUnique.mockResolvedValue({ ...verifiedClient, ...pendingState, kycStatus: "PENDING" })
    derived(pendingState)

    await expect(reprojectKycAfterIdUpload(tx, args)).resolves.toEqual({ changed: false })
    expect(update).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("never promotes a client to VERIFIED from an upload", async () => {
    findUnique.mockResolvedValue({ ...verifiedClient, ...pendingState })
    derived(verifiedClient)

    await expect(reprojectKycAfterIdUpload(tx, args)).resolves.toEqual({ changed: false })
    expect(update).not.toHaveBeenCalled()
  })

  it("does nothing for a client that is not in the tenant", async () => {
    findUnique.mockResolvedValue(null)

    await expect(reprojectKycAfterIdUpload(tx, args)).resolves.toEqual({ changed: false })
    expect(readCompositeKycStateMock).not.toHaveBeenCalled()
  })
})
