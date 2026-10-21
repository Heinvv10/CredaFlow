import { prisma } from "@/lib/prisma"
import type { CrossSellType } from "@prisma/client"

type RuleShape = { id: string; name: string; description: string | null; actionConfig: unknown }

function cfg(rule: RuleShape): Record<string, unknown> {
  return (rule.actionConfig ?? {}) as Record<string, unknown>
}

// WhatsApp reminders are NOT an engine action: the borrower reminder crons
// (app/api/cron/reminders) owns them.

// ── CREATE_AGENT_TASK / ISSUE_SECTION_129 / NOTIFY_AGENT ─────────────────────

export async function actionCreateTask(
  rule: RuleShape,
  entity: { type: string; id: string; ref?: string },
  tenantId: string,
): Promise<void> {
  const c = cfg(rule)
  const rawTitle = (c.taskTitle as string | undefined) ?? rule.name
  const title = entity.ref ? rawTitle.replace("{ref}", entity.ref) : rawTitle

  await prisma.agentTask.create({
    data: {
      tenantId,
      type: (c.taskType as string | undefined) ?? "GENERIC",
      title,
      description: rule.description ?? undefined,
      entityType: entity.type,
      entityId: entity.id,
      priority: (c.priority as string | undefined) ?? "MEDIUM",
      createdByRuleId: rule.id,
    },
  })
}

// ── CREATE_OPPORTUNITY ────────────────────────────────────────────────────────

export async function actionCreateOpportunity(
  rule: RuleShape,
  clientId: string,
  tenantId: string,
): Promise<void> {
  const c = cfg(rule)
  const type = ((c.opportunityType as string | undefined) ?? "PERSONAL_LOAN") as CrossSellType
  const description = (c.description as string | undefined) ?? rule.description ?? undefined

  // Avoid duplicates — only create if no pending/contacted opportunity of this type exists for this tenant+client
  const existing = await prisma.crossSellOpportunity.findFirst({
    where: { clientId, tenantId, type, status: { in: ["PENDING", "CONTACTED"] } },
  })
  if (existing) return

  await prisma.crossSellOpportunity.create({
    data: { clientId, tenantId, type, status: "PENDING", notes: description ?? null },
  })
}
