/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_DISBURSEMENT_SIGNATURE_GUARD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/disbursement/disbursement-signature-guard.integration.test.ts
 *
 * The outage disbursement exception was the one path that let an application
 * reach DISBURSED without signed agreement evidence. It is gone; this proves
 * the database still refuses the transition for an unsigned agreement.
 */
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import {
  createApprovedApplication,
  disburse,
  rollback,
  type Signing,
} from "@/lib/disbursement/approved-application.integration-fixture"

const suite = process.env.RUN_DISBURSEMENT_SIGNATURE_GUARD_IT === "1"
  ? describe
  : describe.skip

/** Disbursed by a second staff member, so segregation of duties is not what refuses. */
async function disburseByColleague(signing: Signing) {
  const scenario = await createApprovedApplication({ signing })
  return disburse(scenario, scenario.colleagueId)
}

suite("disbursement signature gate after the outage exception's removal", () => {
  it("admits a fully countersigned agreement (control)", async () => {
    await expect(disburseByColleague("countersigned")).rejects.toBe(rollback)
  })

  it.each(["unsigned", "consumer_only"] as const)(
    "refuses DISBURSED for a %s agreement",
    async (signing) => {
      await expect(disburseByColleague(signing)).rejects.toThrow(
        /requires provider countersign evidence bound to the exact tenant, consumer signature and agreement/,
      )
    },
  )

  it("leaves no outage exception object in the database", async () => {
    const [objects] = await prisma.$queryRaw<Array<{
      functions: number
      triggers: number
      constraints: number
      columns: number
    }>>`
      SELECT
        (SELECT COUNT(*)::INT FROM pg_proc
          WHERE proname ILIKE '%outage%' OR prosrc ILIKE '%OutageDisbursement%') AS functions,
        (SELECT COUNT(*)::INT FROM pg_trigger WHERE tgname ILIKE '%outage%') AS triggers,
        (SELECT COUNT(*)::INT FROM pg_constraint
          WHERE pg_get_constraintdef(oid) ILIKE '%outage%') AS constraints,
        (SELECT COUNT(*)::INT FROM information_schema.columns
          WHERE column_name = 'disbursementExceptionId') AS columns
    `
    expect(objects).toEqual({ functions: 0, triggers: 0, constraints: 0, columns: 0 })
  })
})
