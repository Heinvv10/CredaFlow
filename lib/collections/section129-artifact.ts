import { createHash, randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  deleteManagedFileStrict,
  managedStoragePath,
  readFile,
  saveFileToManagedPath,
} from "@/lib/storage"
import {
  evaluateCollectionsEligibility,
  SECTION129_RECENT_NOTICE_WINDOW_DAYS,
} from "@/lib/collections/section129-eligibility"
import { lockLoanForNoKeyUpdate, lockLoanForUpdate } from "@/lib/loan/lock"
import { isCollectionsStageAtOrAfter } from "@/lib/collections/stages"
import { CHARGES_FLAG_INCLUDE, chargesEnabled } from "@/lib/loan/charges-replay"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { ChargesError } from "@/lib/loan/charges-error"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { SECTION129_BORROWER_INCLUDE, section129Addressee } from "./section129-addressee"

const NOTICE_TYPE = "SECTION_129_NOTICE" as const
export const SECTION129_STALE_RESERVATION_MS = 60 * 60 * 1000
interface ComplianceRecordRow {
  id: string
  idempotencyKey: string | null
  status: string
  completedAt: Date | null
  data: Prisma.JsonValue | null
}

interface ComplianceRecordDelegate {
  findUnique(args: unknown): Promise<ComplianceRecordRow | null>
  findFirst(args: unknown): Promise<ComplianceRecordRow | null>
  findMany(args: unknown): Promise<ComplianceRecordRow[]>
  create(args: unknown): Promise<{ id: string }>
  update(args: unknown): Promise<ComplianceRecordRow>
  updateMany(args: unknown): Promise<{ count: number }>
  count(args: unknown): Promise<number>
}

// The migration and schema in this PR add idempotencyKey. This narrow adapter
// keeps worktree typechecking deterministic even when all git worktrees share
// a Prisma client generated from main; CI regenerates the client from schema.
function complianceRecordDelegate(client: { complianceRecord: unknown }): ComplianceRecordDelegate {
  return client.complianceRecord as ComplianceRecordDelegate
}

interface AtomicAuditClient {
  auditLog: {
    create(args: unknown): Promise<unknown>
  }
}

async function createAtomicAudit(
  client: AtomicAuditClient,
  args: {
    tenantId: string
    userId?: string | null
    userEmail?: string | null
    action: string
    loanId: string
    oldValue?: Record<string, unknown>
    newValue?: Record<string, unknown>
  },
): Promise<void> {
  await client.auditLog.create({
    data: {
      tenantId: args.tenantId,
      userId: args.userId ?? null,
      userEmail: args.userEmail ?? null,
      action: args.action,
      entity: "Loan",
      entityId: args.loanId,
      oldValue: (args.oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      newValue: (args.newValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  })
}

export interface Section129RecordData extends Record<string, unknown> {
  // SIMULATED: a demo stack's notice to an undeliverable mailbox, recorded
  // and never sent (lib/collections/section129-email.ts). Not a statutory
  // notice: the NCR return and the register count it apart.
  lifecycle: "STAGING" | "READY" | "DISPATCHING" | "ISSUED" | "SIMULATED" | "FAILED" | "RECONCILIATION_REQUIRED"
  loanReference: string
  clientName: string
  clientEmail: string
  clientFirstName: string
  clientLastName: string
  clientIdNumber: string
  clientAddressLine1: string | null
  clientCity: string | null
  arrearsAmount: number
  outstandingPrincipal: number
  /** everything to settle, charges included, as the notice stated it */
  totalOutstanding?: number
  /** default charges included in arrearsAmount and totalOutstanding */
  chargesOutstanding?: number
  daysInArrears: number
  noticeDate: string
  storagePath?: string
  fileName: string
  fileSize?: number
  pdfSha256: string
  reservedById: string
  reservedAt: string
  dispatchStartedAt?: string
  issuedAt?: string
  failedAt?: string
  failureReason?: string
  emailMessageId?: string
  providerMessageId?: string
  providerEvidenceReference?: string
  providerAcceptedAt?: string
  providerPersistenceWarning?: string
  emergencyEvidenceAuditPersisted?: boolean
  bulk?: boolean
  /** A demo stack's simulated notice (lib/collections/section129-email.ts),
   *  decided at reservation so a stale or reconciled record keeps it. */
  simulated?: boolean
  reconciledById?: string
  reconciliationReason?: string
  reconciledAt?: string
  artifactDeletedAt?: string
  snapshotRedactedAt?: string
}

export interface ReservedSection129Issuance {
  issuanceId: string
  idempotencyKey: string
  pdfSha256: string
  recordData: Section129RecordData
}

export interface IssuedSection129Artifact {
  issuanceId: string
  pdfSha256: string
  pdf: Buffer
  fileName: string
}

export interface Section129IssuanceAvailability {
  hasRetrievableIssuedArtifact: boolean
  /** That latest retrievable notice was simulated (demo), not sent. */
  latestIssuedSimulated: boolean
  canReserve: boolean
  blockedBy: "ACTIVE_ISSUANCE" | "RECENT_NOTICE" | null
  activeLifecycle: Section129RecordData["lifecycle"] | null
  cooldownEndsAt: Date | null
}

export type Section129ReservationAvailability = Omit<
  Section129IssuanceAvailability,
  "hasRetrievableIssuedArtifact" | "latestIssuedSimulated"
>

export class Section129IssuanceConflictError extends Error {
  issuanceId: string | null
  lifecycle: string | null

  constructor(message: string, issuanceId: string | null = null, lifecycle: string | null = null) {
    super(message)
    this.name = "Section129IssuanceConflictError"
    this.issuanceId = issuanceId
    this.lifecycle = lifecycle
  }
}

export class Section129ArtifactUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "Section129ArtifactUnavailableError"
  }
}

export class Section129EligibilityChangedError extends Error {
  reason: string

  constructor(reason: string) {
    super(`Section 129 dispatch stopped because current loan eligibility changed: ${reason}.`)
    this.name = "Section129EligibilityChangedError"
    this.reason = reason
  }
}

export class Section129SnapshotChangedError extends Error {
  changedFields: string[]

  constructor(changedFields: string[]) {
    super(`Section 129 dispatch stopped because the operative notice snapshot changed: ${changedFields.join(", ")}. Regenerate the notice before sending.`)
    this.name = "Section129SnapshotChangedError"
    this.changedFields = changedFields
  }
}

export class Section129DispatchUncertainError extends Error {
  causeMessage: string

  constructor(causeMessage: string) {
    super("The provider may have received the Section 129 notice, but dispatch could not be durably confirmed. Do not retry; reconcile this issuance.")
    this.name = "Section129DispatchUncertainError"
    this.causeMessage = causeMessage
  }
}

export class Section129ArtifactIntegrityError extends Error {
  issuanceId: string
  expectedHash: string
  actualHash: string

  constructor(issuanceId: string, expectedHash: string, actualHash: string) {
    super("The issued Section 129 artifact failed its integrity check")
    this.name = "Section129ArtifactIntegrityError"
    this.issuanceId = issuanceId
    this.expectedHash = expectedHash
    this.actualHash = actualHash
  }
}

export function section129PdfSha256(pdf: Buffer): string {
  return createHash("sha256").update(pdf).digest("hex")
}

export function section129NoticeDateLabel(value: Date): string {
  return value.toLocaleDateString("en-ZA", {
    timeZone: SAST_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

function activeKey(tenantId: string, loanId: string): string {
  return `${tenantId}:${NOTICE_TYPE}:${loanId}`
}

function recordData(value: Prisma.JsonValue | null): Section129RecordData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as unknown as Section129RecordData
}

function conflictFor(record: { id: string; status: string; completedAt: Date | null; data: Prisma.JsonValue | null }) {
  const data = recordData(record.data)
  if (record.status === "COMPLETED") {
    return new Section129IssuanceConflictError(
      `A Section 129 notice was already issued within the last ${SECTION129_RECENT_NOTICE_WINDOW_DAYS} days.`,
      record.id,
      data?.lifecycle ?? "ISSUED",
    )
  }
  return new Section129IssuanceConflictError(
    data?.lifecycle === "RECONCILIATION_REQUIRED"
      ? "A prior Section 129 dispatch has an uncertain provider outcome and must be reconciled before any retry."
      : "A Section 129 issuance is already reserved or in progress for this loan.",
    record.id,
    data?.lifecycle ?? record.status,
  )
}

function pendingReservationTimestamp(data: Section129RecordData | null): number | null {
  if (!data || !["STAGING", "READY", "DISPATCHING"].includes(data.lifecycle)) return null
  const value = data.lifecycle === "DISPATCHING"
    ? data.dispatchStartedAt ?? data.reservedAt
    : data.reservedAt
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function isSection129PendingIssuanceStale(
  data: Prisma.JsonValue | Section129RecordData | null,
  now = new Date(),
): boolean {
  const parsed = recordData(data as Prisma.JsonValue | null)
  const pendingAt = pendingReservationTimestamp(parsed)
  return pendingAt !== null && now.getTime() - pendingAt >= SECTION129_STALE_RESERVATION_MS
}

function withoutUnissuedArtifact(
  data: Section129RecordData,
  updates: Partial<Section129RecordData>,
  deletedAt: Date,
): Section129RecordData {
  // A failed/not-sent attempt has no statutory retention purpose for the
  // duplicated recipient and financial snapshot. Keep the loan reference,
  // lifecycle and PDF hash as evidence, but minimise the extra POPIA copy.
  const retained: Section129RecordData = {
    ...data,
    clientName: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
    clientEmail: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
    clientFirstName: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
    clientLastName: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
    clientIdNumber: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
    clientAddressLine1: null,
    clientCity: null,
    arrearsAmount: 0,
    outstandingPrincipal: 0,
    daysInArrears: 0,
    snapshotRedactedAt: deletedAt.toISOString(),
  }
  delete retained.storagePath
  delete retained.fileSize
  return {
    ...retained,
    ...updates,
    artifactDeletedAt: deletedAt.toISOString(),
  }
}

async function deleteUnissuedArtifact(data: Section129RecordData): Promise<void> {
  if (data.storagePath) await deleteManagedFileStrict(data.storagePath)
}

export type Section129StaleRecoveryResult =
  | { kind: "NO_ACTIVE_ISSUANCE" }
  | { kind: "NOT_STALE"; issuanceId: string; lifecycle: Section129RecordData["lifecycle"] }
  | { kind: "STAGING_RELEASED"; issuanceId: string }
  | { kind: "RECONCILIATION_REQUIRED"; issuanceId: string; previousLifecycle: "READY" | "DISPATCHING" }

/**
 * Recover an abandoned issuance without guessing whether the provider sent it.
 * The compliance row is locked while a stale STAGING artifact is deleted and
 * while the lifecycle/audit transition commits. READY/DISPATCHING are kept
 * idempotency-locked because a process crash can roll a dispatch transaction
 * back to READY even after the external provider was called.
 */
export async function recoverStaleSection129Issuance(args: {
  tenantId: string
  loanId: string
  issuanceId?: string
  actorId: string
  actorEmail?: string | null
  now?: Date
}): Promise<Section129StaleRecoveryResult> {
  const now = args.now ?? new Date()
  const idempotencyKey = activeKey(args.tenantId, args.loanId)

  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT id FROM "ComplianceRecord"
         WHERE "idempotencyKey" = $1
         FOR UPDATE`,
      idempotencyKey,
    )
    const complianceRecord = complianceRecordDelegate(tx)
    const existing = await complianceRecord.findUnique({ where: { idempotencyKey } })
    if (
      !existing
      || (args.issuanceId && existing.id !== args.issuanceId)
      || existing.status !== "PENDING"
    ) {
      return { kind: "NO_ACTIVE_ISSUANCE" as const }
    }
    const existingData = recordData(existing.data)
    const pendingAt = pendingReservationTimestamp(existingData)
    if (!existingData || pendingAt === null || now.getTime() - pendingAt < SECTION129_STALE_RESERVATION_MS) {
      return {
        kind: "NOT_STALE" as const,
        issuanceId: existing.id,
        lifecycle: existingData?.lifecycle ?? "FAILED",
      }
    }

    if (existingData.lifecycle === "STAGING") {
      // Delete PII first. If deletion or the following transaction fails, the
      // active manifest remains indexed and a later recovery is safe to retry.
      await deleteUnissuedArtifact(existingData)
      const failedData = withoutUnissuedArtifact(existingData, {
        lifecycle: "FAILED",
        failedAt: now.toISOString(),
        failureReason: "Staged artifact did not reach READY before the storage timeout; provider was not invoked",
      }, now)
      const released = await complianceRecord.updateMany({
        where: {
          id: existing.id,
          idempotencyKey,
          status: "PENDING",
          data: { path: ["lifecycle"], equals: "STAGING" },
        },
        data: {
          idempotencyKey: null,
          status: "OVERDUE",
          data: failedData as unknown as Prisma.InputJsonValue,
        },
      })
      if (released.count !== 1) {
        throw new Section129IssuanceConflictError(
          "The staged Section 129 artifact changed while its timeout was being recovered.",
          existing.id,
          existingData.lifecycle,
        )
      }
      await createAtomicAudit(tx, {
        tenantId: args.tenantId,
        userId: args.actorId,
        userEmail: args.actorEmail,
        action: "SECTION_129_STAGED_ARTIFACT_EXPIRED",
        loanId: args.loanId,
        oldValue: { issuanceId: existing.id, lifecycle: "STAGING", storagePath: existingData.storagePath },
        newValue: {
          issuanceId: existing.id,
          lifecycle: "FAILED",
          providerInvoked: false,
          artifactDeletedAt: failedData.artifactDeletedAt,
          pdfSha256: failedData.pdfSha256,
        },
      })
      return { kind: "STAGING_RELEASED" as const, issuanceId: existing.id }
    }

    if (existingData.lifecycle !== "READY" && existingData.lifecycle !== "DISPATCHING") {
      return {
        kind: "NOT_STALE" as const,
        issuanceId: existing.id,
        lifecycle: existingData.lifecycle,
      }
    }

    const previousLifecycle = existingData.lifecycle
    const promotedData: Section129RecordData = {
      ...existingData,
      lifecycle: "RECONCILIATION_REQUIRED",
      failedAt: now.toISOString(),
      failureReason: `Stale ${previousLifecycle} reservation exceeded the dispatch timeout and requires reconciliation`,
    }
    const promoted = await complianceRecord.updateMany({
      where: {
        id: existing.id,
        idempotencyKey,
        status: "PENDING",
        data: { path: ["lifecycle"], equals: previousLifecycle },
      },
      data: { data: promotedData as unknown as Prisma.InputJsonValue },
    })
    if (promoted.count !== 1) {
      throw new Section129IssuanceConflictError(
        "The Section 129 issuance changed while its stale state was being recovered.",
        existing.id,
        previousLifecycle,
      )
    }
    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.actorId,
      userEmail: args.actorEmail,
      action: "SECTION_129_RECONCILIATION_REQUIRED",
      loanId: args.loanId,
      oldValue: { issuanceId: existing.id, lifecycle: previousLifecycle },
      newValue: {
        issuanceId: existing.id,
        lifecycle: "RECONCILIATION_REQUIRED",
        reason: promotedData.failureReason,
      },
    })
    return {
      kind: "RECONCILIATION_REQUIRED" as const,
      issuanceId: existing.id,
      previousLifecycle,
    }
  })
}

type RetrievableSection129RecordData = Section129RecordData & {
  storagePath: string
  fileName: string
  pdfSha256: string
}

function isRetrievableIssuedRecordData(
  data: Section129RecordData | null,
): data is RetrievableSection129RecordData {
  return (data?.lifecycle === "ISSUED" || data?.lifecycle === "SIMULATED")
    && typeof data.storagePath === "string"
    && data.storagePath.length > 0
    && typeof data.fileName === "string"
    && data.fileName.length > 0
    && typeof data.pdfSha256 === "string"
    && /^[a-f0-9]{64}$/.test(data.pdfSha256)
}

/**
 * Persist private immutable bytes and reserve the statutory action before any
 * provider call. The unique active key serialises single, bulk and concurrent
 * requests. This record is deliberately not a ClientDocument, so unissued
 * notices cannot leak into the portal or generic document mutation routes.
 */
export async function reserveSection129Issuance(args: {
  tenantId: string
  loanId: string
  loanReference: string
  clientName: string
  clientEmail: string
  clientFirstName: string
  clientLastName: string
  clientIdNumber: string
  clientAddressLine1: string | null
  clientCity: string | null
  arrearsAmount: number
  outstandingPrincipal: number
  totalOutstanding?: number
  chargesOutstanding?: number
  daysInArrears: number
  noticeDate: string
  pdf: Buffer
  createdById: string
  createdByEmail?: string | null
  bulk?: boolean
  /** The send will be simulated (simulatesSection129): recorded from the start. */
  simulated?: boolean
}): Promise<ReservedSection129Issuance> {
  if (!Buffer.isBuffer(args.pdf) || args.pdf.length === 0) {
    throw new Error("Section 129 attachment is missing or empty")
  }
  const pdfSha256 = section129PdfSha256(args.pdf)
  const storageKey = `section129-${randomUUID()}`
  const storagePath = managedStoragePath(storageKey, "application/pdf")
  const fileSize = args.pdf.length
  const idempotencyKey = activeKey(args.tenantId, args.loanId)
  const now = new Date()
  const stagedData: Section129RecordData = {
    lifecycle: "STAGING",
    loanReference: args.loanReference,
    clientName: args.clientName,
    clientEmail: args.clientEmail,
    clientFirstName: args.clientFirstName,
    clientLastName: args.clientLastName,
    clientIdNumber: args.clientIdNumber,
    clientAddressLine1: args.clientAddressLine1,
    clientCity: args.clientCity,
    arrearsAmount: args.arrearsAmount,
    outstandingPrincipal: args.outstandingPrincipal,
    ...(args.totalOutstanding !== undefined ? { totalOutstanding: args.totalOutstanding } : {}),
    ...(args.chargesOutstanding ? { chargesOutstanding: args.chargesOutstanding } : {}),
    daysInArrears: args.daysInArrears,
    noticeDate: args.noticeDate,
    storagePath,
    fileName: `Section-129-Notice-${args.loanReference}.pdf`,
    fileSize,
    pdfSha256,
    reservedById: args.createdById,
    reservedAt: now.toISOString(),
    ...(args.bulk ? { bulk: true } : {}),
    ...(args.simulated ? { simulated: true } : {}),
  }

  const recovered = await recoverStaleSection129Issuance({
    tenantId: args.tenantId,
    loanId: args.loanId,
    actorId: args.createdById,
    actorEmail: args.createdByEmail,
    now,
  })
  if (recovered.kind === "RECONCILIATION_REQUIRED") {
    throw new Section129IssuanceConflictError(
      "A stale Section 129 issuance was locked for reconciliation. Confirm the provider outcome before any retry.",
      recovered.issuanceId,
      "RECONCILIATION_REQUIRED",
    )
  }

  let issuanceId: string
  try {
    issuanceId = await prisma.$transaction(async (tx) => {
      const complianceRecord = complianceRecordDelegate(tx)
      const existing = await complianceRecord.findUnique({ where: { idempotencyKey } })
      if (existing) {
        const cutoff = new Date(now.getTime() - SECTION129_RECENT_NOTICE_WINDOW_DAYS * 86400000)
        if (existing.status === "COMPLETED" && existing.completedAt && existing.completedAt < cutoff) {
          await complianceRecord.update({
            where: { id: existing.id },
            data: { idempotencyKey: null },
          })
          await createAtomicAudit(tx, {
            tenantId: args.tenantId,
            userId: args.createdById,
            userEmail: args.createdByEmail,
            action: "SECTION_129_COOLDOWN_RELEASED",
            loanId: args.loanId,
            oldValue: { issuanceId: existing.id, lifecycle: recordData(existing.data)?.lifecycle ?? "ISSUED" },
            newValue: { idempotencyKeyReleased: true },
          })
        } else {
          throw conflictFor(existing)
        }
      }

      // Pre-migration completed rows have no idempotencyKey. Keep their
      // original rolling cooldown effective so deploying this reservation
      // mechanism cannot accidentally re-send a recent statutory notice.
      const legacyRecent = await complianceRecord.findFirst({
        where: {
          tenantId: args.tenantId,
          type: NOTICE_TYPE,
          referenceId: args.loanId,
          status: "COMPLETED",
          completedAt: {
            gte: new Date(now.getTime() - SECTION129_RECENT_NOTICE_WINDOW_DAYS * 86400000),
          },
        },
        orderBy: { completedAt: "desc" },
      })
      if (legacyRecent) throw conflictFor(legacyRecent)

      const created = await complianceRecord.create({
        data: {
          tenantId: args.tenantId,
          type: NOTICE_TYPE,
          referenceId: args.loanId,
          idempotencyKey,
          status: "PENDING",
          data: stagedData as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      })
      await createAtomicAudit(tx, {
        tenantId: args.tenantId,
        userId: args.createdById,
        userEmail: args.createdByEmail,
        action: "SECTION_129_ARTIFACT_STAGED",
        loanId: args.loanId,
        newValue: {
          issuanceId: created.id,
          lifecycle: "STAGING",
          pdfSha256,
          storagePath,
          bulk: args.bulk === true,
        },
      })
      return created.id
    })
  } catch (error) {
    if (error instanceof Section129IssuanceConflictError) throw error
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await complianceRecordDelegate(prisma).findUnique({ where: { idempotencyKey } })
      if (existing) throw conflictFor(existing)
    }
    throw error
  }

  try {
    await saveFileToManagedPath(args.pdf, "application/pdf", storageKey)
  } catch (error) {
    await deleteManagedFileStrict(storagePath)
    await prisma.$transaction(async (tx) => {
      const failedAt = new Date()
      const failedData = withoutUnissuedArtifact(stagedData, {
        lifecycle: "FAILED",
        failedAt: failedAt.toISOString(),
        failureReason: `Private artifact write failed: ${error instanceof Error ? error.message : String(error)}`,
      }, failedAt)
      const failed = await complianceRecordDelegate(tx).updateMany({
        where: {
          id: issuanceId,
          idempotencyKey,
          status: "PENDING",
          data: { path: ["lifecycle"], equals: "STAGING" },
        },
        data: {
          idempotencyKey: null,
          status: "OVERDUE",
          data: failedData as unknown as Prisma.InputJsonValue,
        },
      })
      if (failed.count !== 1) {
        throw new Section129IssuanceConflictError(
          "The staged Section 129 artifact changed before its known storage failure could be recorded.",
          issuanceId,
        )
      }
      await createAtomicAudit(tx, {
        tenantId: args.tenantId,
        userId: args.createdById,
        userEmail: args.createdByEmail,
        action: "SECTION_129_ARTIFACT_STAGING_FAILED",
        loanId: args.loanId,
        oldValue: { issuanceId, lifecycle: "STAGING" },
        newValue: {
          issuanceId,
          lifecycle: "FAILED",
          providerInvoked: false,
          artifactDeletedAt: failedData.artifactDeletedAt,
          pdfSha256: failedData.pdfSha256,
        },
      })
    }).catch(() => {
      // The durable STAGING manifest already contains the exact expected path
      // and hash. If the DB is unavailable, leave it indexed for recovery.
    })
    throw error
  }

  const readyData: Section129RecordData = { ...stagedData, lifecycle: "READY" }
  try {
    await prisma.$transaction(async (tx) => {
      const ready = await complianceRecordDelegate(tx).updateMany({
        where: {
          id: issuanceId,
          idempotencyKey,
          status: "PENDING",
          data: { path: ["lifecycle"], equals: "STAGING" },
        },
        data: { data: readyData as unknown as Prisma.InputJsonValue },
      })
      if (ready.count !== 1) {
        throw new Section129IssuanceConflictError(
          "The staged Section 129 artifact changed before it could become ready for dispatch.",
          issuanceId,
        )
      }
      await createAtomicAudit(tx, {
        tenantId: args.tenantId,
        userId: args.createdById,
        userEmail: args.createdByEmail,
        action: "SECTION_129_ISSUANCE_RESERVED",
        loanId: args.loanId,
        oldValue: { issuanceId, lifecycle: "STAGING" },
        newValue: { issuanceId, lifecycle: "READY", pdfSha256, bulk: args.bulk === true },
      })
    })
  } catch (error) {
    // The bytes now exist, but a concurrent stale-recovery can have deleted an
    // earlier ENOENT path and released/redacted the STAGING manifest before
    // this writer finished. Likewise, an audit failure rolls the READY update
    // back. In either case the file must be removed before the conflict escapes
    // or it becomes an unindexed PII artifact.
    await deleteManagedFileStrict(storagePath)
    throw error
  }

  return { issuanceId, idempotencyKey, pdfSha256, recordData: readyData }
}

export type Section129ProviderDispatchResult<T> =
  | { kind: "PROVIDER_RETURNED"; value: T; providerInvoked: boolean }
  | { kind: "PROVIDER_THREW"; error: Error; providerInvoked: boolean }
  | { kind: "INELIGIBLE"; error: Section129EligibilityChangedError }
  | { kind: "SNAPSHOT_CHANGED"; error: Section129SnapshotChangedError }

/**
 * Linearise the final statutory eligibility decision with every payment path.
 * The loan row remains locked from the fresh read until the provider call has
 * returned, so a concurrent receipt cannot cure or settle the loan between the
 * decision and dispatch. Provider failures are returned (not thrown inside the
 * transaction), ensuring DISPATCHING + its audit commit before reconciliation.
 */
export async function dispatchSection129UnderEligibilityLock<T>(args: {
  reservation: ReservedSection129Issuance
  tenantId: string
  loanId: string
  actorId: string
  actorEmail?: string | null
  dispatch: (markProviderInvocation: () => void) => Promise<T>
}): Promise<Section129ProviderDispatchResult<T>> {
  let providerInvoked = false
  try {
    return await prisma.$transaction(async (tx) => {
      // The provider callback may create a Conversation with loanId in its own
      // transaction. NO KEY UPDATE still blocks every balance/state writer but
      // permits the FK's KEY SHARE lock, avoiding a first-message self-deadlock.
      await lockLoanForNoKeyUpdate(tx, args.loanId)
      const loan = await tx.loan.findUnique({
        where: { id: args.loanId, tenantId: args.tenantId },
        select: {
          clientId: true,
          entityId: true,
          reference: true,
          status: true,
          ncaRegime: true,
          arrearsAmount: true,
          outstandingPrincipal: true,
          daysInArrears: true,
          ...SECTION129_BORROWER_INCLUDE,
        },
      })
      if (!loan) {
        throw new Section129EligibilityChangedError("loan no longer exists in this tenant")
      }
      const eligibility = evaluateCollectionsEligibility(loan, "SECTION_129")
      if (!eligibility.eligible) {
        const failedAt = new Date()
        await deleteUnissuedArtifact(args.reservation.recordData)
        const failedData = withoutUnissuedArtifact(args.reservation.recordData, {
          lifecycle: "FAILED",
          failedAt: failedAt.toISOString(),
          failureReason: `Eligibility changed before provider dispatch: ${eligibility.reason}`,
        }, failedAt)
        const released = await complianceRecordDelegate(tx).updateMany({
          where: {
            id: args.reservation.issuanceId,
            idempotencyKey: args.reservation.idempotencyKey,
            status: "PENDING",
            data: { path: ["lifecycle"], equals: "READY" },
          },
          data: {
            idempotencyKey: null,
            status: "OVERDUE",
            data: failedData as unknown as Prisma.InputJsonValue,
          },
        })
        if (released.count !== 1) {
          throw new Section129IssuanceConflictError(
            "The Section 129 issuance reservation changed before eligibility could be rechecked.",
            args.reservation.issuanceId,
          )
        }
        await createAtomicAudit(tx, {
          tenantId: args.tenantId,
          userId: args.actorId,
          userEmail: args.actorEmail,
          action: "SECTION_129_DISPATCH_BLOCKED_ELIGIBILITY_CHANGED",
          loanId: args.loanId,
          oldValue: { issuanceId: args.reservation.issuanceId, lifecycle: "READY" },
          newValue: {
            issuanceId: args.reservation.issuanceId,
            lifecycle: "FAILED",
            providerInvoked: false,
            reason: eligibility.reason,
            artifactDeletedAt: failedData.artifactDeletedAt,
            pdfSha256: failedData.pdfSha256,
          },
        })
        args.reservation.recordData = failedData
        return {
          kind: "INELIGIBLE" as const,
          error: new Section129EligibilityChangedError(
            eligibility.reason ?? "current policy rejected the loan",
          ),
        }
      }

      const addressee = section129Addressee(loan)
      if (!addressee) throw new Section129EligibilityChangedError("borrower has no active authorised contact")
      await tx.$queryRawUnsafe(
        `SELECT id FROM "Client" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE`,
        addressee.lockClientId,
        args.tenantId,
      )
      if (addressee.lockEntityId) {
        await tx.$queryRawUnsafe(
          `SELECT id FROM "BusinessEntity" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE`,
          addressee.lockEntityId,
          args.tenantId,
        )
      }
      const operativeSnapshot = args.reservation.recordData
      const changedFields = [
        ["loan.reference", operativeSnapshot.loanReference, loan.reference],
        // The notice states arrears plus the default charges owed; the loan row
        // holds schedule arrears only, so compare like with like.
        ["loan.arrearsAmount", operativeSnapshot.arrearsAmount - (operativeSnapshot.chargesOutstanding ?? 0), loan.arrearsAmount],
        ["loan.outstandingPrincipal", operativeSnapshot.outstandingPrincipal, loan.outstandingPrincipal],
        ["loan.daysInArrears", operativeSnapshot.daysInArrears, loan.daysInArrears],
        ["notice.date", operativeSnapshot.noticeDate, section129NoticeDateLabel(new Date())],
        ["borrower.firstName", operativeSnapshot.clientFirstName, addressee.firstName],
        ["borrower.lastName", operativeSnapshot.clientLastName, addressee.lastName],
        ["borrower.identityNumber", operativeSnapshot.clientIdNumber, addressee.identityNumber],
        ["borrower.addressLine1", operativeSnapshot.clientAddressLine1, addressee.addressLine1],
        ["borrower.city", operativeSnapshot.clientCity, addressee.city],
        ["delivery.email", operativeSnapshot.clientEmail, addressee.email],
      ].filter(([, reserved, current]) => !Object.is(reserved, current)).map(([field]) => field as string)

      if (changedFields.length > 0) {
        const failedAt = new Date()
        await deleteUnissuedArtifact(operativeSnapshot)
        const snapshotError = new Section129SnapshotChangedError(changedFields)
        const failedData = withoutUnissuedArtifact(operativeSnapshot, {
          lifecycle: "FAILED",
          failedAt: failedAt.toISOString(),
          failureReason: snapshotError.message,
        }, failedAt)
        const released = await complianceRecordDelegate(tx).updateMany({
          where: {
            id: args.reservation.issuanceId,
            idempotencyKey: args.reservation.idempotencyKey,
            status: "PENDING",
            data: { path: ["lifecycle"], equals: "READY" },
          },
          data: {
            idempotencyKey: null,
            status: "OVERDUE",
            data: failedData as unknown as Prisma.InputJsonValue,
          },
        })
        if (released.count !== 1) {
          throw new Section129IssuanceConflictError(
            "The Section 129 issuance reservation changed before its operative snapshot could be rechecked.",
            args.reservation.issuanceId,
          )
        }
        await createAtomicAudit(tx, {
          tenantId: args.tenantId,
          userId: args.actorId,
          userEmail: args.actorEmail,
          action: "SECTION_129_DISPATCH_BLOCKED_SNAPSHOT_CHANGED",
          loanId: args.loanId,
          oldValue: { issuanceId: args.reservation.issuanceId, lifecycle: "READY" },
          newValue: {
            issuanceId: args.reservation.issuanceId,
            lifecycle: "FAILED",
            providerInvoked: false,
            changedFields,
            artifactDeletedAt: failedData.artifactDeletedAt,
            pdfSha256: failedData.pdfSha256,
          },
        })
        args.reservation.recordData = failedData
        return { kind: "SNAPSHOT_CHANGED" as const, error: snapshotError }
      }

      const dispatchData: Section129RecordData = {
        ...args.reservation.recordData,
        lifecycle: "DISPATCHING",
        dispatchStartedAt: new Date().toISOString(),
      }
      const updated = await complianceRecordDelegate(tx).updateMany({
        where: {
          id: args.reservation.issuanceId,
          idempotencyKey: args.reservation.idempotencyKey,
          status: "PENDING",
          data: { path: ["lifecycle"], equals: "READY" },
        },
        data: { data: dispatchData as unknown as Prisma.InputJsonValue },
      })
      if (updated.count !== 1) {
        throw new Section129IssuanceConflictError(
          "The Section 129 issuance reservation changed before dispatch could start.",
          args.reservation.issuanceId,
        )
      }
      await createAtomicAudit(tx, {
        tenantId: args.tenantId,
        userId: args.actorId,
        userEmail: args.actorEmail,
        action: "SECTION_129_DISPATCH_STARTED",
        loanId: args.loanId,
        oldValue: { issuanceId: args.reservation.issuanceId, lifecycle: "READY" },
        newValue: { issuanceId: args.reservation.issuanceId, lifecycle: "DISPATCHING" },
      })
      args.reservation.recordData = dispatchData
      const markProviderInvocation = () => {
        providerInvoked = true
      }
      try {
        return {
          kind: "PROVIDER_RETURNED" as const,
          value: await args.dispatch(markProviderInvocation),
          providerInvoked,
        }
      } catch (error) {
        return {
          kind: "PROVIDER_THREW" as const,
          error: error instanceof Error ? error : new Error(String(error)),
          providerInvoked,
        }
      }
    }, { timeout: 120_000 })
  } catch (error) {
    if (!providerInvoked) throw error
    const reason = error instanceof Error ? error.message : String(error)
    await markSection129ReconciliationRequired({
      reservation: args.reservation,
      tenantId: args.tenantId,
      loanId: args.loanId,
      actorId: args.actorId,
      actorEmail: args.actorEmail,
      reason: `Provider was invoked, but the dispatch transaction did not commit: ${reason}`,
    }).catch(() => {})
    throw new Section129DispatchUncertainError(reason)
  }
}

/** Release only failures known to have happened before any provider call. */
export async function markSection129KnownNotSent(args: {
  reservation: ReservedSection129Issuance
  tenantId: string
  loanId: string
  actorId: string
  actorEmail?: string | null
  reason: string
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT id FROM "ComplianceRecord" WHERE "idempotencyKey" = $1 FOR UPDATE`,
      args.reservation.idempotencyKey,
    )
    const complianceRecord = complianceRecordDelegate(tx)
    const current = await complianceRecord.findUnique({
      where: { idempotencyKey: args.reservation.idempotencyKey },
    })
    const currentData = recordData(current?.data ?? null)
    if (
      !current
      || current.id !== args.reservation.issuanceId
      || current.status !== "PENDING"
      || !currentData
      || !["READY", "DISPATCHING"].includes(currentData.lifecycle)
    ) {
      throw new Section129IssuanceConflictError(
        "The Section 129 issuance changed before the known-not-sent failure could be recorded.",
        args.reservation.issuanceId,
      )
    }

    const failedAt = new Date()
    await deleteUnissuedArtifact(currentData)
    const failedData = withoutUnissuedArtifact(currentData, {
      lifecycle: "FAILED",
      failedAt: failedAt.toISOString(),
      failureReason: args.reason,
    }, failedAt)
    const updated = await complianceRecord.updateMany({
      where: {
        id: args.reservation.issuanceId,
        idempotencyKey: args.reservation.idempotencyKey,
        status: "PENDING",
        data: { path: ["lifecycle"], equals: currentData.lifecycle },
      },
      data: {
        idempotencyKey: null,
        status: "OVERDUE",
        data: failedData as unknown as Prisma.InputJsonValue,
      },
    })
    if (updated.count !== 1) {
      throw new Section129IssuanceConflictError(
        "The Section 129 issuance changed before the known-not-sent failure could be recorded.",
        args.reservation.issuanceId,
      )
    }
    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.actorId,
      userEmail: args.actorEmail,
      action: "SECTION_129_DISPATCH_KNOWN_NOT_SENT",
      loanId: args.loanId,
      oldValue: { issuanceId: args.reservation.issuanceId, lifecycle: currentData.lifecycle },
      newValue: {
        issuanceId: args.reservation.issuanceId,
        lifecycle: "FAILED",
        providerInvoked: false,
        reason: args.reason,
        artifactDeletedAt: failedData.artifactDeletedAt,
        pdfSha256: failedData.pdfSha256,
      },
    })
    args.reservation.recordData = failedData
  })
}

export async function loadSection129ReservationForReconciliation(args: {
  tenantId: string
  loanId: string
  issuanceId: string
}): Promise<ReservedSection129Issuance> {
  const issuance = await complianceRecordDelegate(prisma).findFirst({
    where: {
      id: args.issuanceId,
      tenantId: args.tenantId,
      referenceId: args.loanId,
      type: NOTICE_TYPE,
      status: "PENDING",
      idempotencyKey: { not: null },
    },
    select: { id: true, idempotencyKey: true, data: true },
  })
  const data = recordData(issuance?.data ?? null)
  if (
    !issuance?.idempotencyKey
    || data?.lifecycle !== "RECONCILIATION_REQUIRED"
    || !data.pdfSha256
    || !data.storagePath
  ) {
    throw new Section129ArtifactUnavailableError(
      "The pending Section 129 issuance is unavailable or is not eligible for reconciliation.",
    )
  }
  return {
    issuanceId: issuance.id,
    idempotencyKey: issuance.idempotencyKey,
    pdfSha256: data.pdfSha256,
    recordData: data,
  }
}

export async function verifySection129ReservationIntegrity(
  reservation: ReservedSection129Issuance,
): Promise<void> {
  const storagePath = reservation.recordData.storagePath
  if (!storagePath) {
    throw new Section129ArtifactUnavailableError(
      "The reserved Section 129 artifact is missing and cannot be reconciled as issued.",
    )
  }
  let pdf: Buffer
  try {
    pdf = await readFile(storagePath)
  } catch {
    throw new Section129ArtifactUnavailableError(
      "The reserved Section 129 artifact is missing and cannot be reconciled as issued.",
    )
  }
  const actualHash = section129PdfSha256(pdf)
  if (actualHash !== reservation.pdfSha256) {
    throw new Section129ArtifactIntegrityError(
      reservation.issuanceId,
      reservation.pdfSha256,
      actualHash,
    )
  }
}

export async function releaseSection129IssuanceAfterReconciliation(args: {
  reservation: ReservedSection129Issuance
  tenantId: string
  loanId: string
  reconciledById: string
  reconciledByEmail?: string | null
  reason: string
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT id FROM "ComplianceRecord" WHERE "idempotencyKey" = $1 FOR UPDATE`,
      args.reservation.idempotencyKey,
    )
    const complianceRecord = complianceRecordDelegate(tx)
    const current = await complianceRecord.findUnique({
      where: { idempotencyKey: args.reservation.idempotencyKey },
    })
    const currentData = recordData(current?.data ?? null)
    if (
      !current
      || current.id !== args.reservation.issuanceId
      || current.status !== "PENDING"
      || currentData?.lifecycle !== "RECONCILIATION_REQUIRED"
    ) {
      throw new Section129IssuanceConflictError(
        "The pending Section 129 issuance changed before reconciliation completed.",
        args.reservation.issuanceId,
      )
    }
    const failedAt = new Date()
    await deleteUnissuedArtifact(currentData)
    const failedData = withoutUnissuedArtifact(currentData, {
      lifecycle: "FAILED",
      failedAt: failedAt.toISOString(),
      failureReason: "Reconciled as not sent",
      reconciledById: args.reconciledById,
      reconciliationReason: args.reason,
    }, failedAt)
    const updated = await complianceRecord.updateMany({
      where: {
        id: args.reservation.issuanceId,
        idempotencyKey: args.reservation.idempotencyKey,
        status: "PENDING",
        data: { path: ["lifecycle"], equals: "RECONCILIATION_REQUIRED" },
      },
      data: {
        idempotencyKey: null,
        status: "OVERDUE",
        data: failedData as unknown as Prisma.InputJsonValue,
      },
    })
    if (updated.count !== 1) {
      throw new Section129IssuanceConflictError(
        "The pending Section 129 issuance changed before reconciliation completed.",
        args.reservation.issuanceId,
      )
    }
    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.reconciledById,
      userEmail: args.reconciledByEmail,
      action: "SECTION_129_ISSUANCE_RECONCILED",
      loanId: args.loanId,
      oldValue: { issuanceId: args.reservation.issuanceId, lifecycle: "RECONCILIATION_REQUIRED" },
      newValue: {
        issuanceId: args.reservation.issuanceId,
        lifecycle: "FAILED",
        outcome: "NOT_SENT",
        reason: args.reason,
        artifactDeletedAt: failedData.artifactDeletedAt,
        pdfSha256: failedData.pdfSha256,
      },
    })
    args.reservation.recordData = failedData
  })
}

/** Provider failures are potentially ambiguous; keep the key locked for review. */
export async function markSection129ReconciliationRequired(args: {
  reservation: ReservedSection129Issuance
  tenantId: string
  loanId: string
  actorId: string
  actorEmail?: string | null
  reason: string
  providerMessageId?: string
  providerEvidenceReference?: string
  providerAcceptedAt?: Date
  providerPersistenceWarning?: string
  emergencyEvidenceAuditPersisted?: boolean
  /** The notice was simulated, not sent: carried through to the reconciled record. */
  simulated?: boolean
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await complianceRecordDelegate(tx).findUnique({
      where: { idempotencyKey: args.reservation.idempotencyKey },
    })
    const currentData = recordData(current?.data ?? null)
    if (
      !current
      || current.id !== args.reservation.issuanceId
      || current.status !== "PENDING"
      || !currentData
      || !["READY", "DISPATCHING"].includes(currentData.lifecycle)
    ) {
      throw new Section129IssuanceConflictError(
        "The Section 129 issuance changed before reconciliation-required status could be recorded.",
        args.reservation.issuanceId,
      )
    }
    const providerAcceptedAt = args.providerAcceptedAt
    if (providerAcceptedAt && !Number.isFinite(providerAcceptedAt.getTime())) {
      throw new Error("The provider acceptance timestamp is invalid")
    }
    const reconciliationData: Section129RecordData = {
      ...currentData,
      lifecycle: "RECONCILIATION_REQUIRED",
      failedAt: new Date().toISOString(),
      failureReason: args.reason,
      ...(args.providerMessageId ? { providerMessageId: args.providerMessageId } : {}),
      ...(args.providerEvidenceReference
        ? { providerEvidenceReference: args.providerEvidenceReference }
        : {}),
      ...(providerAcceptedAt ? { providerAcceptedAt: providerAcceptedAt.toISOString() } : {}),
      ...(args.providerPersistenceWarning
        ? { providerPersistenceWarning: args.providerPersistenceWarning }
        : {}),
      ...(args.emergencyEvidenceAuditPersisted !== undefined
        ? { emergencyEvidenceAuditPersisted: args.emergencyEvidenceAuditPersisted }
        : {}),
      ...(args.simulated ? { simulated: true } : {}),
    }
    const updated = await complianceRecordDelegate(tx).updateMany({
      where: {
        id: args.reservation.issuanceId,
        idempotencyKey: args.reservation.idempotencyKey,
        status: "PENDING",
        data: { path: ["lifecycle"], equals: currentData.lifecycle },
      },
      data: { data: reconciliationData as unknown as Prisma.InputJsonValue },
    })
    if (updated.count !== 1) {
      throw new Section129IssuanceConflictError(
        "The Section 129 issuance changed before reconciliation-required status could be recorded.",
        args.reservation.issuanceId,
      )
    }
    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.actorId,
      userEmail: args.actorEmail,
      action: "SECTION_129_RECONCILIATION_REQUIRED",
      loanId: args.loanId,
      oldValue: { issuanceId: args.reservation.issuanceId, lifecycle: currentData.lifecycle },
      newValue: {
        issuanceId: args.reservation.issuanceId,
        lifecycle: "RECONCILIATION_REQUIRED",
        reason: args.reason,
        providerMessageId: args.providerMessageId,
        providerEvidenceReference: args.providerEvidenceReference,
        providerAcceptedAt: providerAcceptedAt?.toISOString(),
        providerPersistenceWarning: args.providerPersistenceWarning,
        emergencyEvidenceAuditPersisted: args.emergencyEvidenceAuditPersisted,
        ...(args.simulated ? { simulated: true } : {}),
      },
    })
    args.reservation.recordData = reconciliationData
  })
}

export async function finaliseSection129Issuance(args: {
  reservation: ReservedSection129Issuance
  tenantId: string
  loanId: string
  issuedById: string
  issuedByEmail?: string | null
  emailMessageId?: string
  providerMessageId?: string
  providerEvidenceReference?: string
  providerPersistenceWarning?: string
  emergencyEvidenceAuditPersisted?: boolean
  reconciliationReason?: string
  issuedAt: Date
  /** Demo stack, .invalid mailbox: recorded as "simulated (not sent)" (lib/collections/section129-email.ts). */
  simulated?: boolean
}): Promise<void> {
  const reconciledAt = new Date()
  const issuedAt = args.issuedAt
  // Also when a simulated notice reaches here through reconciliation: the
  // reserved record carries the flag (markSection129ReconciliationRequired).
  const simulated = args.simulated === true || args.reservation.recordData.simulated === true
  const finalLifecycle = simulated ? "SIMULATED" : "ISSUED"
  const providerMessageId = (args.providerMessageId ?? args.emailMessageId)?.trim()
  const providerEvidenceReference = args.providerEvidenceReference?.trim()
  const durableProviderReference = providerMessageId ?? providerEvidenceReference
  if (!(issuedAt instanceof Date)) {
    throw new Error("A provider-confirmed issuance timestamp is required")
  }
  if (!Number.isFinite(issuedAt.getTime()) || issuedAt.getTime() > reconciledAt.getTime()) {
    throw new Error("The Section 129 issuance timestamp is invalid or in the future")
  }
  if (
    !durableProviderReference
    || durableProviderReference.length < 3
    || durableProviderReference.length > 512
    || /[\u0000-\u001F\u007F]/.test(durableProviderReference)
  ) {
    throw new Error("A provider message or request-scoped evidence reference is required to issue a Section 129 notice")
  }
  if (providerMessageId && providerEvidenceReference && (
    providerEvidenceReference.length < 3
    || providerEvidenceReference.length > 512
    || /[\u0000-\u001F\u007F]/.test(providerEvidenceReference)
  )) {
    throw new Error("The provider evidence reference is invalid")
  }
  if (args.providerPersistenceWarning && (
    args.providerPersistenceWarning.length > 2048
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(args.providerPersistenceWarning)
  )) {
    throw new Error("The provider persistence warning is invalid")
  }
  if (args.reconciliationReason) {
    const dispatchBoundary = Date.parse(
      args.reservation.recordData.dispatchStartedAt
        ?? args.reservation.recordData.reservedAt,
    )
    if (
      !Number.isFinite(dispatchBoundary)
      || issuedAt.getTime() < dispatchBoundary - 5 * 60 * 1000
    ) {
      throw new Error("The Section 129 issuance timestamp predates the reserved provider-dispatch window")
    }
  }
  await prisma.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, args.loanId)
    const loanBefore = await tx.loan.findUnique({
      where: { id: args.loanId, tenantId: args.tenantId },
      select: {
        collectionsStage: true,
        tenant: {
          select: {
            config: {
              select: {
                ...CHARGES_FLAG_INCLUDE.select.config.select,
                defaultAdminChargeCents: true,
                defaultAdminPostageCents: true,
              },
            },
          },
        },
      },
    })
    if (!loanBefore) {
      throw new Section129IssuanceConflictError(
        "The loan disappeared before the Section 129 issuance could be finalised.",
        args.reservation.issuanceId,
      )
    }
    // The charge is dated no earlier than it is recorded, nor than the latest
    // receipt already on the loan, so it can never re-split existing receipts.
    const latestReceipt = loanBefore.tenant?.config
      ? await tx.payment.findFirst({
          where: { tenantId: args.tenantId, loanId: args.loanId, reversed: false, allocationStatus: "ALLOCATED" },
          orderBy: { receivedAt: "desc" },
          select: { receivedAt: true },
        })
      : null
    const adminChargeAt = new Date(Math.max(
      issuedAt.getTime(), reconciledAt.getTime(), latestReceipt?.receivedAt.getTime() ?? 0,
    ))
    const updated = await complianceRecordDelegate(tx).updateMany({
      where: {
        id: args.reservation.issuanceId,
        idempotencyKey: args.reservation.idempotencyKey,
        status: "PENDING",
        data: {
          path: ["lifecycle"],
          equals: args.reconciliationReason ? "RECONCILIATION_REQUIRED" : "DISPATCHING",
        },
      },
      data: {
        status: "COMPLETED",
        completedAt: issuedAt,
        data: {
          ...args.reservation.recordData,
          lifecycle: finalLifecycle,
          issuedAt: issuedAt.toISOString(),
          // The default administration charge this notice carries, frozen at
          // issue so a later change to the tenant setting never reprices it.
          // A simulated notice was never sent, so it carries none.
          ...(loanBefore.tenant?.config && !simulated
            ? {
                adminChargeCents: loanBefore.tenant.config.defaultAdminChargeCents
                  + loanBefore.tenant.config.defaultAdminPostageCents,
                adminChargeAt: adminChargeAt.toISOString(),
              }
            : {}),
          emailMessageId: durableProviderReference,
          ...(providerMessageId ? { providerMessageId } : {}),
          ...(providerEvidenceReference ? { providerEvidenceReference } : {}),
          providerAcceptedAt: issuedAt.toISOString(),
          ...(simulated ? { simulated: true, delivery: "simulated (not sent)" } : {}),
          ...(args.providerPersistenceWarning
            ? { providerPersistenceWarning: args.providerPersistenceWarning }
            : {}),
          ...(args.emergencyEvidenceAuditPersisted !== undefined
            ? { emergencyEvidenceAuditPersisted: args.emergencyEvidenceAuditPersisted }
            : {}),
          ...(args.reconciliationReason
            ? {
                reconciledById: args.issuedById,
                reconciliationReason: args.reconciliationReason,
                reconciledAt: reconciledAt.toISOString(),
              }
            : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    })
    if (updated.count !== 1) {
      throw new Section129IssuanceConflictError(
        "The Section 129 issuance could not be finalised from its reserved state.",
        args.reservation.issuanceId,
      )
    }
    const shouldAdvanceCollectionsStage = !isCollectionsStageAtOrAfter(
      loanBefore.collectionsStage,
      "SECTION_129_SENT",
    )
    if (shouldAdvanceCollectionsStage) {
      await tx.loan.update({
        where: { id: args.loanId, tenantId: args.tenantId },
        data: { collectionsStage: "SECTION_129_SENT", collectionsStageUpdatedAt: issuedAt },
      })
    }
    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.issuedById,
      userEmail: args.issuedByEmail,
      action: simulated
        ? (args.reconciliationReason ? "SECTION_129_SIMULATION_RECONCILED" : "SECTION_129_SIMULATED")
        : (args.reconciliationReason ? "SECTION_129_ISSUANCE_RECONCILED" : "SECTION_129_ISSUED"),
      loanId: args.loanId,
      oldValue: {
        issuanceId: args.reservation.issuanceId,
        lifecycle: args.reconciliationReason ? "RECONCILIATION_REQUIRED" : "DISPATCHING",
      },
      newValue: {
        issuanceId: args.reservation.issuanceId,
        lifecycle: finalLifecycle,
        outcome: finalLifecycle,
        pdfSha256: args.reservation.pdfSha256,
        emailMessageId: durableProviderReference,
        providerMessageId,
        providerEvidenceReference,
        providerPersistenceWarning: args.providerPersistenceWarning,
        emergencyEvidenceAuditPersisted: args.emergencyEvidenceAuditPersisted,
        loanReference: args.reservation.recordData.loanReference,
        arrearsAmount: args.reservation.recordData.arrearsAmount,
        daysInArrears: args.reservation.recordData.daysInArrears,
        sentTo: args.reservation.recordData.clientEmail,
        ...(simulated ? { simulated: true, delivery: "simulated (not sent)" } : {}),
        reconciliationReason: args.reconciliationReason,
        issuedAt: issuedAt.toISOString(),
        ...(args.reconciliationReason ? { reconciledAt: reconciledAt.toISOString() } : {}),
      },
    })
    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.issuedById,
      userEmail: args.issuedByEmail,
      action: shouldAdvanceCollectionsStage
        ? "COLLECTIONS_STAGE_UPDATED"
        : "COLLECTIONS_STAGE_PRESERVED",
      loanId: args.loanId,
      oldValue: { stage: loanBefore.collectionsStage },
      newValue: {
        stage: shouldAdvanceCollectionsStage ? "SECTION_129_SENT" : loanBefore.collectionsStage,
        source: "section129_issuance",
        ...(shouldAdvanceCollectionsStage ? {} : { issuedNoticeRecordedWithoutStageRegression: true }),
      },
    })
    // The notice is now confirmed issued, which is what the default admin
    // charge is posted for. Same transaction, so an issued notice and its
    // charge can never be seen apart.
    if (chargesEnabled(loanBefore)) {
      // The notice was sent: its issuance is ALWAYS recorded. If the charges
      // replay refuses, that is audited and flagged on the record for staff,
      // never a PENDING/DISPATCHING record left behind.
      try {
        await syncLoanCharges(tx, { tenantId: args.tenantId, loanId: args.loanId }, reconciledAt, {
          source: "section129_issued",
          userId: args.issuedById,
          userEmail: args.issuedByEmail ?? null,
        })
      } catch (error) {
        if (!(error instanceof ChargesError)) throw error
        const record = await tx.complianceRecord.findUniqueOrThrow({
          where: { id: args.reservation.issuanceId }, select: { data: true },
        })
        await tx.complianceRecord.update({
          where: { id: args.reservation.issuanceId },
          data: { data: { ...(record.data as Prisma.JsonObject), chargesNotDerived: error.message } },
        })
        await createAtomicAudit(tx, {
          tenantId: args.tenantId,
          userId: args.issuedById,
          userEmail: args.issuedByEmail,
          action: "SECTION_129_CHARGES_NOT_DERIVED",
          loanId: args.loanId,
          newValue: { issuanceId: args.reservation.issuanceId, reason: error.message },
        })
      }
    }
  })
}

export async function getSection129ReservationAvailability(
  tenantId: string,
  loanId: string,
  now = new Date(),
): Promise<Section129ReservationAvailability> {
  const idempotencyKey = activeKey(tenantId, loanId)
  const cutoff = new Date(now.getTime() - SECTION129_RECENT_NOTICE_WINDOW_DAYS * 86400000)
  const [active, recent] = await Promise.all([
    complianceRecordDelegate(prisma).findUnique({ where: { idempotencyKey, tenantId } }),
    complianceRecordDelegate(prisma).findFirst({
      where: {
        tenantId,
        type: NOTICE_TYPE,
        referenceId: loanId,
        status: "COMPLETED",
        completedAt: { gte: cutoff },
      },
      orderBy: { completedAt: "desc" },
    }),
  ])
  const activeStillBlocks = Boolean(
    active
    && !(active.status === "COMPLETED" && active.completedAt && active.completedAt < cutoff),
  )
  const activeData = activeStillBlocks ? recordData(active?.data ?? null) : null
  const recentCompletedAt = recent?.completedAt ?? null

  return {
    canReserve: !activeStillBlocks && !recent,
    blockedBy: activeStillBlocks ? "ACTIVE_ISSUANCE" : recent ? "RECENT_NOTICE" : null,
    activeLifecycle: activeData?.lifecycle ?? null,
    cooldownEndsAt: recentCompletedAt
      ? new Date(recentCompletedAt.getTime() + SECTION129_RECENT_NOTICE_WINDOW_DAYS * 86400000)
      : null,
  }
}

export async function getSection129IssuanceAvailability(
  tenantId: string,
  loanId: string,
  now = new Date(),
): Promise<Section129IssuanceAvailability> {
  const [reservationAvailability, completed] = await Promise.all([
    getSection129ReservationAvailability(tenantId, loanId, now),
    complianceRecordDelegate(prisma).findMany({
      where: {
        tenantId,
        type: NOTICE_TYPE,
        referenceId: loanId,
        status: "COMPLETED",
        completedAt: { not: null },
      },
      orderBy: { completedAt: "desc" },
      select: { id: true, data: true, completedAt: true, status: true, idempotencyKey: true },
    }),
  ])
  const latestRetrievable = completed.find((row) => isRetrievableIssuedRecordData(recordData(row.data)))
  const latestRetrievableData = recordData(latestRetrievable?.data ?? null)
  let hasRetrievableIssuedArtifact = false
  if (latestRetrievable && isRetrievableIssuedRecordData(latestRetrievableData)) {
    try {
      const pdf = await readFile(latestRetrievableData.storagePath)
      hasRetrievableIssuedArtifact = section129PdfSha256(pdf) === latestRetrievableData.pdfSha256
    } catch {
      hasRetrievableIssuedArtifact = false
    }
  }
  return {
    ...reservationAvailability,
    hasRetrievableIssuedArtifact,
    latestIssuedSimulated: hasRetrievableIssuedArtifact && latestRetrievableData?.lifecycle === "SIMULATED",
  }
}

export async function loadIssuedSection129Artifact(args: {
  tenantId: string
  loanId: string
}): Promise<IssuedSection129Artifact> {
  const issuances = await complianceRecordDelegate(prisma).findMany({
    where: {
      tenantId: args.tenantId,
      type: NOTICE_TYPE,
      referenceId: args.loanId,
      status: "COMPLETED",
      completedAt: { not: null },
    },
    orderBy: { completedAt: "desc" },
    select: { id: true, data: true, completedAt: true, status: true, idempotencyKey: true },
  })
  const issuance = issuances.find((row) => isRetrievableIssuedRecordData(recordData(row.data)))
  const data = recordData(issuance?.data ?? null)
  if (!issuance || !isRetrievableIssuedRecordData(data)) {
    throw new Section129ArtifactUnavailableError(
      "No immutable issued Section 129 artifact is available. Issue the notice through the S.129 action; direct PDF generation is disabled.",
    )
  }

  const pdf = await readFile(data.storagePath)
  const actualHash = section129PdfSha256(pdf)
  if (actualHash !== data.pdfSha256) {
    throw new Section129ArtifactIntegrityError(issuance.id, data.pdfSha256, actualHash)
  }
  return {
    issuanceId: issuance.id,
    pdfSha256: actualHash,
    pdf,
    fileName: data.fileName,
  }
}
