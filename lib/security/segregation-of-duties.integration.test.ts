/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_SEGREGATION_OF_DUTIES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/security/segregation-of-duties.integration.test.ts
 *
 * The database half of TenantConfig.requireSegregationOfDuties (migration
 * 20261016200100): on (and with no config row), the approver cannot disburse
 * and the witness of an in-branch signature cannot countersign; off, one
 * person may do both. The asset-finance payout pair is proved in
 * lib/asset-finance/payout-booking.integration.test.ts, the setting's route in
 * app/api/settings/segregation-of-duties/route.integration.test.ts.
 */
import { describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  createApprovedApplication,
  disburse,
  rollback,
} from "@/lib/disbursement/approved-application.integration-fixture"

const suite = process.env.RUN_SEGREGATION_OF_DUTIES_IT === "1" ? describe : describe.skip

const APPROVER_DISBURSES = /Segregation of duties: the staff member who approved an application cannot disburse it/
const WITNESS_COUNTERSIGNS = /Segregation of duties: the staff witness of the in-branch signature cannot countersign/
const COUNTERSIGNED_AT = new Date("2026-07-24T08:12:00.000Z")
const SIGNATURE_CLEARED = {
  agreementSignedAt: null, agreementSignedMethod: null, agreementSignedByUserId: null,
  agreementSignedByIp: null, agreementSignatureData: null,
}
// The columns the decide route's return_to_review clears in its one write.
const RETURN_TO_REVIEW = {
  ...SIGNATURE_CLEARED,
  status: "UNDER_REVIEW", repaymentMethod: null, approvedById: null, approvedAt: null, approvedAmount: null,
  approvedTermDays: null, approvedRate: null, decisionReason: null, bureauOverrideReason: null,
  bureauOverrideById: null, bureauOverrideAt: null, bureauReviewGeneration: "sod-it-return-to-review",
  recklessLendingAssessed: false, recklessLendingAssessedById: null, recklessLendingAssessedAt: null,
  pasqAcknowledgedAt: null, pasqAcknowledgedBy: null, pasqAcknowledgedSha256: null, pasqVersion: null,
  pasqGeneratedAt: null, pasqDocumentId: null, pasqDocumentSha256: null, pasqEvidence: Prisma.DbNull,
  pasqEvidenceSha256: null, approvedPasqDocumentSha256: null, clientAffordabilityDeclaredAt: null,
  agreementGeneratedAt: null, agreementDocumentId: null, agreementDocumentSha256: null,
  agreementCountersignedAt: null, agreementCountersignedById: null, agreementCountersignedByName: null,
  agreementCountersignedByEmail: null, agreementCountersignatureData: null, agreementCountersignatureSha256: null,
  agreementCountersignatureEnvelopeSha256: null, agreementCountersignedDocumentSha256: null,
  agreementExecutedDocumentId: null, agreementExecutedDocumentSha256: null, signedPacketDocumentId: null,
  signedPacketDocumentSha256: null, debitMandatePreparedAt: null, debitMandateReference: null,
  debitMandateDraftSha256: null, debitMandateEvidence: Prisma.DbNull, debitMandateEvidenceSha256: null,
  debitMandateSignedAt: null, debitMandateSignedMethod: null, debitMandateSignedByIp: null,
  debitMandateSignatureData: null, debitMandateSignatureSha256: null, debitMandateDocumentId: null,
  debitMandateDocumentSha256: null,
}

function countersign(
  scenario: Awaited<ReturnType<typeof createApprovedApplication>>,
  by: "officer" | "colleague",
) {
  return prisma.loanApplication.update({
    where: { id: scenario.applicationId, tenantId: scenario.tenantId },
    data: scenario.countersignBy(by, COUNTERSIGNED_AT),
    select: { agreementCountersignedById: true },
  })
}

suite("segregation of duties in the database", () => {
  describe("approve / disburse", () => {
    it.each([
      ["on", true],
      ["unset (no config row: on)", undefined],
    ] as const)("refuses the approver as disburser when the setting is %s", async (_label, setting) => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: setting })
      await expect(disburse(scenario, scenario.officerId)).rejects.toThrow(APPROVER_DISBURSES)
      await expect(disburse(scenario, null)).rejects.toThrow(/a disbursement must record the staff member who made it/)
      await expect(disburse(scenario, scenario.colleagueId)).rejects.toBe(rollback)
    })

    it("lets the approver disburse when the setting is off", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: false })
      await expect(disburse(scenario, scenario.officerId)).rejects.toBe(rollback)
    })

    it("records the disburser only with the DISBURSED transition", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: false })
      await expect(prisma.loanApplication.update({
        where: { id: scenario.applicationId, tenantId: scenario.tenantId },
        data: { disbursedById: scenario.colleagueId },
      })).rejects.toThrow(/recorded only with the DISBURSED transition/)
    })
  })

  describe("in-branch signature / provider countersignature", () => {
    it("refuses the witness as countersigner when the setting is on; a colleague may", async () => {
      const scenario = await createApprovedApplication({
        signing: "consumer_only", consumerSignedBy: { branchWitness: "officer" }, requireSegregationOfDuties: true,
      })
      await expect(countersign(scenario, "officer")).rejects.toThrow(WITNESS_COUNTERSIGNS)
      expect(await countersign(scenario, "colleague")).toEqual({ agreementCountersignedById: scenario.colleagueId })
    })

    it("refuses it with no config row", async () => {
      const scenario = await createApprovedApplication({
        signing: "consumer_only", consumerSignedBy: { branchWitness: "colleague" },
      })
      await expect(countersign(scenario, "colleague")).rejects.toThrow(WITNESS_COUNTERSIGNS)
    })

    it("lets the witness countersign when the setting is off", async () => {
      const scenario = await createApprovedApplication({
        signing: "consumer_only", consumerSignedBy: { branchWitness: "officer" }, requireSegregationOfDuties: false,
      })
      expect(await countersign(scenario, "officer")).toEqual({ agreementCountersignedById: scenario.officerId })
    })

    it("does not apply to a portal signature", async () => {
      const scenario = await createApprovedApplication({ signing: "consumer_only", requireSegregationOfDuties: true })
      expect(await countersign(scenario, "officer")).toEqual({ agreementCountersignedById: scenario.officerId })
    })
  })

  describe("on insert", () => {
    it("refuses a consumer application inserted countersigned by its own branch witness while the setting is on", async () => {
      await expect(createApprovedApplication({
        signing: "countersigned", consumerSignedBy: { branchWitness: "officer" }, countersignedBy: "officer", requireSegregationOfDuties: true,
      })).rejects.toThrow(WITNESS_COUNTERSIGNS)
    })

    it("admits the same insert while the setting is off", async () => {
      const scenario = await createApprovedApplication({
        signing: "countersigned", consumerSignedBy: { branchWitness: "officer" }, countersignedBy: "officer", requireSegregationOfDuties: false,
      })
      expect(scenario.applicationId).toBeTruthy()
    })

    it("refuses a consumer application inserted already DISBURSED while the setting is on", async () => {
      await expect(createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true, insertDisbursed: {} }))
        .rejects.toThrow(/Segregation of duties: a disbursement must record the staff member who made it/)
    })

    it("never takes disbursedById on insert, whatever the setting", async () => {
      await expect(createApprovedApplication({
        signing: "countersigned", requireSegregationOfDuties: false, insertDisbursed: { disbursedBy: "colleague" },
      })).rejects.toThrow(/recorded only with the DISBURSED transition/)
    })
  })

  describe("the recorded disburser", () => {
    it("refuses an id that names no user, or another tenant's user (FK)", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      const other = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      await expect(disburse(scenario, "user-that-does-not-exist")).rejects.toThrow(/Foreign key constraint|disbursedById_fkey|active staff member/)
      await expect(disburse(scenario, other.colleagueId)).rejects.toThrow(/Foreign key constraint|disbursedById_fkey|active staff member/)
    })

    it("refuses an inactive staff member, or one whose role may not disburse", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: false })
      await prisma.user.update({ where: { id: scenario.colleagueId }, data: { active: false } })
      await expect(disburse(scenario, scenario.colleagueId)).rejects.toThrow(/active staff member of the application tenant who may disburse/)
      await prisma.user.update({ where: { id: scenario.colleagueId }, data: { active: true, role: "CREDIT_OFFICER" } })
      await expect(disburse(scenario, scenario.colleagueId)).rejects.toThrow(/active staff member of the application tenant who may disburse/)
    })
  })

  // Breaker review of #140: the witness could be rewritten after the signature
  // and before the countersignature, so the witness countersigned unchallenged.
  describe("a recorded consumer signature", () => {
    const FROZEN = /A recorded consumer signature is immutable/
    const update = (scenario: { tenantId: string; applicationId: string }, data: Record<string, unknown>) =>
      prisma.loanApplication.update({ where: { id: scenario.applicationId, tenantId: scenario.tenantId }, data, select: { id: true } })

    it("refuses a rewrite of its witness, method or artefact", async () => {
      const scenario = await createApprovedApplication({
        signing: "consumer_only", consumerSignedBy: { branchWitness: "officer" }, requireSegregationOfDuties: true,
      })
      await expect(update(scenario, { agreementSignedByUserId: scenario.colleagueId })).rejects.toThrow(FROZEN)
      await expect(update(scenario, { agreementSignedMethod: "portal", agreementSignedByUserId: null })).rejects.toThrow(FROZEN)
      await expect(update(scenario, { agreementSignatureData: "data:image/png;base64,b3RoZXI=" })).rejects.toThrow(FROZEN)
      await expect(update(scenario, { agreementSignedByIp: "198.51.100.9" })).rejects.toThrow(FROZEN)
      // ...so the witness still cannot countersign.
      await expect(countersign(scenario, "officer")).rejects.toThrow(WITNESS_COUNTERSIGNS)
    })

    it("refuses a bare clear while approved, so a colleague cannot be swapped in as witness", async () => {
      const scenario = await createApprovedApplication({
        signing: "consumer_only", consumerSignedBy: { branchWitness: "officer" }, requireSegregationOfDuties: true,
      })
      await expect(update(scenario, SIGNATURE_CLEARED)).rejects.toThrow(FROZEN)
      await expect(update(scenario, { ...SIGNATURE_CLEARED, status: "DECLINED" })).rejects.toThrow(FROZEN)
      // The witness is still the officer, so the officer still cannot countersign.
      await expect(countersign(scenario, "officer")).rejects.toThrow(WITNESS_COUNTERSIGNS)
    })

    it("may be cleared as a whole by the write that returns the application to review", async () => {
      const scenario = await createApprovedApplication({
        signing: "consumer_only", consumerSignedBy: { branchWitness: "officer" }, requireSegregationOfDuties: true,
      })
      await expect(update(scenario, RETURN_TO_REVIEW)).resolves.toEqual({ id: scenario.applicationId })
      expect(await prisma.loanApplication.findUniqueOrThrow({
        where: { id: scenario.applicationId, tenantId: scenario.tenantId },
        select: { status: true, agreementSignedAt: true, agreementSignedByUserId: true },
      })).toEqual({ status: "UNDER_REVIEW", agreementSignedAt: null, agreementSignedByUserId: null })
    })
  })
})

