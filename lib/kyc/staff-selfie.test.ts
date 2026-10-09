import { beforeEach, describe, expect, it, vi } from "vitest"
import { latestSelfieOrder } from "@/lib/kyc/document-state"

const findFirst = vi.hoisted(() => vi.fn())

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: { findFirst },
  },
}))

import {
  getAuthoritativeStaffSelfie,
  STAFF_SELFIE_SELECT,
} from "@/lib/kyc/staff-selfie"

describe("getAuthoritativeStaffSelfie", () => {
  beforeEach(() => {
    findFirst.mockReset()
  })

  it("uses the authoritative attempt sequence without filtering deleted attempts", async () => {
    findFirst.mockResolvedValue(null)

    await getAuthoritativeStaffSelfie("client-1", "tenant-1")

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        clientId: "client-1",
        docType: "SELFIE",
      },
      orderBy: latestSelfieOrder(),
      select: STAFF_SELFIE_SELECT,
    })
    expect(findFirst.mock.calls[0][0].where).not.toHaveProperty("deletedAt")
  })

  it("preserves a deleted authoritative attempt for the staff tombstone", async () => {
    const deletedAt = new Date("2026-07-23T08:00:00.000Z")
    const latestDeleted = {
      id: "selfie-newer-deleted",
      fileName: "newer.jpg",
      mimeType: "image/jpeg",
      storagePath: "tenant/client/selfie-newer-deleted.jpg",
      deletedAt,
      biometricMatchScore: 12,
      biometricLiveness: 18,
      biometricVerifiedAt: null,
      extractionStatus: "failed",
      verified: false,
      verifiedAt: null,
      verificationNote: "Failed liveness",
      createdAt: new Date("2026-07-23T07:00:00.000Z"),
    }
    findFirst.mockResolvedValue(latestDeleted)

    await expect(
      getAuthoritativeStaffSelfie("client-1", "tenant-1"),
    ).resolves.toBe(latestDeleted)
  })
})
