/**
 * The per-lender opt-in for the automation engine's WhatsApp rules:
 * `TenantConfig.automatedWhatsAppReminders`, OFF by default (also for a tenant
 * with no config row). While off the engine runs no SEND_WA rule and a manual
 * replay of one is refused. Only an ADMIN or SUPER_ADMIN changes it, audited
 * (applyAutomatedWhatsApp).
 */
import { prisma } from "@/lib/prisma"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"

type ConfigReader = Pick<typeof PrismaClientInstance, "tenantConfig">

export async function isAutomatedWhatsAppEnabled(tenantId: string, db: ConfigReader = prisma): Promise<boolean> {
  const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { automatedWhatsAppReminders: true } })
  return config?.automatedWhatsAppReminders ?? false
}

type SwitchTx = Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig" | "auditLog">

/** Set the flag in the caller's transaction; the change and its audit row commit together. */
export async function applyAutomatedWhatsApp(
  tx: SwitchTx,
  args: { tenantId: string; actor: { id: string; email: string }; enabled: boolean; ipAddress?: string },
): Promise<{ changed: boolean; enabled: boolean }> {
  const { tenantId, actor, enabled, ipAddress } = args
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`automated-whatsapp:${tenantId}`}))`
  const previous = await isAutomatedWhatsAppEnabled(tenantId, tx)
  if (previous === enabled) return { changed: false, enabled }

  await tx.tenantConfig.upsert({
    where: { tenantId },
    update: { automatedWhatsAppReminders: enabled },
    create: { tenantId, automatedWhatsAppReminders: enabled },
  })
  await logAuditStrict({
    tenantId,
    userId: actor.id,
    userEmail: actor.email,
    action: AuditAction.AUTOMATED_WHATSAPP_REMINDERS_UPDATED,
    entity: "TenantConfig",
    entityId: tenantId,
    oldValue: { automatedWhatsAppReminders: previous },
    newValue: { automatedWhatsAppReminders: enabled },
    ipAddress,
  }, tx)
  return { changed: true, enabled }
}
