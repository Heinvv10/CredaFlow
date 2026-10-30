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
import { recordInputStaffForClient } from "@/lib/applications/input-staff"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import {
  createApprovedApplication,
  disburse,
  rollback,
} from "@/lib/disbursement/approved-application.integration-fixture"

const suite = process.env.RUN_SEGREGATION_OF_DUTIES_IT === "1" ? describe : describe.skip

const APPROVER_DISBURSES = /Segregation of duties: the staff member who approved an application cannot disburse it/
const ENGINE_ATTESTER_DISBURSES = /Segregation of duties: the engine approved this application on the attestation of the staff member who would disburse it/
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

// A user cannot be turned into the system account (trigger User_guard_is_system), so a test that needs one
// switches the trigger off for the single statement that stands it up.
async function makeSystemUser(userId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "User" DISABLE TRIGGER "User_guard_is_system"`)
  try {
    await prisma.$executeRawUnsafe(`UPDATE "User" SET "active" = false, "password" = '!', "isSystem" = true WHERE "id" = '${userId}'`)
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "User" ENABLE TRIGGER "User_guard_is_system"`)
  }
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

    // The decision engine approved it (the approver is the lender's system user): the staff members whose attestations the
    // approval rested on take the approver's place (migration 20261029100000_maker_checker_decision_rules).
    it("an engine approval cannot be disbursed by the staff member whose attestation it rested on, whichever attestation", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      await makeSystemUser(scenario.officerId)
      for (const column of ["recklessLendingAssessedById", "incomeVerifiedById", "bureauOverrideById"]) {
        await prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "${column}" = '${scenario.colleagueId}' WHERE "id" = '${scenario.applicationId}'`)
        await expect(disburse(scenario, scenario.colleagueId), column).rejects.toThrow(ENGINE_ATTESTER_DISBURSES)
        await prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "${column}" = NULL WHERE "id" = '${scenario.applicationId}'`)
      }
      // Nobody attested through those columns: the colleague may disburse.
      await expect(disburse(scenario, scenario.colleagueId)).rejects.toBe(rollback)
    })

    it("the attester rule applies only to an engine approval, and only while the setting is on", async () => {
      const person = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      await prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "recklessLendingAssessedById" = '${person.colleagueId}' WHERE "id" = '${person.applicationId}'`)
      await expect(disburse(person, person.colleagueId)).rejects.toBe(rollback)
      const off = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: false })
      await makeSystemUser(off.officerId)
      await prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "recklessLendingAssessedById" = '${off.colleagueId}' WHERE "id" = '${off.applicationId}'`)
      await expect(disburse(off, off.colleagueId)).rejects.toBe(rollback)
    })

    it("an engine approval cannot be disbursed by any staff member who captured it or changed its inputs", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      await makeSystemUser(scenario.officerId)
      await prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "inputStaffIds" = ARRAY['someone-else', '${scenario.colleagueId}'] WHERE "id" = '${scenario.applicationId}'`)
      await expect(disburse(scenario, scenario.colleagueId)).rejects.toThrow(ENGINE_ATTESTER_DISBURSES)
    })

    it("the input staff of an application can be added to but never removed (it could otherwise be laundered before disbursing)", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      await prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "inputStaffIds" = ARRAY['a'] WHERE "id" = '${scenario.applicationId}'`)
      await prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "inputStaffIds" = ARRAY['a', 'b'] WHERE "id" = '${scenario.applicationId}'`)
      await expect(prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "inputStaffIds" = ARRAY['b'] WHERE "id" = '${scenario.applicationId}'`)).rejects.toThrow(/cannot be removed from it/)
      await expect(prisma.$executeRawUnsafe(`UPDATE "LoanApplication" SET "inputStaffIds" = ARRAY[]::TEXT[] WHERE "id" = '${scenario.applicationId}'`)).rejects.toThrow(/cannot be removed from it/)
    })

    it("a staff edit of the client does not touch an approved application (its inputs are decided), and the edit itself still succeeds", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      // Awaited inside the frame: a Prisma query is lazy and would otherwise run after it has closed.
      const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(scenario.tenantId, async () => await fn())
      const approved = await inTenant(() => prisma.loanApplication.findUniqueOrThrow({ where: { id: scenario.applicationId } }))
      await prisma.$executeRawUnsafe(`UPDATE "Client" SET "monthlyIncome" = "monthlyIncome" + 1 WHERE "id" = '${approved.clientId}'`)
      // (A second product: one open application per client and product.)
      const { id: _id, ...productFields } = await inTenant(() => prisma.loanProduct.findUniqueOrThrow({ where: { id: approved.productId } }))
      const other = await inTenant(() => prisma.loanProduct.create({ data: { ...productFields, code: `OPEN-${Date.now()}` } }))
      const open = await inTenant(() => prisma.loanApplication.create({ data: { tenantId: scenario.tenantId, reference: `APP-OPEN-${Date.now()}`, clientId: approved.clientId, productId: other.id, appliedAmount: 100_000, appliedTermDays: 30, status: "DRAFT" } }))
      await inTenant(() => prisma.$transaction((tx) => recordInputStaffForClient(tx, { tenantId: scenario.tenantId, clientId: approved.clientId!, userId: scenario.colleagueId })))
      expect((await inTenant(() => prisma.loanApplication.findUniqueOrThrow({ where: { id: scenario.applicationId } }))).inputStaffIds).toEqual([])
      expect((await inTenant(() => prisma.loanApplication.findUniqueOrThrow({ where: { id: open.id } }))).inputStaffIds).toEqual([scenario.colleagueId])
      // The approved, countersigned application can still be disbursed by that colleague.
      await expect(disburse(scenario, scenario.colleagueId)).rejects.toBe(rollback)
    })

    // The approval matrix (lib/approval/): a person who approved at ANY level of a multi-level chain cannot disburse it, not only the final approver.
    it("a staff member who approved at an earlier level cannot disburse the application (approval matrix)", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      const caseId = `case_${scenario.applicationId}`
      // The chain as it ended: level 1 by the colleague, level 2 by the officer (the approver on record). The step guard only runs on an open case.
      await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
        prisma.$executeRawUnsafe(`INSERT INTO "ApprovalCase" ("id","tenantId","applicationId","status","requiredLevels","levelsSnapshot","pendingLevel","completedAt") VALUES ('${caseId}','${scenario.tenantId}','${scenario.applicationId}','APPROVED',2,'[]'::jsonb,3,now())`),
        prisma.$executeRawUnsafe(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('${caseId}_1','${scenario.tenantId}','${caseId}','${scenario.applicationId}',1,'${scenario.colleagueId}','ROLE'), ('${caseId}_2','${scenario.tenantId}','${caseId}','${scenario.applicationId}',2,'${scenario.officerId}','ROLE')`),
      ])
      await expect(disburse(scenario, scenario.colleagueId)).rejects.toThrow(/approved at any level cannot disburse/)
      // Off with the setting: the same chain does not stop it.
      const off = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: false })
      await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
        prisma.$executeRawUnsafe(`INSERT INTO "ApprovalCase" ("id","tenantId","applicationId","status","requiredLevels","levelsSnapshot","pendingLevel","completedAt") VALUES ('c2_${off.applicationId}','${off.tenantId}','${off.applicationId}','APPROVED',1,'[]'::jsonb,2,now())`),
        prisma.$executeRawUnsafe(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('c2_${off.applicationId}_1','${off.tenantId}','c2_${off.applicationId}','${off.applicationId}',1,'${off.colleagueId}','ROLE')`),
      ])
      await expect(disburse(off, off.colleagueId)).rejects.toBe(rollback)
    })

    it("a user cannot be turned into (or out of) the system account", async () => {
      const scenario = await createApprovedApplication({ signing: "countersigned", requireSegregationOfDuties: true })
      await expect(prisma.$executeRawUnsafe(`UPDATE "User" SET "isSystem" = true WHERE "id" = '${scenario.colleagueId}'`)).rejects.toThrow(/isSystem cannot be changed/)
      await makeSystemUser(scenario.officerId)
      await expect(prisma.$executeRawUnsafe(`UPDATE "User" SET "isSystem" = false WHERE "id" = '${scenario.officerId}'`)).rejects.toThrow(/isSystem cannot be changed/)
      // An update that leaves the flag as it is is not touched.
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "name" = 'Renamed' WHERE "id" = '${scenario.colleagueId}'`)
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

