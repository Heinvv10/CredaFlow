import { canonicalJson } from "@/lib/canonical-json"
import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"
import type { AutomationTrigger, AutomationAction } from "@prisma/client"

interface RuleSeed {
  name: string
  description: string
  trigger: AutomationTrigger
  condition: Prisma.InputJsonValue
  action: AutomationAction
  actionConfig: Prisma.InputJsonValue
}

const BUILT_IN_RULES: RuleSeed[] = [
  {
    name: "Stale lead — notify agent",
    description: "Notify assigned agent when a lead has had no activity for 48+ hours",
    trigger: "LEAD_STALE",
    condition: { staleHours: 48 },
    action: "NOTIFY_AGENT",
    actionConfig: { taskTitle: "Stale lead needs follow-up", taskType: "REVIEW_STALE_LEAD", priority: "MEDIUM" },
  },
  {
    name: "DPD 90 — Section 129 task",
    description: "Create an agent task to review Section 129 eligibility at 90 DPD",
    trigger: "DPD_THRESHOLD",
    condition: { dpdThreshold: 90 },
    action: "ISSUE_SECTION_129",
    actionConfig: { taskTitle: "Issue Section 129 notice", priority: "HIGH" },
  },
  {
    name: "DPD 90 — attorney referral task",
    description: "Create attorney referral task at 90 DPD",
    trigger: "DPD_THRESHOLD",
    condition: { dpdThreshold: 90 },
    action: "CREATE_AGENT_TASK",
    actionConfig: { taskTitle: "Attorney referral required", taskType: "ATTORNEY_REFERRAL", priority: "URGENT" },
  },
  {
    name: "3 on-time payments — cross-sell opportunity",
    description: "Create cross-sell opportunity after client makes 3 consecutive on-time payments",
    trigger: "LOAN_PAID_ON_TIME_N",
    condition: { onTimeCount: 3 },
    action: "CREATE_OPPORTUNITY",
    actionConfig: { opportunityType: "PERSONAL_LOAN", description: "Client has 3+ on-time payments — good upgrade candidate" },
  },
]

export async function ensureBuiltInRules(tenantId: string): Promise<void> {
  const existing = await prisma.automationRule.findMany({
    where: { tenantId, isBuiltIn: true },
    select: {
      id: true,
      name: true,
      description: true,
      trigger: true,
      condition: true,
      action: true,
      actionConfig: true,
      enabled: true,
    },
  })

  // Built-in rows are durable tenant data. Merely changing the seed leaves the
  // former 20-DPD rule live forever, so migrate one canonical row in place and
  // disable any duplicate legacy copies on every engine start.
  const section129Seed = BUILT_IN_RULES.find((rule) => rule.action === "ISSUE_SECTION_129")!
  const section129Rows = existing.filter((rule) => rule.action === "ISSUE_SECTION_129")
  const canonical = section129Rows.find((rule) => rule.name === section129Seed.name)
    ?? section129Rows[0]
  if (canonical) {
    const requiresMigration = canonical.name !== section129Seed.name
      || canonical.description !== section129Seed.description
      || canonical.trigger !== section129Seed.trigger
      // jsonb does not preserve key order, so a raw JSON.stringify comparison
      // read "changed" for every stored row and re-ran this migration update
      // on every engine start, per tenant. Canonical comparison still detects
      // any changed VALUE, which is what this check is for.
      || canonicalJson(canonical.condition) !== canonicalJson(section129Seed.condition)
      || canonicalJson(canonical.actionConfig) !== canonicalJson(section129Seed.actionConfig)
    if (requiresMigration) {
      await prisma.automationRule.update({
        where: { id: canonical.id },
        data: {
          name: section129Seed.name,
          description: section129Seed.description,
          trigger: section129Seed.trigger,
          condition: section129Seed.condition,
          actionConfig: section129Seed.actionConfig,
        },
      })
    }
    const duplicateIds = section129Rows.filter((rule) => rule.id !== canonical.id).map((rule) => rule.id)
    if (duplicateIds.length > 0) {
      await prisma.automationRule.updateMany({
        where: { id: { in: duplicateIds } },
        data: { enabled: false },
      })
    }
  } else {
    await prisma.automationRule.create({
      data: { ...section129Seed, tenantId, isBuiltIn: true },
    })
  }

  const existingNames = new Set(
    existing.filter((rule) => rule.action !== "ISSUE_SECTION_129").map((rule) => rule.name),
  )

  const toCreate = BUILT_IN_RULES.filter(
    (rule) => rule.action !== "ISSUE_SECTION_129" && !existingNames.has(rule.name),
  )
  if (toCreate.length === 0) return

  await prisma.automationRule.createMany({
    data: toCreate.map((r) => ({ ...r, tenantId, isBuiltIn: true })),
  })
}
