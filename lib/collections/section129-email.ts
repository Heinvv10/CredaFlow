/**
 * The Section 129 email transport, with the one demo exception.
 *
 * A demo stack (DEMO_MODE=true) whose lender has no email configured cannot
 * send a notice, and its borrowers' `.invalid` mailboxes could never receive
 * one. There, and only for such a mailbox of a demo lender (its tenant slug is
 * one of prisma/demo-lender.ts), the notice is SIMULATED: nothing
 * leaves the process, the result says `simulated: true`, and the route records
 * the issuance as "simulated (not sent)" — the reminder simulator's wording.
 * A real lender, a configured mailbox, or any deliverable address always goes
 * to the real provider, and fails when email is not configured.
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { sendEmail, type EmailResult, type SendEmailOptions } from "@/lib/email/service"
import { isDemoMode, isUndeliverableMailbox } from "@/lib/config/demo-mode"
import { DEMO_LENDERS } from "@/prisma/demo-lender"

export type Section129EmailResult = EmailResult & { simulated?: true }

export const SECTION129_SIMULATED_NOTE = "simulated (not sent)"

const DEMO_LENDER_SLUGS: ReadonlySet<string> = new Set(Object.values(DEMO_LENDERS).map((lender) => lender.slug))

/**
 * Three independent conditions: the deployment says DEMO_MODE, the tenant is
 * one of the demo lenders the seed creates, and the mailbox can never receive
 * mail. A real lender on a misconfigured deployment fails the second.
 */
async function simulatesSection129(tenantId: string, to: string): Promise<boolean> {
  if (!isDemoMode() || !isUndeliverableMailbox(to)) return false
  const [tenant, config] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
    prisma.emailConfig.findUnique({ where: { tenantId }, select: { active: true } }),
  ])
  return Boolean(tenant && DEMO_LENDER_SLUGS.has(tenant.slug)) && !config?.active
}

export async function sendSection129Email(opts: SendEmailOptions): Promise<Section129EmailResult> {
  if (await simulatesSection129(opts.tenantId, opts.to)) {
    return {
      ok: true,
      simulated: true,
      messageId: `simulated-s129-${randomUUID()}`,
      providerOutcome: "ACCEPTED",
      acceptedAt: new Date(),
    }
  }
  return sendEmail(opts)
}

export function section129SentMessage(email: string, simulated: boolean): string {
  return simulated
    ? `Section 129 notice ${SECTION129_SIMULATED_NOTE}: ${email} is a demo mailbox that cannot receive mail.`
    : `Section 129 notice accepted by the email provider for ${email}`
}
