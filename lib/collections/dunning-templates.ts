import { prisma } from "@/lib/prisma"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"
import type { SweepTenant } from "@/lib/ops/tenant-sweep"

/** The default templates the reminders cron and the loan_overdue notice send through; not the OTP or portal rows. */
export const DUNNING_TEMPLATE_KEY = /^(payment_reminder_|entity_reminder_|entity_payment_(due|overdue)_|loan_overdue)/

/**
 * Seeds the dunning templates the tenant lacks (idempotent: a row with the same
 * key or (event, channel) is left alone, never updated). A tenant that predates a
 * template, such as `payment_reminder_email`, gets it here instead of waiting on a
 * deploy step someone has to remember. Run by the reminders cron and by
 * escalation, whose 60-DPD notice (loan_overdue) needs the rows too. Never fatal:
 * a failure is logged and the legs that need the missing row are skipped or fail
 * visibly.
 */
export async function ensureDunningTemplates(tenant: SweepTenant, job: string): Promise<void> {
  try {
    const config = await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: { brandName: true } })
    await seedDefaultMessageTemplates(prisma, tenant.id, config?.brandName?.trim() || tenant.name, { only: (t) => DUNNING_TEMPLATE_KEY.test(t.key) })
  } catch (err) {
    console.error(`[${job}] tenant ${tenant.id}: could not seed the default message templates:`, err)
  }
}
