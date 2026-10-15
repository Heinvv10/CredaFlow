import { describe, expect, it, vi } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { findStandingInPersonAttestation } from "@/lib/kyc/in-person-standing.server"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"

const subject = {
  id: "client-1",
  idNumber: "8905310001088",
  firstName: "Dineo",
  lastName: "Testperson",
  dateOfBirth: new Date("1989-05-31T00:00:00.000Z"),
}
const ID_SHA = "a".repeat(64)
const COMPLETED_AT = new Date("2026-10-14T10:00:00.000Z")
const at = (offsetMs: number) => new Date(COMPLETED_AT.getTime() + offsetMs)
const idDocument = { id: "doc-id-copy", contentSha256: ID_SHA }

const attestation = {
  id: "compliance-1",
  completedAt: COMPLETED_AT,
  data: {
    kind: IN_PERSON_KYC_VERIFICATION_KIND,
    version: IN_PERSON_KYC_VERIFICATION_VERSION,
    clientId: "client-1",
    idDocumentId: "doc-id-copy",
    idDocumentSha256: ID_SHA,
    subjectFingerprint: biometricSubjectFingerprint(subject),
    method: "IN_PERSON_BRANCH",
    note: "Client attended Hendrina branch; face matched the ID photo.",
    approvedAt: COMPLETED_AT.toISOString(),
    approvedById: "admin-1",
    approvedByEmail: "admin@acme-lending.example",
  },
}

type Attempt = { biometricResult: unknown; createdAt: Date; deletedAt: Date | null; extractionStatus: string | null }

function standing(args: {
  record?: typeof attestation | null
  attempts?: Attempt[]
  blockingCandidates?: Array<{ extractionStatus: string | null; biometricResult: unknown; createdAt: Date }>
}) {
  const complianceFindFirst = vi.fn(async () => args.record === undefined ? attestation : args.record)
  const documentFindMany = vi.fn(async () => args.attempts ?? [])
  const tx = {
    complianceRecord: { findFirst: complianceFindFirst },
    clientDocument: { findMany: documentFindMany },
  }
  return findStandingInPersonAttestation(tx as never, {
    tenantId: "tenant-1",
    clientId: "client-1",
    subject,
    idDocument,
    portraitRefusals: [],
    blockingCandidates: args.blockingCandidates ?? [],
    idDocumentCopies: [],
  })
}

// The routes answer 409 verification_exists exactly when this returns evidence.
describe("findStandingInPersonAttestation", () => {
  it("finds the attestation that stands, so a duplicate is refused", async () => {
    expect(await standing({})).toMatchObject({ idDocumentId: "doc-id-copy", approvedById: "admin-1" })
  })

  it("finds nothing when there is no attestation, so the first one is allowed", async () => {
    expect(await standing({ record: null })).toBeNull()
  })

  it("finds nothing once an adverse verdict recorded after it lapsed it, so a fresh one is allowed", async () => {
    const lapsed: Attempt = {
      biometricResult: { verdictRecordedAt: at(1_000).toISOString(), idDocumentId: "doc-id-copy", faceVerdict: { samePerson: "different" } },
      createdAt: at(500), deletedAt: null, extractionStatus: "failed",
    }
    expect(await standing({ attempts: [lapsed] })).toBeNull()
  })

  it("finds nothing once an attempt submitted after it was swept, or deleted while processing", async () => {
    const swept: Attempt = { biometricResult: { sweptAt: at(2_000).toISOString() }, createdAt: at(1_000), deletedAt: null, extractionStatus: "failed" }
    const deleted: Attempt = { biometricResult: null, createdAt: at(1_000), deletedAt: at(1_500), extractionStatus: "processing" }
    expect(await standing({ attempts: [swept] })).toBeNull()
    expect(await standing({ attempts: [deleted] })).toBeNull()
  })

  it("still finds it when the only recorded verdict was seen by staff or names another ID copy", async () => {
    const before: Attempt = {
      biometricResult: { verdictRecordedAt: at(-1_000).toISOString(), idDocumentId: "doc-id-copy", faceVerdict: { samePerson: "different" } },
      createdAt: at(-2_000), deletedAt: null, extractionStatus: "failed",
    }
    const other: Attempt = {
      biometricResult: { verdictRecordedAt: at(1_000).toISOString(), idDocumentId: "doc-older", faceVerdict: { samePerson: "different" } },
      createdAt: at(500), deletedAt: null, extractionStatus: "failed",
    }
    expect(await standing({ attempts: [before, other] })).not.toBeNull()
  })

  it("is judged against the attestation on file: a selfie still processing after it governs, so nothing stands", async () => {
    const processing = { extractionStatus: "processing", biometricResult: null, createdAt: at(1_000) }
    expect(await standing({ blockingCandidates: [processing] })).toBeNull()
  })

  it("reads the attestation and the attempts the same way for the whole client", async () => {
    const complianceFindFirst = vi.fn(async () => attestation)
    const documentFindMany = vi.fn(async () => [])
    await findStandingInPersonAttestation({ complianceRecord: { findFirst: complianceFindFirst }, clientDocument: { findMany: documentFindMany } } as never, {
      tenantId: "tenant-1", clientId: "client-1", subject, idDocument, portraitRefusals: [], blockingCandidates: [], idDocumentCopies: [],
    })
    expect(complianceFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-1", referenceId: "client-1", type: "KYC_EXCEPTION", status: "COMPLETED" }),
    }))
    expect(documentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-1", clientId: "client-1", docType: "SELFIE" }),
      select: expect.objectContaining({ deletedAt: true, extractionStatus: true, createdAt: true }),
    }))
  })
})
