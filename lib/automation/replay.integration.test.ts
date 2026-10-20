/**
 * Real-PostgreSQL proof that replay fails closed when a tenant's log points at
 * another tenant's rule. Run only against a throwaway, fully migrated database:
 *
 *   RUN_AUTOMATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/automation/replay.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { AutomationReplayRefusedError, replayAutomationLog } from "./engine"

const RUN = process.env.RUN_AUTOMATION_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("automation replay tenant guard (real Postgres)", () => {
  it("refuses a tenant-scoped log whose rule belongs to another tenant", async () => {
    const tenantA = `tenant_replay_a_${token}`
    const tenantB = `tenant_replay_b_${token}`
    const ruleB = `rule_replay_b_${token}`
    const logA = `log_replay_a_${token}`
    await withoutTenantScope(async () => {
      await prisma.tenant.createMany({
        data: [
          { id: tenantA, slug: `replay-a-${token}`, name: "Replay tenant A" },
          { id: tenantB, slug: `replay-b-${token}`, name: "Replay tenant B" },
        ],
      })
      await prisma.automationRule.create({
        data: {
          id: ruleB, tenantId: tenantB, name: "Cross-tenant rule fixture", trigger: "LEAD_STALE",
          condition: { days: 1 }, action: "CREATE_AGENT_TASK",
        },
      })
      await prisma.automationLog.create({
        data: {
          id: logA, tenantId: tenantA, ruleId: ruleB, entityType: "lead",
          entityId: `lead_replay_${token}`, result: "failed", error: "Synthetic historical mismatch",
        },
      })
    })

    const refusal = await withoutTenantScope(() => replayAutomationLog(logA, tenantA)).catch((e: unknown) => e)

    expect(refusal).toBeInstanceOf(AutomationReplayRefusedError)
    expect((refusal as AutomationReplayRefusedError).code).toBe("not_found")
    expect(await withoutTenantScope(() => prisma.agentTask.count({
      where: { tenantId: tenantA, createdByRuleId: ruleB },
    }))).toBe(0)
  })
})
