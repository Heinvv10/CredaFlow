import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma, type UserRole } from "@prisma/client"
import { auth } from "@/lib/auth"
import { hasMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"
import { bureauStalenessCutoff } from "@/lib/compliance/bureau"
import {
  affordabilityContractCanBeDisbursed,
  affordabilityContractEvidenceIsIntact,
  affordabilityDecisionSnapshotIsIntact,
  readAffordabilitySnapshotStore,
  sha256Text,
} from "@/lib/affordability/snapshot"
import { southAfricanCalendarDate } from "@/lib/compliance/sa-business-days"
import {
  verifyCurrentAffordabilityApproval,
  verifyLockedCurrentAffordabilityApproval,
} from "@/lib/affordability/current-approval"
import { readFile } from "@/lib/storage"
import {
  documentBytesMatchSha256,
  isSha256Digest,
} from "@/lib/documents/content-integrity"
import { verifyStoredCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { verifyStoredPasqBinding } from "@/lib/compliance/pasq"
import { verifyPasqDocumentArtifact } from "@/lib/compliance/pasq-document.server"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

type RouteCtx = { params: Promise<{ id: string }> }

class AgreementSigningRaceError extends Error {
  constructor(readonly reason: string = "application_changed") {
    super("Agreement changed while it was being signed")
    this.name = "AgreementSigningRaceError"
  }
}

function isPngSignatureDataUrl(value: string): boolean {
  const prefix = "data:image/png;base64,"
  if (!value.startsWith(prefix)) return false
  const encoded = value.slice(prefix.length)
  if (encoded.length < 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return false
  }
  try {
    const bytes = Buffer.from(encoded, "base64")
    return bytes.length >= 75
      && bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
  } catch {
    return false
  }
}

/**
 * The instant to record — and to judge the schedule at — for this signature.
 *
 * `signedOn` is the SAST calendar date the consumer signed the paper, supplied
 * only when a returned packet is being recorded after the fact. Empty means the
 * signature is happening now, which is the in-branch and portal case.
 *
 * Returns null for anything unusable: a malformed date, a date that does not
 * exist, or a date in the future. A signature cannot be made after it is
 * recorded, and accepting one would let staff key a date the paper cannot
 * support.
 *
 * A past date resolves to the LAST instant of that SAST day rather than its
 * start. The schedule gate requires `establishedAt <= at`, and the agreement is
 * established partway through a day — anchoring to the start of the day would
 * put the signature before the document it signs.
 *
 * No upper bound on how far back is applied here on purpose: the schedule gate
 * already refuses anything outside the contract's established day and the
 * s92(3) quotation window, so a second rule here could only disagree with it.
 */
function resolveSignedAt(signedOn: string, now: Date): Date | null {
  if (!signedOn) return now
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) return null
  if (signedOn > southAfricanCalendarDate(now)) return null
  // SAST is UTC+2 with no daylight saving, so a SAST day ends at 21:59:59.999Z.
  const endOfSastDay = new Date(`${signedOn}T21:59:59.999Z`)
  if (!Number.isFinite(endOfSastDay.getTime())) return null
  // Rejects dates that parse but do not exist, e.g. 2026-02-30.
  if (southAfricanCalendarDate(endOfSastDay) !== signedOn) return null
  return endOfSastDay.getTime() > now.getTime() ? now : endOfSastDay
}

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return withTenantContext(req, async (tenant) => {
    if (!session.user.tenantId || session.user.tenantId !== tenant.id) {
      return NextResponse.json(
        { error: "The authenticated account is not assigned to this tenant." },
        { status: 403 },
      )
    }
    const { id } = await params

    const body = await req.json() as {
      method?: string
      signature?: string
      attestation?: boolean
      agreementDocumentSha256?: string
      pasqDocumentSha256?: string
      signedPacketDocumentId?: string
      signedPacketSha256?: string
      signedOn?: string
    }
    const method = body.method
    if (method !== "branch" && method !== "portal") {
      return NextResponse.json({ error: "method must be 'branch' or 'portal'" }, { status: 400 })
    }
    // The signature artifact the consumer actually drew (base64 PNG data URL)
    // or typed (their name). Persist it as evidence of the e-signature (ECTA).
    // A hostile oversized payload must fail closed rather than create a signed
    // row with no signature artefact.
    const MAX_SIGNATURE_LEN = 500_000
    if (typeof body.signature === "string" && body.signature.length > MAX_SIGNATURE_LEN) {
      return NextResponse.json({ error: "Signature artefact is too large" }, { status: 413 })
    }
    let signatureData = typeof body.signature === "string"
      ? body.signature.trim() || null
      : null
    const hasAnySignedPacketField =
      body.signedPacketDocumentId !== undefined
      || body.signedPacketSha256 !== undefined
    const hasCompleteSignedPacketFields =
      typeof body.signedPacketDocumentId === "string"
      && body.signedPacketDocumentId.trim().length > 0
      && isSha256Digest(body.signedPacketSha256)
    if (hasAnySignedPacketField && !hasCompleteSignedPacketFields) {
      return NextResponse.json(
        { error: "The returned signed-PDF binding is incomplete." },
        { status: 422 },
      )
    }
    // The date the consumer actually signed the paper, for a packet returned
    // after the fact. Only meaningful for a returned packet: an in-branch pad
    // signature and a portal signature happen while the request is being made,
    // so for those "now" IS the signature time and a supplied date could only
    // contradict it.
    const signedOn = typeof body.signedOn === "string" ? body.signedOn.trim() : ""
    if (signedOn && !hasCompleteSignedPacketFields) {
      return NextResponse.json(
        {
          error:
            "A signature date may only be given for a returned signed packet.",
        },
        { status: 422 },
      )
    }

    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        id: true,
        tenantId: true,
        status: true,
        updatedAt: true,
        clientId: true,
        agreementGeneratedAt: true,
        agreementDocumentId: true,
        agreementDocumentSha256: true,
        agreementSignedAt: true,
        repaymentMethod: true,
        agreementCountersignedAt: true,
        affordabilityResult: true,
        submittedAt: true,
        appliedAmount: true,
        appliedTermDays: true,
        approvedAmount: true,
        approvedTermDays: true,
        productId: true,
        initiationFeePayment: true,
        existingDebtObligations: true,
        bureauOverrideReason: true,
        bureauOverrideById: true,
        bureauOverrideAt: true,
        bureauReviewGeneration: true,
        creditLifeElection: true,
        creditLifeProductId: true,
        creditLifeProductName: true,
        creditLifeInsurerId: true,
        creditLifeInsurerName: true,
        creditLifeMonthlyPremiumCents: true,
        creditLifeDisclosureVersion: true,
        creditLifeDisclosureSha256: true,
        creditLifeDisclosureAcknowledgedAt: true,
        creditLifeDisclosureAcknowledgedBy: true,
        pasqVersion: true,
        pasqGeneratedAt: true,
        pasqDocumentId: true,
        pasqDocumentSha256: true,
        pasqEvidence: true,
        pasqEvidenceSha256: true,
        pasqAcknowledgedAt: true,
        pasqAcknowledgedBy: true,
        pasqAcknowledgedSha256: true,
        approvedPasqDocumentSha256: true,
        product: {
          select: {
            interestRatePm: true,
            interestModel: true,
            initiationFeeModel: true,
            initiationFeePct: true,
            initiationFeeMax: true,
            monthlyServiceFee: true,
        productType: true,
          },
        },
        client: {
          select: {
            id: true,
            idNumber: true,
            firstName: true,
            lastName: true,
            gender: true,
            dateOfBirth: true,
            grossMonthlyIncome: true,
            monthlyIncome: true,
            monthlyExpenses: true,
            expenseBreakdown: {
              select: {
                id: true,
                updatedAt: true,
                housing: true,
                transport: true,
                food: true,
                education: true,
                insurance: true,
                clothing: true,
                entertainment: true,
                medical: true,
                other: true,
                belowMleJustification: true,
              },
            },
            debtObligations: {
              select: {
                id: true,
                creditProvider: true,
                accountType: true,
                outstandingBalance: true,
                monthlyInstalment: true,
                notes: true,
              },
            },
          },
        },
      },
    })

    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // Signing a consumer credit agreement; an entity borrower is refused.
    if (!hasClientBorrower(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    if (application.status !== "APPROVED") {
      return NextResponse.json({ error: "Only an approved application can be signed" }, { status: 409 })
    }
    if (!application.agreementGeneratedAt) {
      return NextResponse.json({ error: "Agreement has not been generated yet" }, { status: 422 })
    }
    if (application.agreementSignedAt) {
      return NextResponse.json({ error: "Agreement is already signed" }, { status: 409 })
    }
    if (application.agreementCountersignedAt) {
      return NextResponse.json({ error: "Agreement countersign state is invalid" }, { status: 409 })
    }
    if (
      !application.agreementDocumentId ||
      !isSha256Digest(application.agreementDocumentSha256)
    ) {
      return NextResponse.json(
        {
          error: "The generated agreement is missing its document integrity binding. Return the application to review and generate a new agreement.",
          agreementIntegrity: "binding_missing",
        },
        { status: 422 },
      )
    }
    const agreementDocumentId = application.agreementDocumentId
    const agreementDocumentSha256 = application.agreementDocumentSha256

    // The signer must echo the digest of the document that was on their
    // screen. The unsigned agreement can be REGENERATED while a signing page
    // is open — without this binding a signature could be recorded over
    // bytes the signer never reviewed. Required: a client that cannot say
    // what it displayed may not sign.
    if (body.agreementDocumentSha256 !== agreementDocumentSha256) {
      return NextResponse.json(
        {
          error: "The agreement was replaced after this page loaded. Refresh, review the current document, and sign again.",
          agreementIntegrity: "document_changed",
        },
        { status: 409 },
      )
    }
    if (
      !isSha256Digest(application.pasqDocumentSha256)
      || body.pasqDocumentSha256 !== application.pasqDocumentSha256
    ) {
      return NextResponse.json(
        {
          error: "The PASQ was replaced after this signing packet loaded. Refresh, review both current documents, and sign again.",
          agreementIntegrity: "pasq_document_changed",
        },
        { status: 409 },
      )
    }
    const pasqWasAcknowledged = application.pasqAcknowledgedAt instanceof Date

    const isClientSession = (session.user.role as string) === "CLIENT"
    if (isClientSession && application.clientId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    if (isClientSession && method !== "portal") {
      return NextResponse.json({ error: "Clients may only use portal signing" }, { status: 403 })
    }
    if (!isClientSession && !hasMinRole(session.user.role, "CREDIT_OFFICER")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    if (!isClientSession && method !== "branch") {
      return NextResponse.json({ error: "Staff may only record branch signing" }, { status: 400 })
    }
    const recordsReturnedPacket =
      !isClientSession && method === "branch" && hasCompleteSignedPacketFields
    if (hasAnySignedPacketField && !recordsReturnedPacket) {
      return NextResponse.json(
        { error: "Only authorised staff may record a returned signed PDF." },
        { status: 403 },
      )
    }
    if (recordsReturnedPacket) {
      signatureData =
        `signed-packet-v1:${body.signedPacketDocumentId}:${body.signedPacketSha256}`
    }
    if (!signatureData) {
      return NextResponse.json({
        error: method === "portal"
          ? "A portal signature artefact is required"
          : "A branch signing record requires the consumer's typed or drawn signature artefact",
      }, { status: 422 })
    }
    if (
      method === "branch"
      && (
        (!recordsReturnedPacket && !isPngSignatureDataUrl(signatureData))
        || body.attestation !== true
      )
    ) {
      return NextResponse.json({
        error: "Branch signing requires the consumer's drawn signature and the witnessing staff attestation.",
      }, { status: 422 })
    }

    const [bureauCheck, tenantConfig] = await Promise.all([
      application.bureauReviewGeneration
        ? prisma.creditBureauCheck.findFirst({
            where: {
              tenantId: tenant.id,
              applicationId: id,
              clientId: application.clientId,
              reviewGeneration: application.bureauReviewGeneration,
              ok: true,
              createdAt: { gte: bureauStalenessCutoff() },
              provider: "experian",
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),
      prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: {
          ndiBufferPct: true,
          bureauMinScore: true,
          bureauBlockAdverse: true,
        },
      }),
    ])
    const currentApproval = verifyCurrentAffordabilityApproval({
      application,
      bureauCheck,
      tenantConfig,
      requirePasqAcknowledgement: false,
    })
    if (!currentApproval.ok) {
      return NextResponse.json(
        {
          error: "Current affordability, bureau, debt, or pricing evidence no longer matches the approval. Return the application to review before signing.",
          affordabilitySnapshot: currentApproval.reason,
        },
        { status: 409 },
      )
    }

    let signedPacketDocument: {
      id: string
      storagePath: string | null
      contentSha256: string | null
      validationResult: unknown
    } | null = null
    if (recordsReturnedPacket) {
      signedPacketDocument = await prisma.clientDocument.findFirst({
        where: {
          id: body.signedPacketDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "SIGNED_AGREEMENT_PACKET",
          deletedAt: null,
          contentSha256: body.signedPacketSha256,
          signatureState: "returned_pending_recording",
          storagePath: { not: null },
        },
        select: {
          id: true,
          storagePath: true,
          contentSha256: true,
          validationResult: true,
        },
      })
      const binding =
        signedPacketDocument?.validationResult
        && typeof signedPacketDocument.validationResult === "object"
        && !Array.isArray(signedPacketDocument.validationResult)
          ? signedPacketDocument.validationResult as Record<string, unknown>
          : null
      // A packet whose stamp names an EARLIER PASQ or agreement is the common
      // case, and it has a specific cause worth naming: regenerating either
      // document after the consumer signed mints a new digest, which orphans
      // the packet already returned. Without a specific message, correct
      // packets uploaded before a regeneration are refused by the bare message
      // below with nothing for staff to act on.
      const supersededDocuments =
        binding?.version === "signed-pasq-credit-agreement-v1"
        && binding.applicationId === id
        && (
          binding.pasqDocumentSha256 !== application.pasqDocumentSha256
          || binding.agreementDocumentSha256 !== agreementDocumentSha256
        )
      if (
        !signedPacketDocument?.storagePath
        || signedPacketDocument.contentSha256 !== body.signedPacketSha256
        || binding?.version !== "signed-pasq-credit-agreement-v1"
        || binding.applicationId !== id
        || binding.pasqDocumentId !== application.pasqDocumentId
        || binding.pasqDocumentSha256 !== application.pasqDocumentSha256
        || binding.agreementDocumentId !== agreementDocumentId
        || binding.agreementDocumentSha256 !== agreementDocumentSha256
      ) {
        return NextResponse.json(
          {
            error: supersededDocuments
              ? "This signed packet was returned against an earlier version of the PASQ or credit agreement — one of them has been regenerated since, which replaced the document the consumer signed. The signature cannot be recorded against the current documents. Re-issue the packet, have the consumer sign that copy, and upload it."
              : "The returned signed PDF is not bound to this exact PASQ and agreement.",
            ...(supersededDocuments ? { signedPacket: "superseded_documents" as const } : {}),
          },
          { status: 422 },
        )
      }
      try {
        const signedPacketBytes = await readFile(signedPacketDocument.storagePath)
        if (!documentBytesMatchSha256(
          signedPacketBytes,
          body.signedPacketSha256!,
        )) {
          throw new Error("digest_mismatch")
        }
      } catch {
        return NextResponse.json(
          { error: "The returned signed PDF failed its integrity check." },
          { status: 422 },
        )
      }
    }
    const creditLifeDisclosure = verifyStoredCreditLifeDisclosure(application, {
      principalCents: application.appliedAmount,
      termDays: application.appliedTermDays,
    })
    if (!creditLifeDisclosure.ok) {
      return NextResponse.json(
        {
          error: "The credit-life disclosure bound to the approved PASQ changed before signing.",
          affordabilitySnapshot: "pasq_changed",
        },
        { status: 409 },
      )
    }
    const pasqBinding = verifyStoredPasqBinding(application, {
      tenantId: application.tenantId,
      applicationId: application.id,
      clientId: application.clientId,
      productId: application.productId,
      calculatorPricingFingerprint: currentApproval.approval.calculator.pricingFingerprint,
      creditLifeDisclosureSha256: creditLifeDisclosure.evidence.disclosureSha256,
      requireAcknowledgement: false,
      requireApprovalBinding: false,
    })
    if (!pasqBinding.ok) {
      return NextResponse.json(
        {
          error: "The PASQ acknowledged by the client no longer matches the approved agreement.",
          affordabilitySnapshot: "pasq_changed",
          pasqEvidence: pasqBinding.reason,
        },
        { status: 409 },
      )
    }
    const pasqArtifact = await verifyPasqDocumentArtifact(prisma, {
      tenantId: tenant.id,
      clientId: application.clientId,
      documentId: pasqBinding.documentId,
      documentSha256: pasqBinding.documentSha256,
    })
    if (!pasqArtifact.ok) {
      return NextResponse.json(
        {
          error: "The approved PASQ bytes failed verification and the agreement cannot be signed.",
          affordabilitySnapshot: "pasq_changed",
          pasqDocument: pasqArtifact.reason,
        },
        { status: 422 },
      )
    }

    const affordabilityStore = readAffordabilitySnapshotStore(application.affordabilityResult)
    const approval = currentApproval.approval
    const contract = affordabilityStore.contract
    if (
      !approval ||
      !affordabilityDecisionSnapshotIsIntact(approval) ||
      !contract ||
      !affordabilityContractEvidenceIsIntact(contract, approval) ||
      !(application.pasqGeneratedAt instanceof Date) ||
      contract.establishedAt !== application.agreementGeneratedAt.toISOString() ||
      application.agreementGeneratedAt < application.pasqGeneratedAt
    ) {
      return NextResponse.json(
        { error: "The current agreement is not bound to valid approval and contract evidence" },
        { status: 409 },
      )
    }
    // One signature instant for the whole request. The gate below and the
    // agreementSignedAt stamp written at the end of the transaction must be the
    // same fact: evaluating the schedule against one clock reading and then
    // recording the signature against a later one lets a request that straddles
    // midnight SAST pass a gate for the established day and then stamp the
    // signature into the next -- precisely the mismatch this route exists to
    // prevent.
    const now = new Date()
    const signedAt = resolveSignedAt(signedOn, now)
    if (signedAt === null) {
      return NextResponse.json(
        {
          error:
            "The signature date must be a real calendar date, and cannot be in the future.",
        },
        { status: 422 },
      )
    }
    // Scoped to how the loan will be collected: a DEBIT_ORDER mandate is
    // signed before payout on fixed dates, so it keeps the same-day rule. Null
    // takes the strict path.
    if (!affordabilityContractCanBeDisbursed(contract, signedAt, application.repaymentMethod)) {
      return NextResponse.json(
        {
          error: "The agreement schedule is no longer current. Ask staff to regenerate the unsigned agreement before signing.",
        },
        { status: 409 },
      )
    }

    const agreementDocument = await prisma.clientDocument.findFirst({
      where: {
        id: agreementDocumentId,
        tenantId: tenant.id,
        clientId: application.clientId,
        docType: "CREDIT_AGREEMENT",
        fileName: `credit-agreement-${id}.pdf`,
        deletedAt: null,
        storagePath: { not: null },
      },
      select: { id: true, storagePath: true, contentSha256: true },
    })
    if (!agreementDocument?.storagePath) {
      return NextResponse.json(
        {
          error: "The application-bound agreement document is missing and cannot be signed.",
          agreementIntegrity: "document_missing",
        },
        { status: 422 },
      )
    }
    if (agreementDocument.contentSha256 !== agreementDocumentSha256) {
      return NextResponse.json(
        {
          error: "The agreement document metadata no longer matches the generated legal artifact.",
          agreementIntegrity: "metadata_mismatch",
        },
        { status: 422 },
      )
    }
    try {
      const agreementBytes = await readFile(agreementDocument.storagePath)
      if (!documentBytesMatchSha256(agreementBytes, agreementDocumentSha256)) {
        return NextResponse.json(
          {
            error: "The agreement bytes failed their integrity check and cannot be signed.",
            agreementIntegrity: "content_mismatch",
          },
          { status: 422 },
        )
      }
    } catch {
      return NextResponse.json(
        {
          error: "The bound agreement bytes are unavailable and cannot be signed.",
          agreementIntegrity: "bytes_missing",
        },
        { status: 422 },
      )
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? req.headers.get("x-real-ip")
      ?? null

    try {
      const updated = await prisma.$transaction(async (tx) => {
        let branchWitness: {
          id: string
          email: string
          name: string | null
          role: UserRole
        } | null = null
        if (!isClientSession) {
          const witnessRows = await tx.$queryRaw<Array<{
            id: string
            email: string
            name: string | null
            role: UserRole
          }>>(Prisma.sql`
            SELECT
              "id",
              "email",
              "name",
              "role"::TEXT AS "role"
            FROM "User"
            WHERE "id" = ${session.user.id}
              AND "tenantId" = ${tenant.id}
              AND "active" = TRUE
            FOR SHARE
          `)
          const witness = witnessRows[0]
          if (
            witnessRows.length !== 1
            || witness.id !== session.user.id
            || witness.email !== session.user.email
            || witness.role !== session.user.role
            || !hasMinRole(witness.role, "CREDIT_OFFICER")
          ) {
            throw new AgreementSigningRaceError("branch_witness_tenant_changed")
          }
          branchWitness = witness
        }
        const locked = await verifyLockedCurrentAffordabilityApproval(tx, {
          tenantId: tenant.id,
          applicationId: id,
          requirePasqAcknowledgement: false,
        })
        if (!locked.ok) {
          throw new AgreementSigningRaceError(locked.reason)
        }
        const lockedPasqArtifact = await verifyPasqDocumentArtifact(tx, {
          tenantId: tenant.id,
          clientId: locked.application.clientId,
          documentId: pasqBinding.documentId,
          documentSha256: pasqBinding.documentSha256,
          lock: true,
        })
        if (!lockedPasqArtifact.ok) {
          throw new AgreementSigningRaceError("pasq_document_changed")
        }
        if (locked.application.updatedAt.toISOString() !== application.updatedAt.toISOString()) {
          throw new AgreementSigningRaceError("application_changed")
        }
        if (
          locked.application.agreementDocumentId !== agreementDocumentId ||
          locked.application.agreementDocumentSha256 !== agreementDocumentSha256 ||
          locked.application.agreementCountersignedAt !== null
        ) {
          throw new AgreementSigningRaceError("agreement_document_changed")
        }
        const lockedStore = readAffordabilitySnapshotStore(
          locked.application.affordabilityResult,
        )
        const lockedContract = lockedStore.contract
        if (
          !lockedContract ||
          !affordabilityContractEvidenceIsIntact(lockedContract, locked.approval) ||
          !locked.application.agreementGeneratedAt ||
          !(locked.application.pasqGeneratedAt instanceof Date) ||
          lockedContract.establishedAt !== locked.application.agreementGeneratedAt.toISOString() ||
          locked.application.agreementGeneratedAt < locked.application.pasqGeneratedAt ||
          !affordabilityContractCanBeDisbursed(
            lockedContract, signedAt, locked.application.repaymentMethod,
          )
        ) {
          throw new AgreementSigningRaceError("contract_changed")
        }
        const lockedAgreementDocument = await tx.clientDocument.findFirst({
          where: {
            id: agreementDocumentId,
            tenantId: tenant.id,
            clientId: application.clientId,
            docType: "CREDIT_AGREEMENT",
            fileName: `credit-agreement-${id}.pdf`,
            deletedAt: null,
            storagePath: { not: null },
            contentSha256: agreementDocumentSha256,
          },
          select: { id: true, storagePath: true, contentSha256: true },
        })
        if (!lockedAgreementDocument?.storagePath) {
          throw new AgreementSigningRaceError("agreement_document_changed")
        }
        let lockedAgreementBytes: Buffer
        try {
          lockedAgreementBytes = await readFile(lockedAgreementDocument.storagePath)
        } catch {
          throw new AgreementSigningRaceError("agreement_document_bytes")
        }
        if (!documentBytesMatchSha256(
          lockedAgreementBytes,
          agreementDocumentSha256,
        )) {
          throw new AgreementSigningRaceError("agreement_document_bytes")
        }
        if (recordsReturnedPacket) {
          const lockedSignedPacket = await tx.clientDocument.findFirst({
            where: {
              id: signedPacketDocument!.id,
              tenantId: tenant.id,
              clientId: application.clientId,
              // Was "OTHER" until a data migration (now squashed into the baseline)
              // re-typed the returned packets already on disk. Both this lock
              // and the pre-transaction read below must name the SAME type as
              // the upload route writes, or every recording fails closed with
              // signed_packet_changed.
              docType: "SIGNED_AGREEMENT_PACKET",
              deletedAt: null,
              contentSha256: body.signedPacketSha256,
              signatureState: "returned_pending_recording",
              storagePath: { not: null },
            },
            select: { id: true, storagePath: true, contentSha256: true },
          })
          if (!lockedSignedPacket?.storagePath) {
            throw new AgreementSigningRaceError("signed_packet_changed")
          }
          try {
            const lockedSignedPacketBytes = await readFile(lockedSignedPacket.storagePath)
            if (!documentBytesMatchSha256(
              lockedSignedPacketBytes,
              body.signedPacketSha256!,
            )) {
              throw new Error("digest_mismatch")
            }
          } catch {
            throw new AgreementSigningRaceError("signed_packet_changed")
          }
        }
        const applicationChanged = await tx.loanApplication.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            status: "APPROVED",
            updatedAt: locked.application.updatedAt,
            agreementGeneratedAt: locked.application.agreementGeneratedAt,
            agreementDocumentId,
            agreementDocumentSha256,
            agreementSignedAt: null,
            agreementCountersignedAt: null,
            pasqDocumentId: pasqBinding.documentId,
            pasqDocumentSha256: pasqBinding.documentSha256,
            ...(pasqWasAcknowledged
              ? {
                  pasqAcknowledgedAt: application.pasqAcknowledgedAt,
                  pasqAcknowledgedBy: application.clientId,
                  pasqAcknowledgedSha256: pasqBinding.documentSha256,
                  approvedPasqDocumentSha256: pasqBinding.documentSha256,
                }
              : {
                  pasqAcknowledgedAt: null,
                  pasqAcknowledgedBy: null,
                  pasqAcknowledgedSha256: null,
                  approvedPasqDocumentSha256: null,
                }),
          },
          data: {
            ...(!pasqWasAcknowledged
              ? {
                  pasqAcknowledgedAt: signedAt,
                  pasqAcknowledgedBy: application.clientId,
                  pasqAcknowledgedSha256: pasqBinding.documentSha256,
                  approvedPasqDocumentSha256: pasqBinding.documentSha256,
                }
              : {}),
            agreementSignedAt: signedAt,
            agreementSignedMethod: method,
            agreementSignedByIp: ip,
            agreementSignedByUserId: branchWitness?.id ?? null,
            agreementSignatureData: signatureData,
            // Claim the binding for the packet actually being RECORDED, and
            // release it when this signature records no packet at all.
            //
            // The upload route sets signedPacketDocumentId and is free to
            // re-point it while agreementSignedAt is NULL, because re-uploading
            // a corrected scan is legitimate. Recording is where that stops
            // being true: from here the binding is the record of WHICH bytes
            // carry the signature.
            //
            // Without both branches the pointer outlives the truth:
            //   - two uploads then a record of the FIRST leaves the pointer on
            //     the second, unrecorded packet;
            //   - an upload followed by an IN-APP signature (no race needed at
            //     all) leaves the pointer on a packet nobody ever recorded.
            // Either way the documents folder would offer an unsigned PDF
            // captioned as the copy the consumer signed.
            signedPacketDocumentId: recordsReturnedPacket
              ? signedPacketDocument!.id
              : null,
            signedPacketDocumentSha256: recordsReturnedPacket
              ? body.signedPacketSha256!
              : null,
          },
        })
        if (applicationChanged.count !== 1) {
          throw new AgreementSigningRaceError("application_changed")
        }

        if (!pasqWasAcknowledged) {
          const pasqDocumentChanged = await tx.clientDocument.updateMany({
            where: {
              id: pasqBinding.documentId,
              tenantId: tenant.id,
              clientId: application.clientId,
              docType: "FORM_20_PRE_AGREEMENT",
              deletedAt: null,
              contentSha256: pasqBinding.documentSha256,
            },
            data: { signatureState: "acknowledged" },
          })
          if (pasqDocumentChanged.count !== 1) {
            throw new AgreementSigningRaceError("pasq_document_changed")
          }
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: branchWitness?.id ?? null,
              userEmail: branchWitness?.email ?? session.user.email,
              action: AuditAction.PASQ_ACKNOWLEDGED,
              entity: "LoanApplication",
              entityId: id,
              newValue: {
                signingCeremony: "pasq_and_credit_agreement",
                method,
                documentId: pasqBinding.documentId,
                documentSha256: pasqBinding.documentSha256,
                generatedAt: application.pasqGeneratedAt!.toISOString(),
                acknowledgedAt: signedAt.toISOString(),
                agreementDocumentId,
                agreementDocumentSha256,
                ...(method === "branch"
                  ? {
                      branchWitnessAttested: true,
                      branchWitnessId: branchWitness!.id,
                    }
                  : {}),
              },
              ipAddress: ip,
            },
          })
        }

        const documentChanged = await tx.clientDocument.updateMany({
          where: {
            id: agreementDocument.id,
            tenantId: tenant.id,
            clientId: application.clientId,
            deletedAt: null,
            contentSha256: agreementDocumentSha256,
            verified: false,
          },
          data: {
            verified: true,
            verifiedAt: signedAt,
            verifiedById: branchWitness?.id ?? null,
            signatureState: "signed",
            signedAt,
          },
        })
        if (documentChanged.count !== 1) {
          throw new AgreementSigningRaceError("agreement_document_changed")
        }

        if (recordsReturnedPacket) {
          const signedPacketChanged = await tx.clientDocument.updateMany({
            where: {
              id: signedPacketDocument!.id,
              tenantId: tenant.id,
              clientId: application.clientId,
              deletedAt: null,
              contentSha256: body.signedPacketSha256,
              signatureState: "returned_pending_recording",
              verified: false,
            },
            data: {
              verified: true,
              verifiedAt: signedAt,
              verifiedById: branchWitness!.id,
              signatureState: "signed_returned_packet",
              signedAt,
            },
          })
          if (signedPacketChanged.count !== 1) {
            throw new AgreementSigningRaceError("signed_packet_changed")
          }
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: branchWitness!.id,
              userEmail: branchWitness!.email,
              action: AuditAction.SIGNED_PACKET_RECORDED,
              entity: "LoanApplication",
              entityId: id,
              newValue: {
                signedPacketDocumentId: signedPacketDocument!.id,
                signedPacketSha256: body.signedPacketSha256,
                pasqDocumentId: pasqBinding.documentId,
                pasqDocumentSha256: pasqBinding.documentSha256,
                agreementDocumentId,
                agreementDocumentSha256,
                signedAt: signedAt.toISOString(),
                staffAttested: true,
              },
              ipAddress: ip,
            },
          })
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: branchWitness?.id ?? null,
            userEmail: branchWitness?.email ?? session.user.email,
            action: AuditAction.AGREEMENT_SIGNED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              method,
              signedAt: signedAt.toISOString(),
              documentId: agreementDocument.id,
              documentSha256: agreementDocumentSha256,
              contractFingerprint: lockedContract.fingerprint,
              pasqVersion: pasqBinding.evidence.version,
              pasqDocumentId: pasqBinding.documentId,
              pasqDocumentSha256: pasqBinding.documentSha256,
              pasqEvidenceSha256: pasqBinding.evidence.evidenceSha256,
              signatureSha256: signatureData ? sha256Text(signatureData) : null,
              ...(recordsReturnedPacket
                ? {
                    signingChannel: "returned_pdf",
                    signedPacketDocumentId: signedPacketDocument!.id,
                    signedPacketSha256: body.signedPacketSha256,
                  }
                : {}),
              ...(method === "branch"
                ? {
                    branchWitnessAttested: true,
                    branchWitnessId: branchWitness!.id,
                    branchWitnessName:
                      branchWitness!.name?.trim() || branchWitness!.email,
                    branchWitnessEmail: branchWitness!.email,
                  }
                : {}),
            },
            ipAddress: ip,
          },
        })

        return tx.loanApplication.findUnique({ where: { id, tenantId: tenant.id } })
      })
      return NextResponse.json(updated)
    } catch (error) {
      if (error instanceof AgreementSigningRaceError) {
        if (error.reason === "kyc_changed") {
          return NextResponse.json(
            {
              error: "The client's KYC evidence no longer meets the identity bar for signing.",
              affordabilitySnapshot: "kyc_changed",
              remediation: "Capture a selfie or record an in-person verification on the client's KYC tab. If a verified document itself changed, return the application to review and re-verify, then generate a new agreement before signing.",
            },
            { status: 422 },
          )
        }
        if (
          error.reason === "agreement_document_changed" ||
          error.reason === "agreement_document_bytes" ||
          error.reason === "pasq_document_changed" ||
          error.reason === "signed_packet_changed"
        ) {
          return NextResponse.json(
            {
              error: "The bound agreement document changed or failed its integrity check; it was not signed.",
              agreementIntegrity: error.reason,
              remediation: "Return the application to review, generate a new agreement, and obtain a new signature.",
            },
            { status: 422 },
          )
        }
        return NextResponse.json(
          {
            error: "The agreement changed while it was being signed; refresh and try again.",
            affordabilitySnapshot: error.reason,
          },
          { status: 409 },
        )
      }
      throw error
    }
  })
}
