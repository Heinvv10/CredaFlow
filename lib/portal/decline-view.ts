import type { DeclineCategory } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { getBureauProvider } from "@/lib/bureau/registry"
import { clientDeclineReason, isBureauDeclineCategory } from "@/lib/applications/decline-category"

/**
 * What a declined borrower is shown in the portal: the reason (the text staff
 * chose for the client, never their internal note), the credit bureau the
 * decision rested on with its contact details when it was a bureau decline,
 * and what they can do next (Fair Score audit 2026-10-16). English in every
 * locale, like the decline reason itself (lib/i18n/.claude.md).
 */
export interface PortalDeclineView {
  reason: string
  bureau: { name: string; phone: string | null; website: string | null } | null
  nextSteps: string[]
}

type Db = Pick<typeof prisma, "creditBureauCheck">

const CATEGORY_STEPS: Partial<Record<DeclineCategory, string>> = {
  AFFORDABILITY: "You may apply again for a smaller amount or a longer term, or once your income or expenses change.",
  DOCUMENTS_INCOMPLETE: "Upload the missing documents under Documents, then apply again.",
  IDENTITY: "Contact us so we can verify your identity, then apply again.",
  DEBT_REVIEW: "New credit cannot be granted while you are under debt review. You may apply again once your debt counsellor has issued your clearance certificate.",
}

const BUREAU_STEPS = [
  "You are entitled to one free credit report from each credit bureau every year. Check it for anything you do not recognise.",
  "If information on your credit report is wrong, you can dispute it with the credit bureau, which must investigate it at no cost to you.",
]

export function declineNextSteps(category: DeclineCategory | null, contact: { phone: string; email: string }): string[] {
  const steps: string[] = []
  if (category && isBureauDeclineCategory(category)) steps.push(...BUREAU_STEPS)
  const specific = category ? CATEGORY_STEPS[category] : undefined
  if (specific) steps.push(specific)
  steps.push(`If you have questions about this decision, contact us on ${contact.phone} or ${contact.email}.`)
  steps.push("If you are unhappy with how your application was handled, you may lodge a complaint with us, and then with the Credit Ombud or the National Credit Regulator.")
  return steps
}

export async function loadPortalDeclineView(
  db: Db,
  tenantId: string,
  application: { id: string; declineCategory: DeclineCategory | null; decisionReason: string | null },
  contact: { phone: string; email: string },
): Promise<PortalDeclineView> {
  const category = application.declineCategory
  const reason = application.decisionReason?.trim()
    || (category ? clientDeclineReason(category, null) : null)
    || "Your application did not meet our lending criteria."

  let bureau: PortalDeclineView["bureau"] = null
  if (category && isBureauDeclineCategory(category)) {
    // The report the decision rested on: the application's latest successful enquiry.
    const check = await db.creditBureauCheck.findFirst({
      where: { tenantId, applicationId: application.id, ok: true },
      orderBy: { createdAt: "desc" },
      select: { provider: true },
    })
    if (check) {
      const provider = getBureauProvider(check.provider)
      bureau = {
        name: provider?.displayName ?? check.provider,
        phone: provider?.consumerContact?.phone ?? null,
        website: provider?.consumerContact?.website ?? null,
      }
    }
  }

  return { reason, bureau, nextSteps: declineNextSteps(category, contact) }
}
