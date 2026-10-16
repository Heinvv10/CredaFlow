import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  findUniqueMock,
  findFirstMock,
  findManyMock,
  createMock,
  updateMock,
  updateManyMock,
  countMock,
  auditCreateMock,
  queryRawMock,
  loanFindUniqueMock,
  clientFindUniqueMock,
  loanUpdateMock,
  transactionMock,
  managedStoragePathMock,
  saveFileToManagedPathMock,
  readFileMock,
  deleteFileMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findFirstMock: vi.fn(),
  findManyMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  updateManyMock: vi.fn(),
  countMock: vi.fn(),
  auditCreateMock: vi.fn(),
  queryRawMock: vi.fn(),
  loanFindUniqueMock: vi.fn(),
  clientFindUniqueMock: vi.fn(),
  loanUpdateMock: vi.fn(),
  transactionMock: vi.fn(),
  managedStoragePathMock: vi.fn(),
  saveFileToManagedPathMock: vi.fn(),
  readFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    complianceRecord: {
      findUnique: (args: unknown) => findUniqueMock(args),
      findFirst: (args: unknown) => findFirstMock(args),
      findMany: (args: unknown) => findManyMock(args),
      create: (args: unknown) => createMock(args),
      update: (args: unknown) => updateMock(args),
      updateMany: (args: unknown) => updateManyMock(args),
      count: (args: unknown) => countMock(args),
    },
    auditLog: { create: (args: unknown) => auditCreateMock(args) },
    loan: {
      findUnique: (args: unknown) => loanFindUniqueMock(args),
      update: (args: unknown) => loanUpdateMock(args),
    },
    client: { findUnique: (args: unknown) => clientFindUniqueMock(args) },
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => transactionMock(callback),
  },
}))
vi.mock("@/lib/storage", () => ({
  managedStoragePath: (...args: unknown[]) => managedStoragePathMock(...args),
  saveFileToManagedPath: (...args: unknown[]) => saveFileToManagedPathMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
  deleteFile: (...args: unknown[]) => deleteFileMock(...args),
  deleteManagedFileStrict: (...args: unknown[]) => deleteFileMock(...args),
}))

import {
  finaliseSection129Issuance,
  dispatchSection129UnderEligibilityLock,
  getSection129IssuanceAvailability,
  getSection129ReservationAvailability,
  loadSection129ReservationForReconciliation,
  markSection129KnownNotSent,
  markSection129ReconciliationRequired,
  recoverStaleSection129Issuance,
  releaseSection129IssuanceAfterReconciliation,
  reserveSection129Issuance,
  section129NoticeDateLabel,
  section129PdfSha256,
  Section129ArtifactIntegrityError,
  Section129ArtifactUnavailableError,
  Section129IssuanceConflictError,
  verifySection129ReservationIntegrity,
} from "./section129-artifact"
import { SECTION129_NON_NCA_REASON } from "./section129-eligibility"

const pdf = Buffer.from("%PDF-1.4 issued notice")
const reservationArgs = {
  tenantId: "t1",
  loanId: "loan-1",
  loanReference: "LN-1",
  clientName: "Test Client",
  clientEmail: "test@example.test",
  clientFirstName: "Test",
  clientLastName: "Client",
  clientIdNumber: "9001015000088",
  clientAddressLine1: "1 Test Street",
  clientCity: "Johannesburg",
  arrearsAmount: 25_000,
  outstandingPrincipal: 100_000,
  daysInArrears: 90,
  noticeDate: section129NoticeDateLabel(new Date()),
  pdf,
  createdById: "user-1",
}

const naturalBorrower = {
  entityId: null,
  entity: null,
  client: {
    firstName: "Test",
    lastName: "Client",
    idNumber: "9001015000088",
    addressLine1: "1 Test Street",
    city: "Johannesburg",
    email: "test@example.test",
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  transactionMock.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
    complianceRecord: {
      findUnique: (args: unknown) => findUniqueMock(args),
      findFirst: (args: unknown) => findFirstMock(args),
      findMany: (args: unknown) => findManyMock(args),
      create: (args: unknown) => createMock(args),
      update: (args: unknown) => updateMock(args),
      updateMany: (args: unknown) => updateManyMock(args),
      count: (args: unknown) => countMock(args),
    },
    auditLog: { create: (args: unknown) => auditCreateMock(args) },
    loan: {
      findUnique: (args: unknown) => loanFindUniqueMock(args),
      update: (args: unknown) => loanUpdateMock(args),
    },
    client: { findUnique: (args: unknown) => clientFindUniqueMock(args) },
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    $queryRawUnsafe: (...args: unknown[]) => queryRawMock(...args),
  }))
  managedStoragePathMock.mockReturnValue("/private/legal/notice.pdf")
  saveFileToManagedPathMock.mockResolvedValue({ storagePath: "/private/legal/notice.pdf", fileSize: pdf.length })
  findUniqueMock.mockResolvedValue(null)
  findFirstMock.mockResolvedValue(null)
  findManyMock.mockResolvedValue([])
  createMock.mockResolvedValue({ id: "issue-1" })
  updateMock.mockResolvedValue({ id: "issue-old" })
  updateManyMock.mockResolvedValue({ count: 1 })
  loanUpdateMock.mockResolvedValue({ id: "loan-1" })
  loanFindUniqueMock.mockResolvedValue({
    ...naturalBorrower,
    clientId: "client-1",
    reference: "LN-1",
    status: "DEFAULTED",
    arrearsAmount: 25_000,
    outstandingPrincipal: 100_000,
    daysInArrears: 90,
  })
  clientFindUniqueMock.mockResolvedValue({
    firstName: "Test",
    lastName: "Client",
    idNumber: "9001015000088",
    addressLine1: "1 Test Street",
    city: "Johannesburg",
    email: "test@example.test",
  })
  auditCreateMock.mockResolvedValue({ id: "audit-1" })
  queryRawMock.mockResolvedValue([])
  deleteFileMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("Section 129 private artifact lifecycle", () => {
  it("renders the notice snapshot date in SAST across a UTC day boundary", () => {
    expect(section129NoticeDateLabel(new Date("2026-06-30T22:30:00.000Z"))).toBe("1 July 2026")
  })

  it("hashes exact operative bytes deterministically", () => {
    expect(section129PdfSha256(Buffer.from(pdf))).toBe(section129PdfSha256(pdf))
    expect(section129PdfSha256(Buffer.from("different"))).not.toBe(section129PdfSha256(pdf))
    expect(section129PdfSha256(pdf)).toMatch(/^[a-f0-9]{64}$/)
  })

  it("persists a private PENDING compliance reservation before provider dispatch", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)

    expect(reservation).toMatchObject({
      issuanceId: "issue-1",
      idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
      pdfSha256: section129PdfSha256(pdf),
    })
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: "SECTION_129_NOTICE",
        status: "PENDING",
        idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
        data: expect.objectContaining({
          lifecycle: "STAGING",
          storagePath: "/private/legal/notice.pdf",
          pdfSha256: section129PdfSha256(pdf),
        }),
      }),
    }))
    expect(saveFileToManagedPathMock).toHaveBeenCalledWith(pdf, "application/pdf", expect.stringMatching(/^section129-/))
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ data: { path: ["lifecycle"], equals: "STAGING" } }),
      data: expect.objectContaining({ data: expect.objectContaining({ lifecycle: "READY" }) }),
    }))
    expect(createMock.mock.invocationCallOrder[0]).toBeLessThan(saveFileToManagedPathMock.mock.invocationCallOrder[0])
  })

  it("keeps a durable STAGING manifest when the private-byte write fails", async () => {
    saveFileToManagedPathMock.mockRejectedValue(new Error("disk unavailable"))

    await expect(reserveSection129Issuance(reservationArgs)).rejects.toThrow("disk unavailable")

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ data: expect.objectContaining({ lifecycle: "STAGING" }) }),
    }))
    expect(deleteFileMock).toHaveBeenCalledWith("/private/legal/notice.pdf")
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ data: { path: ["lifecycle"], equals: "STAGING" } }),
      data: expect.objectContaining({
        idempotencyKey: null,
        status: "OVERDUE",
        data: expect.objectContaining({ lifecycle: "FAILED" }),
      }),
    }))
  })

  it("deletes a delayed write when stale recovery releases its STAGING manifest", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"))
    let allowWrite!: () => void
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve })
    const writeAllowed = new Promise<void>((resolve) => { allowWrite = resolve })
    saveFileToManagedPathMock.mockImplementation(async () => {
      markWriteStarted()
      await writeAllowed
      return { storagePath: "/private/legal/notice.pdf", fileSize: pdf.length }
    })
    findUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "issue-1",
        idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
        status: "PENDING",
        completedAt: null,
        data: {
          lifecycle: "STAGING",
          reservedAt: "2026-07-20T12:00:00.000Z",
          storagePath: "/private/legal/notice.pdf",
          fileSize: pdf.length,
          pdfSha256: section129PdfSha256(pdf),
        },
      })
    updateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })

    const reservationOutcome = reserveSection129Issuance(reservationArgs)
      .then(() => ({ error: null }))
      .catch((error: unknown) => ({ error }))
    await writeStarted

    const recovered = await recoverStaleSection129Issuance({
      tenantId: "t1",
      loanId: "loan-1",
      issuanceId: "issue-1",
      actorId: "admin-1",
      now: new Date("2026-07-20T14:00:00.000Z"),
    })
    expect(recovered).toEqual({ kind: "STAGING_RELEASED", issuanceId: "issue-1" })

    allowWrite()
    const outcome = await reservationOutcome
    expect(outcome.error).toBeInstanceOf(Section129IssuanceConflictError)
    expect(deleteFileMock).toHaveBeenCalledTimes(2)
    expect(deleteFileMock).toHaveBeenNthCalledWith(1, "/private/legal/notice.pdf")
    expect(deleteFileMock).toHaveBeenNthCalledWith(2, "/private/legal/notice.pdf")
  })

  it("deletes written bytes when the atomic READY audit fails", async () => {
    auditCreateMock
      .mockResolvedValueOnce({ id: "audit-staged" })
      .mockRejectedValueOnce(new Error("audit unavailable"))

    await expect(reserveSection129Issuance(reservationArgs)).rejects.toThrow("audit unavailable")

    expect(saveFileToManagedPathMock).toHaveBeenCalledOnce()
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ data: { path: ["lifecycle"], equals: "STAGING" } }),
      data: expect.objectContaining({ data: expect.objectContaining({ lifecycle: "READY" }) }),
    }))
    expect(deleteFileMock).toHaveBeenCalledOnce()
    expect(deleteFileMock).toHaveBeenCalledWith("/private/legal/notice.pdf")
  })

  it("blocks a recent issued reservation under the same active key", async () => {
    findUniqueMock.mockResolvedValue({
      id: "issue-old",
      status: "COMPLETED",
      completedAt: new Date(),
      data: { lifecycle: "ISSUED" },
    })

    await expect(reserveSection129Issuance(reservationArgs)).rejects.toBeInstanceOf(
      Section129IssuanceConflictError,
    )
    expect(createMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it.each(["READY", "DISPATCHING"] as const)(
    "promotes a stale %s reservation to reconciliation-required and keeps the key locked",
    async (lifecycle) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"))
      findUniqueMock.mockResolvedValue({
        id: "issue-stale",
        idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
        status: "PENDING",
        completedAt: null,
        data: {
          lifecycle,
          reservedAt: "2026-07-19T10:00:00.000Z",
          ...(lifecycle === "DISPATCHING"
            ? { dispatchStartedAt: "2026-07-19T10:30:00.000Z" }
            : {}),
          storagePath: "/private/legal/stale.pdf",
          pdfSha256: "b".repeat(64),
        },
      })
      await expect(reserveSection129Issuance(reservationArgs)).rejects.toMatchObject({
        name: "Section129IssuanceConflictError",
        issuanceId: "issue-stale",
        lifecycle: "RECONCILIATION_REQUIRED",
      })
      expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          data: { path: ["lifecycle"], equals: lifecycle },
        }),
        data: expect.objectContaining({
          data: expect.objectContaining({ lifecycle: "RECONCILIATION_REQUIRED" }),
        }),
      }))
      expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
    },
  )

  it("deletes stale STAGING bytes before releasing the active key and retains only hash evidence", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"))
    findUniqueMock.mockResolvedValue({
      id: "issue-stale",
      idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
      status: "PENDING",
      completedAt: null,
      data: {
        lifecycle: "STAGING",
        reservedAt: "2026-07-19T10:00:00.000Z",
        storagePath: "/private/legal/stale.pdf",
        fileSize: 1234,
        pdfSha256: "b".repeat(64),
      },
    })

    const result = await recoverStaleSection129Issuance({
      tenantId: "t1",
      loanId: "loan-1",
      issuanceId: "issue-stale",
      actorId: "admin-1",
    })

    expect(result).toEqual({ kind: "STAGING_RELEASED", issuanceId: "issue-stale" })
    expect(deleteFileMock).toHaveBeenCalledWith("/private/legal/stale.pdf")
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        idempotencyKey: null,
        status: "OVERDUE",
        data: expect.not.objectContaining({ storagePath: expect.anything(), fileSize: expect.anything() }),
      }),
    }))
    const persisted = updateManyMock.mock.calls[0][0].data.data
    expect(persisted).toMatchObject({
      lifecycle: "FAILED",
      pdfSha256: "b".repeat(64),
      artifactDeletedAt: "2026-07-19T12:00:00.000Z",
    })
    expect(persisted).not.toHaveProperty("storagePath")
    expect(persisted).not.toHaveProperty("fileSize")
    expect(persisted).toMatchObject({
      clientEmail: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
      clientIdNumber: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
      arrearsAmount: 0,
      outstandingPrincipal: 0,
      snapshotRedactedAt: "2026-07-19T12:00:00.000Z",
    })
  })

  it("does not release stale STAGING when private-byte deletion fails", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"))
    findUniqueMock.mockResolvedValue({
      id: "issue-stale",
      idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
      status: "PENDING",
      completedAt: null,
      data: {
        lifecycle: "STAGING",
        reservedAt: "2026-07-19T10:00:00.000Z",
        storagePath: "/private/legal/stale.pdf",
        pdfSha256: "b".repeat(64),
      },
    })
    deleteFileMock.mockRejectedValue(new Error("permission denied"))

    await expect(recoverStaleSection129Issuance({
      tenantId: "t1",
      loanId: "loan-1",
      issuanceId: "issue-stale",
      actorId: "admin-1",
    })).rejects.toThrow("permission denied")

    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("honours the rolling cooldown on pre-migration completed records without an active key", async () => {
    findFirstMock.mockResolvedValue({
      id: "legacy-issue",
      idempotencyKey: null,
      status: "COMPLETED",
      completedAt: new Date(),
      data: { lifecycle: "ISSUED" },
    })

    await expect(reserveSection129Issuance(reservationArgs)).rejects.toBeInstanceOf(
      Section129IssuanceConflictError,
    )
    expect(createMock).not.toHaveBeenCalled()
  })

  it("finalises the legal record and stage in one database transaction", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    transactionMock.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
      complianceRecord: {
        findUnique: (args: unknown) => findUniqueMock(args),
        findFirst: (args: unknown) => findFirstMock(args),
        findMany: (args: unknown) => findManyMock(args),
        create: (args: unknown) => createMock(args),
        update: (args: unknown) => updateMock(args),
        updateMany: (args: unknown) => updateManyMock(args),
        count: (args: unknown) => countMock(args),
      },
      auditLog: { create: (args: unknown) => auditCreateMock(args) },
      loan: {
        findUnique: (args: unknown) => loanFindUniqueMock(args),
        update: (args: unknown) => loanUpdateMock(args),
      },
      client: { findUnique: (args: unknown) => clientFindUniqueMock(args) },
      $queryRaw: (...args: unknown[]) => queryRawMock(...args),
      $queryRawUnsafe: (...args: unknown[]) => queryRawMock(...args),
    }))
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({ collectionsStage: "NONE" })
    const providerAcceptedAt = new Date(Date.now() - 1_000)

    await finaliseSection129Issuance({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      issuedById: "user-1",
      emailMessageId: "provider-1",
      issuedAt: providerAcceptedAt,
    })

    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        data: { path: ["lifecycle"], equals: "DISPATCHING" },
      }),
      data: expect.objectContaining({
        status: "COMPLETED",
        completedAt: providerAcceptedAt,
        data: expect.objectContaining({ lifecycle: "ISSUED", emailMessageId: "provider-1" }),
      }),
    }))
    expect(loanUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ collectionsStage: "SECTION_129_SENT" }),
    }))
  })

  it("persists request-scoped Graph evidence when the auxiliary EmailLog failed", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({ collectionsStage: "NONE" })
    const providerAcceptedAt = new Date(Date.now() - 1_000)
    const providerEvidenceReference =
      "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000001"
    const providerPersistenceWarning =
      "EmailLog persistence failed after provider acceptance: database unavailable"

    await finaliseSection129Issuance({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      issuedById: "user-1",
      providerEvidenceReference,
      providerPersistenceWarning,
      emergencyEvidenceAuditPersisted: false,
      issuedAt: providerAcceptedAt,
    })

    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        completedAt: providerAcceptedAt,
        data: expect.objectContaining({
          lifecycle: "ISSUED",
          emailMessageId: providerEvidenceReference,
          providerEvidenceReference,
          providerAcceptedAt: providerAcceptedAt.toISOString(),
          providerPersistenceWarning,
          emergencyEvidenceAuditPersisted: false,
        }),
      }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "SECTION_129_ISSUED",
        newValue: expect.objectContaining({
          providerEvidenceReference,
          providerPersistenceWarning,
          emergencyEvidenceAuditPersisted: false,
        }),
      }),
    }))
  })

  it.each(["SECTION_129_SENT", "PAYMENT_ARRANGEMENT", "ATTORNEY_REFERRED", "WRITTEN_OFF"])(
    "records an issued notice without rewriting the equal/later %s collections stage",
    async (collectionsStage) => {
      const reservation = await reserveSection129Issuance(reservationArgs)
      vi.clearAllMocks()
      updateManyMock.mockResolvedValue({ count: 1 })
      loanFindUniqueMock.mockResolvedValue({ collectionsStage })

      await finaliseSection129Issuance({
        reservation: {
          ...reservation,
          recordData: { ...reservation.recordData, lifecycle: "DISPATCHING" },
        },
        tenantId: "t1",
        loanId: "loan-1",
        issuedById: "admin-1",
        emailMessageId: `provider-${collectionsStage}`,
        issuedAt: new Date(Date.now() - 1_000),
      })

      expect(loanUpdateMock).not.toHaveBeenCalled()
      expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: "COLLECTIONS_STAGE_PRESERVED",
          oldValue: { stage: collectionsStage },
          newValue: expect.objectContaining({
            stage: collectionsStage,
            issuedNoticeRecordedWithoutStageRegression: true,
          }),
        }),
      }))
    },
  )

  it("uses the provider acceptance time as legal issuance time during reconciliation", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({ collectionsStage: "SECTION_129_SENT" })
    const providerAcceptedAt = new Date(Date.now() - 60_000)

    await finaliseSection129Issuance({
      reservation: {
        ...reservation,
        recordData: { ...reservation.recordData, lifecycle: "RECONCILIATION_REQUIRED" },
      },
      tenantId: "t1",
      loanId: "loan-1",
      issuedById: "admin-1",
      reconciliationReason: "Provider delivery log confirmed acceptance",
      emailMessageId: "provider-log-1",
      issuedAt: providerAcceptedAt,
    })

    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        completedAt: providerAcceptedAt,
        data: expect.objectContaining({
          lifecycle: "ISSUED",
          emailMessageId: "provider-log-1",
          issuedAt: providerAcceptedAt.toISOString(),
          reconciledAt: expect.any(String),
        }),
      }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "SECTION_129_ISSUANCE_RECONCILED",
        newValue: expect.objectContaining({
          issuedAt: providerAcceptedAt.toISOString(),
          emailMessageId: "provider-log-1",
          reconciledAt: expect.any(String),
        }),
      }),
    }))
  })

  it("refuses ISSUED reconciliation without a provider acceptance time", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()

    await expect(finaliseSection129Issuance({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      issuedById: "admin-1",
      reconciliationReason: "Provider delivery log checked",
      // Runtime guard protects JavaScript callers as well as TypeScript ones.
      // @ts-expect-error deliberately exercise the missing required timestamp
      issuedAt: undefined,
    })).rejects.toThrow(/timestamp is required/)

    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("refuses ISSUED reconciliation without a provider evidence reference", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()

    await expect(finaliseSection129Issuance({
      reservation: {
        ...reservation,
        recordData: { ...reservation.recordData, lifecycle: "RECONCILIATION_REQUIRED" },
      },
      tenantId: "t1",
      loanId: "loan-1",
      issuedById: "admin-1",
      reconciliationReason: "Provider delivery log checked",
      issuedAt: new Date(),
    })).rejects.toThrow(/provider message or request-scoped evidence reference/i)

    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("refuses a reconciled provider timestamp that materially predates dispatch", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()

    await expect(finaliseSection129Issuance({
      reservation: {
        ...reservation,
        recordData: {
          ...reservation.recordData,
          lifecycle: "RECONCILIATION_REQUIRED",
          dispatchStartedAt: "2026-07-19T04:00:00.000Z",
        },
      },
      tenantId: "t1",
      loanId: "loan-1",
      issuedById: "admin-1",
      reconciliationReason: "Provider delivery log checked",
      emailMessageId: "provider-log-2",
      issuedAt: new Date("2026-07-19T03:00:00.000Z"),
    })).rejects.toThrow(/predates/)

    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("releases only a known-not-sent attempt and retains its audit evidence", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    findUniqueMock.mockResolvedValue({
      id: reservation.issuanceId,
      idempotencyKey: reservation.idempotencyKey,
      status: "PENDING",
      completedAt: null,
      data: reservation.recordData,
    })

    await markSection129KnownNotSent({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      reason: "No contact identity",
    })

    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        data: { path: ["lifecycle"], equals: "READY" },
      }),
      data: expect.objectContaining({
        idempotencyKey: null,
        status: "OVERDUE",
        data: expect.objectContaining({ lifecycle: "FAILED", failureReason: "No contact identity" }),
      }),
    }))
    expect(deleteFileMock).toHaveBeenCalledWith("/private/legal/notice.pdf")
    const failedData = updateManyMock.mock.calls.at(-1)?.[0].data.data
    expect(failedData).not.toHaveProperty("storagePath")
    expect(failedData).toMatchObject({
      pdfSha256: section129PdfSha256(pdf),
      clientEmail: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
      clientIdNumber: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
      arrearsAmount: 0,
      outstandingPrincipal: 0,
      snapshotRedactedAt: expect.any(String),
    })
  })

  it("rechecks eligibility under the loan lock before dispatch and guards reconciliation", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({
      ...naturalBorrower,
      clientId: "client-1",
      reference: "LN-1",
      status: "DEFAULTED",
      arrearsAmount: 25_000,
      outstandingPrincipal: 100_000,
      daysInArrears: 90,
    })
    findUniqueMock.mockResolvedValue({
      id: reservation.issuanceId,
      idempotencyKey: reservation.idempotencyKey,
      status: "PENDING",
      completedAt: null,
      data: { ...reservation.recordData, lifecycle: "DISPATCHING" },
    })

    const dispatched = await dispatchSection129UnderEligibilityLock({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      dispatch: async (markProviderInvocation) => {
        markProviderInvocation()
        return { ok: true }
      },
    })
    expect(dispatched).toMatchObject({
      kind: "PROVIDER_RETURNED",
      value: { ok: true },
      providerInvoked: true,
    })
    expect(queryRawMock).toHaveBeenCalled()
    const loanLockSql = (queryRawMock.mock.calls[0]?.[0] as readonly string[]).join("")
    expect(loanLockSql).toMatch(/FROM "Loan"[\s\S]*FOR NO KEY UPDATE/)
    expect(loanLockSql).not.toMatch(/FOR UPDATE/)
    expect(updateManyMock).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ data: { path: ["lifecycle"], equals: "READY" } }),
    }))

    await markSection129ReconciliationRequired({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      reason: "Provider outcome is uncertain",
    })
    expect(updateManyMock).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ data: { path: ["lifecycle"], equals: "DISPATCHING" } }),
    }))

    reservation.recordData = {
      ...reservation.recordData,
      lifecycle: "RECONCILIATION_REQUIRED",
    }
    findUniqueMock.mockResolvedValue({
      id: reservation.issuanceId,
      idempotencyKey: reservation.idempotencyKey,
      status: "PENDING",
      completedAt: null,
      data: reservation.recordData,
    })
    await releaseSection129IssuanceAfterReconciliation({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      reconciledById: "admin-1",
      reason: "Provider log confirms no delivery",
    })
    expect(updateManyMock).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        data: { path: ["lifecycle"], equals: "RECONCILIATION_REQUIRED" },
      }),
    }))
    expect(deleteFileMock).toHaveBeenCalledWith("/private/legal/notice.pdf")
  })

  it("keeps known provider evidence on a reconciliation-required legal record", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    reservation.recordData = {
      ...reservation.recordData,
      lifecycle: "DISPATCHING",
      dispatchStartedAt: new Date(Date.now() - 5_000).toISOString(),
    }
    findUniqueMock.mockResolvedValue({
      id: reservation.issuanceId,
      idempotencyKey: reservation.idempotencyKey,
      status: "PENDING",
      data: reservation.recordData,
    })
    const providerAcceptedAt = new Date(Date.now() - 1_000)
    const providerEvidenceReference =
      "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000002"

    await markSection129ReconciliationRequired({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      reason: "Terminal Message state could not be persisted",
      providerEvidenceReference,
      providerAcceptedAt,
      providerPersistenceWarning: "Message terminal persistence failed",
      emergencyEvidenceAuditPersisted: true,
    })

    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        data: expect.objectContaining({
          lifecycle: "RECONCILIATION_REQUIRED",
          providerEvidenceReference,
          providerAcceptedAt: providerAcceptedAt.toISOString(),
          providerPersistenceWarning: "Message terminal persistence failed",
          emergencyEvidenceAuditPersisted: true,
        }),
      },
    }))
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "SECTION_129_RECONCILIATION_REQUIRED",
        newValue: expect.objectContaining({
          providerEvidenceReference,
          providerAcceptedAt: providerAcceptedAt.toISOString(),
        }),
      }),
    }))
  })

  it("reports a preparation failure before the provider marker as known not invoked", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({
      ...naturalBorrower,
      clientId: "client-1",
      reference: "LN-1",
      status: "DEFAULTED",
      arrearsAmount: 25_000,
      outstandingPrincipal: 100_000,
      daysInArrears: 90,
    })

    const result = await dispatchSection129UnderEligibilityLock({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      dispatch: async () => {
        throw new Error("message preparation database failed")
      },
    })

    expect(result).toMatchObject({
      kind: "PROVIDER_THREW",
      providerInvoked: false,
      error: expect.objectContaining({ message: "message preparation database failed" }),
    })
  })

  it("does not treat default charges stated on the notice as a changed arrears snapshot", async () => {
    // The notice states arrears PLUS the charges owed; the loan row carries
    // schedule arrears only. Same loan, nothing changed: dispatch proceeds.
    const reservation = await reserveSection129Issuance({
      ...reservationArgs,
      arrearsAmount: 25_000 + 3_000,
      chargesOutstanding: 3_000,
      totalOutstanding: 131_000,
    })
    expect(reservation.recordData).toMatchObject({ arrearsAmount: 28_000, chargesOutstanding: 3_000, totalOutstanding: 131_000 })
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({
      ...naturalBorrower,
      clientId: "client-1", reference: "LN-1", status: "DEFAULTED",
      arrearsAmount: 25_000, outstandingPrincipal: 100_000, daysInArrears: 90,
    })
    findUniqueMock.mockResolvedValue({
      id: reservation.issuanceId, idempotencyKey: reservation.idempotencyKey, status: "PENDING",
      completedAt: null, data: { ...reservation.recordData, lifecycle: "DISPATCHING" },
    })

    const result = await dispatchSection129UnderEligibilityLock({
      reservation, tenantId: "t1", loanId: "loan-1", actorId: "user-1",
      dispatch: async (markProviderInvocation) => {
        markProviderInvocation()
        return { ok: true }
      },
    })
    expect(result).toMatchObject({ kind: "PROVIDER_RETURNED" })
  })

  it("deletes and releases an overstated notice when a partial payment changes the locked snapshot", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({
      ...naturalBorrower,
      clientId: "client-1",
      reference: "LN-1",
      status: "DEFAULTED",
      arrearsAmount: 20_000,
      outstandingPrincipal: 95_000,
      daysInArrears: 90,
    })
    const provider = vi.fn()

    const result = await dispatchSection129UnderEligibilityLock({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      dispatch: provider,
    })

    expect(result).toMatchObject({
      kind: "SNAPSHOT_CHANGED",
      error: expect.objectContaining({
        changedFields: ["loan.arrearsAmount", "loan.outstandingPrincipal"],
      }),
    })
    expect(provider).not.toHaveBeenCalled()
    expect(deleteFileMock).toHaveBeenCalledWith("/private/legal/notice.pdf")
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotencyKey: null, status: "OVERDUE" }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "SECTION_129_DISPATCH_BLOCKED_SNAPSHOT_CHANGED" }),
    }))
  })

  it("blocks a stale recipient and identity snapshot while holding the client lock", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({
      ...naturalBorrower,
      clientId: "client-1",
      reference: "LN-1",
      status: "DEFAULTED",
      arrearsAmount: 25_000,
      outstandingPrincipal: 100_000,
      daysInArrears: 90,
      client: {
        ...naturalBorrower.client,
        addressLine1: "2 Updated Street",
        email: "updated@example.test",
      },
    })
    const provider = vi.fn()

    const result = await dispatchSection129UnderEligibilityLock({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      dispatch: provider,
    })

    expect(result).toMatchObject({
      kind: "SNAPSHOT_CHANGED",
      error: expect.objectContaining({
        changedFields: ["borrower.addressLine1", "delivery.email"],
      }),
    })
    expect(provider).not.toHaveBeenCalled()
    expect(queryRawMock).toHaveBeenCalledWith(
      expect.stringMatching(/FROM "Client"[\s\S]*FOR UPDATE/),
      "client-1",
      "t1",
    )
  })

  it("blocks a notice whose operative date changed before provider dispatch", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"))
    const datedArgs = {
      ...reservationArgs,
      noticeDate: section129NoticeDateLabel(new Date()),
    }
    const reservation = await reserveSection129Issuance(datedArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    vi.setSystemTime(new Date("2026-07-21T10:00:00.000Z"))
    const provider = vi.fn()

    const result = await dispatchSection129UnderEligibilityLock({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      dispatch: provider,
    })

    expect(result).toMatchObject({
      kind: "SNAPSHOT_CHANGED",
      error: expect.objectContaining({ changedFields: ["notice.date"] }),
    })
    expect(provider).not.toHaveBeenCalled()
    expect(deleteFileMock).toHaveBeenCalledWith("/private/legal/notice.pdf")
  })

  it("blocks a provider call when a payment cures eligibility after reservation", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({
      clientId: "client-1",
      reference: "LN-1",
      status: "COMPLETED",
      arrearsAmount: 0,
      outstandingPrincipal: 0,
      daysInArrears: 0,
    })
    const provider = vi.fn()

    const result = await dispatchSection129UnderEligibilityLock({
      reservation,
      tenantId: "t1",
      loanId: "loan-1",
      actorId: "user-1",
      dispatch: provider,
    })

    expect(result.kind).toBe("INELIGIBLE")
    expect(provider).not.toHaveBeenCalled()
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        idempotencyKey: null,
        status: "OVERDUE",
        data: expect.objectContaining({ lifecycle: "FAILED" }),
      }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "SECTION_129_DISPATCH_BLOCKED_ELIGIBILITY_CHANGED" }),
    }))
  })

  it("dispatches an NCA entity notice to its active authorised contact under both borrower locks", async () => {
    const reservation = await reserveSection129Issuance({
      ...reservationArgs,
      clientName: "TEST Family Trust",
      clientEmail: "trustee@example.test",
      clientFirstName: "TEST Family Trust",
      clientLastName: "",
      clientIdNumber: "IT 000001/2099",
    })
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({
      clientId: null, entityId: "entity-1", client: null,
      entity: {
        legalName: "TEST Family Trust", registrationNumber: "IT 000001/2099",
        addressLine1: "1 Test Street", city: "Johannesburg",
        relationships: [{ client: { id: "trustee-1", email: "trustee@example.test", deceasedAt: null } }],
      },
      reference: "LN-1", status: "DEFAULTED", ncaRegime: "NCA",
      arrearsAmount: 25_000, outstandingPrincipal: 100_000, daysInArrears: 90,
    })
    const provider = vi.fn(async (markProviderInvocation: () => void) => {
      markProviderInvocation()
      return { ok: true }
    })

    await expect(dispatchSection129UnderEligibilityLock({
      reservation, tenantId: "t1", loanId: "loan-1", actorId: "user-1", dispatch: provider,
    })).resolves.toMatchObject({ kind: "PROVIDER_RETURNED" })

    expect(provider).toHaveBeenCalledOnce()
    const lockedTables = queryRawMock.mock.calls.map(([q]) => (Array.isArray(q) ? q.join("") : String(q)))
    expect(lockedTables.some((q) => q.includes('FROM "Client"'))).toBe(true)
    expect(lockedTables.some((q) => q.includes('FROM "BusinessEntity"'))).toBe(true)
  })

  it("refuses a NON_NCA loan on its regime first, even when its borrower is an entity", async () => {
    const reservation = await reserveSection129Issuance(reservationArgs)
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
    loanFindUniqueMock.mockResolvedValue({
      clientId: null, reference: "LN-1", status: "DEFAULTED", ncaRegime: "NON_NCA",
      arrearsAmount: 25_000, outstandingPrincipal: 100_000, daysInArrears: 120,
    })
    const provider = vi.fn()

    const result = await dispatchSection129UnderEligibilityLock({
      reservation, tenantId: "t1", loanId: "loan-1", actorId: "user-1", dispatch: provider,
    })

    expect(result.kind).toBe("INELIGIBLE")
    expect(result.kind === "INELIGIBLE" && result.error.message).toContain(SECTION129_NON_NCA_REASON)
    expect(provider).not.toHaveBeenCalled()
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "SECTION_129_DISPATCH_BLOCKED_ELIGIBILITY_CHANGED",
        newValue: expect.objectContaining({ reason: SECTION129_NON_NCA_REASON }),
      }),
    }))
  })

  it.each(["READY", "DISPATCHING"])(
    "does not allow a %s reservation to be reconciled while dispatch may still be active",
    async (lifecycle) => {
      findFirstMock.mockResolvedValue({
        id: "issue-1",
        idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
        status: "PENDING",
        completedAt: null,
        data: {
          lifecycle,
          storagePath: "/private/legal/notice.pdf",
          pdfSha256: section129PdfSha256(pdf),
        },
      })

      await expect(loadSection129ReservationForReconciliation({
        tenantId: "t1",
        loanId: "loan-1",
        issuanceId: "issue-1",
      })).rejects.toBeInstanceOf(Section129ArtifactUnavailableError)
    },
  )

  it("verifies the exact reserved artifact before an ISSUED reconciliation", async () => {
    const reservation = {
      issuanceId: "issue-1",
      idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
      pdfSha256: section129PdfSha256(pdf),
      recordData: {
        lifecycle: "RECONCILIATION_REQUIRED" as const,
        storagePath: "/private/legal/notice.pdf",
      } as never,
    }
    readFileMock.mockResolvedValue(Buffer.from("tampered"))

    await expect(verifySection129ReservationIntegrity(reservation))
      .rejects.toBeInstanceOf(Section129ArtifactIntegrityError)
  })

  it("does not expose a View link for a legacy completed row without immutable artifact metadata", async () => {
    findManyMock.mockResolvedValue([{
      id: "legacy-issue",
      idempotencyKey: null,
      status: "COMPLETED",
      completedAt: new Date("2026-05-01"),
      data: {},
    }])

    const availability = await getSection129IssuanceAvailability(
      "t1",
      "loan-1",
      new Date("2026-07-19"),
    )

    expect(availability.hasRetrievableIssuedArtifact).toBe(false)
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("allows a new reservation after a known-not-sent failure", async () => {
    findUniqueMock.mockResolvedValue(null)
    findFirstMock.mockResolvedValue(null)

    const availability = await getSection129ReservationAvailability("t1", "loan-1")

    expect(availability).toMatchObject({ canReserve: true, blockedBy: null })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  // Regression: this read runs from Server Component pages (loan detail,
  // collections) that never wrap in runWithTenant, so the tenant-scope
  // Prisma extension has no ALS context. The where clause MUST carry an
  // explicit tenantId or every one of those page loads 500s
  // (TenantScopeError: missing-context).
  it("scopes the idempotency lookup with an explicit tenantId (no ALS context available)", async () => {
    findUniqueMock.mockResolvedValue(null)
    findFirstMock.mockResolvedValue(null)

    await getSection129ReservationAvailability("t1", "loan-1")

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: expect.objectContaining({ tenantId: "t1" }),
    })
  })

  it("keeps a recent issued notice in cooldown but releases it after expiry", async () => {
    const completedAt = new Date("2026-07-01T00:00:00.000Z")
    const recent = {
      id: "issue-recent",
      idempotencyKey: null,
      status: "COMPLETED",
      completedAt,
      data: { lifecycle: "ISSUED" },
    }
    findUniqueMock.mockResolvedValue(null)
    findFirstMock.mockResolvedValue(recent)

    const blocked = await getSection129ReservationAvailability(
      "t1",
      "loan-1",
      new Date("2026-07-20T00:00:00.000Z"),
    )
    expect(blocked).toMatchObject({ canReserve: false, blockedBy: "RECENT_NOTICE" })

    findFirstMock.mockResolvedValue(null)
    const expired = await getSection129ReservationAvailability(
      "t1",
      "loan-1",
      new Date("2026-08-01T00:00:00.000Z"),
    )
    expect(expired).toMatchObject({ canReserve: true, blockedBy: null })
  })

  it("allows reissue after cooldown while retaining access to the prior immutable artifact", async () => {
    const completedAt = new Date("2026-05-01T00:00:00.000Z")
    findUniqueMock.mockResolvedValue({
      id: "issue-old",
      idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
      status: "COMPLETED",
      completedAt,
      data: {
        lifecycle: "ISSUED",
        storagePath: "/private/legal/notice.pdf",
        fileName: "Section-129-Notice-LN-1.pdf",
        pdfSha256: section129PdfSha256(pdf),
      },
    })
    findManyMock.mockResolvedValue([await findUniqueMock()])
    readFileMock.mockResolvedValue(pdf)

    const availability = await getSection129IssuanceAvailability(
      "t1",
      "loan-1",
      new Date("2026-07-19T00:00:00.000Z"),
    )

    expect(availability).toMatchObject({
      hasRetrievableIssuedArtifact: true,
      canReserve: true,
      blockedBy: null,
    })
  })

  it("says when the retrievable notice on file was simulated", async () => {
    const pdf = Buffer.from("%PDF simulated")
    findUniqueMock.mockResolvedValue(null)
    findFirstMock.mockResolvedValue(null)
    findManyMock.mockResolvedValue([{
      id: "issue-sim",
      idempotencyKey: null,
      status: "COMPLETED",
      completedAt: new Date("2026-07-18"),
      data: {
        lifecycle: "SIMULATED",
        storagePath: "/private/legal/notice.pdf",
        fileName: "Section-129-Notice-LN-1.pdf",
        pdfSha256: section129PdfSha256(pdf),
      },
    }])
    readFileMock.mockResolvedValue(pdf)
    expect(await getSection129IssuanceAvailability("t1", "loan-1", new Date("2026-09-19T00:00:00.000Z")))
      .toMatchObject({ hasRetrievableIssuedArtifact: true, latestIssuedSimulated: true })
  })

  it("detects tampering when serving a completed issued record", async () => {
    findManyMock.mockResolvedValue([{
      id: "issue-1",
      idempotencyKey: "t1:SECTION_129_NOTICE:loan-1",
      status: "COMPLETED",
      completedAt: new Date("2026-07-18"),
      data: {
        lifecycle: "ISSUED",
        storagePath: "/private/legal/notice.pdf",
        fileName: "Section-129-Notice-LN-1.pdf",
        pdfSha256: section129PdfSha256(pdf),
      },
    }])
    readFileMock.mockResolvedValue(Buffer.from("tampered"))
    const { loadIssuedSection129Artifact } = await import("./section129-artifact")

    await expect(loadIssuedSection129Artifact({ tenantId: "t1", loanId: "loan-1" }))
      .rejects.toBeInstanceOf(Section129ArtifactIntegrityError)
  })
})
