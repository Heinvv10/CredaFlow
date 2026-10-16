/**
 * The Section 129 email transport, with the one demo exception.
 *
 * A demo stack (DEMO_MODE=true) whose lender has no email configured cannot
 * send a notice, and its borrowers' `.invalid` mailboxes could never receive
 * one. There, and only for such a mailbox of a demo lender (TenantConfig.
 * isDemoLender, set only by the demo seed and the demo stack scripts), the
 * notice is SIMULATED: nothing leaves the process, the result says `simulated: true`, and the route records
 * the issuance as "simulated (not sent)" — the reminder simulator's wording.
 * A real lender, a configured mailbox, or any deliverable address always goes
 * to the real provider, and fails when email is not configured.
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { sendEmail, type EmailResult, type SendEmailOptions } from "@/lib/email/service"
import { isDemoMode, isUndeliverableMailbox } from "@/lib/config/demo-mode"

export type Section129EmailResult = EmailResult & { simulated?: true }

export const SECTION129_SIMULATED_NOTE = "simulated (not sent)"

/**
 * Three independent conditions: the deployment says DEMO_MODE, the tenant
 * carries the demo-lender marker, and the mailbox can never receive mail. A
 * real lender on a misconfigured deployment fails the second whatever its
 * slug: provisioning refuses the marker (scripts/lender/bootstrap-tenant.ts).
 */
export async function simulatesSection129(tenantId: string, to: string): Promise<boolean> {
  if (!isDemoMode() || !isUndeliverableMailbox(to)) return false
  const [lender, config] = await Promise.all([
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } }),
    prisma.emailConfig.findUnique({ where: { tenantId }, select: { active: true } }),
  ])
  return lender?.isDemoLender === true && !config?.active
}

/**
 * `simulate` is the reservation's recorded decision (simulatesSection129 at
 * reserve time), so the send and the stored record can never disagree. The
 * deployment must still be DEMO_MODE at send time. A recorded simulation on a
 * stack that has left demo mode is refused before any provider call, never
 * sent for real: its record says simulated, and a retry reserves afresh.
 */
export async function sendSection129Email(opts: SendEmailOptions, simulate: boolean): Promise<Section129EmailResult> {
  if (simulate && !isDemoMode()) {
    return {
      ok: false,
      error: "This notice was reserved as a demo simulation, but the deployment is no longer in demo mode. Send it again.",
      providerOutcome: "DEFINITELY_REJECTED",
    }
  }
  if (simulate) {
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
