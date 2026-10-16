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
})
