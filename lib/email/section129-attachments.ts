import type { EmailAttachment } from "@/lib/email/service"
import { generateSection129Pdf } from "@/lib/pdf/section129"
import type { LenderIdentity } from "@/lib/config/identity-schema"

/**
 * Per-loan attachments: the rendered S129 notice PDF. The PDF filename
 * uses the loan reference so a collections officer can identify it in a
 * mailbox or court bundle.
 *
 * Inline letterhead/signature images were previously embedded as `cid:`
 * attachments but were dropped after a deliverability smoke
 * showed a receiving MX silently filtering the multipart/related
 * structure. The PDF carries the full polished letterhead — the email
 * body is now plain HTML.
 */
export async function buildSection129Attachments(args: {
  lender: LenderIdentity
  client: { firstName: string; lastName: string; idNumber: string; addressLine1?: string; city?: string }
  loan: {
    reference: string
    arrearsAmount: number
    outstandingPrincipal: number
    daysInArrears: number
    totalOutstanding?: number
    chargesOutstanding?: number
  }
  noticeDate?: Date
  /** The tenant's letterhead logo (lib/config/lender-logo.ts); absent → text letterhead. */
  logo?: Uint8Array
}): Promise<EmailAttachment[]> {
  const pdf = await generateSection129Pdf({
    lender: args.lender,
    client: args.client,
    loan: args.loan,
    noticeDate: args.noticeDate,
    logo: args.logo,
  })
  return [
    {
      filename: `Section-129-Notice-${args.loan.reference}.pdf`,
      content: pdf,
      contentType: "application/pdf",
    },
  ]
}
