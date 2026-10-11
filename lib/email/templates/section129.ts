import { escapeHtml, formatZAR } from "@/lib/utils"
import { requireLenderIdentityFields, type LenderIdentity } from "@/lib/config/identity-schema"

/**
 * Section 129 cover-letter email body.
 *
 * The full statutory notice — with verbatim NCA 129(1)(a) wording, the
 * enumerated debt-counsellor / dispute / ombud rights, the "10 business
 * days" warning, and the polished letterhead with logo + signature — is
 * rendered to a PDF (lib/pdf/section129.ts) and attached. The email body
 * here is a deliberately plain text-styled cover note.
 *
 * Why no inline letterhead/signature images: some corporate mail gateways
 * silently filter an HTML body carrying inline `cid:` images — a known
 * anti-spam pattern for messages mixing a `Reply-To` mismatch with
 * multipart/related embedded images. Keeping
 * the body images-free and the PDF as the binding artefact gives the
 * highest deliverability while preserving the polished feel.
 *
 * NCA-mandated language lives in the PDF. Do not duplicate the verbatim
 * statutory paragraphs in this body — if the email is the only thing the
 * client reads, the PDF must still be the legally-binding artefact.
 *
 * Every identity value is the lender's own, re-validated here: the covering
 * email must name the same credit provider as the notice it carries.
 */

const IDENTITY_FIELDS = [
  "legalName", "ncrNumber", "fspNumber", "collectionsEmail", "collectionsPhone",
  "collectionsPhoneSecondary", "brandTagline",
] as const

interface Section129Data {
  clientName: string
  loanReference: string
  arrearsAmount: number       // cents
  outstandingBalance: number  // cents
  daysInArrears: number
  noticeDate: string          // formatted date string (en-ZA)
  lender: Pick<LenderIdentity, (typeof IDENTITY_FIELDS)[number]>
}

export function section129Html(d: Section129Data): string {
  const lender = requireLenderIdentityFields(d.lender, IDENTITY_FIELDS)
  const name = escapeHtml(lender.legalName)
  const collectionsEmail = escapeHtml(lender.collectionsEmail)
  const phones = [lender.collectionsPhone, lender.collectionsPhoneSecondary].filter(Boolean).map((p) => escapeHtml(p as string)).join(" &nbsp;/&nbsp; ")
  const tagline = lender.brandTagline ? `\n  <div class="tagline">${escapeHtml(lender.brandTagline)}</div>` : ""
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1B1D24; max-width: 720px; margin: 0 auto; padding: 0; background: #ffffff; }
  .letterhead { padding: 24px 32px 16px; border-bottom: 3px solid #4F46E5; }
  .letterhead h1 { font-family: Georgia, "Times New Roman", serif; font-size: 22px; color: #4F46E5; margin: 0; letter-spacing: 0.01em; }
  .letterhead .tagline { font-family: Georgia, serif; font-style: italic; font-size: 12px; color: #6b7280; margin-top: 2px; }
  .letterhead .compliance { font-size: 11px; color: #6b7280; margin-top: 10px; letter-spacing: 0.02em; }
  .body { padding: 24px 32px; line-height: 1.55; }
  .body p { margin: 0 0 14px; }
  .ref-block { background: #fafaf7; border-left: 4px solid #4F46E5; padding: 14px 18px; margin: 18px 0; font-size: 13px; }
  .ref-block table { width: 100%; border-collapse: collapse; }
  .ref-block td { padding: 5px 0; }
  .ref-block td.label { color: #6b7280; }
  .ref-block td.value { font-weight: bold; color: #1B1D24; text-align: right; }
  .deadline { color: #B45309; font-weight: bold; }
  .attachment-note { background: #FFF8EC; border: 1px solid #C7D2FE; border-radius: 6px; padding: 12px 16px; margin: 18px 0; font-size: 13px; color: #3730A3; }
  .footer { padding: 14px 32px 24px; font-size: 11px; color: #9ca3af; line-height: 1.5; border-top: 1px solid #ececec; }
  a { color: #4F46E5; }
</style>
</head>
<body>

<div class="letterhead">
  <h1>${name}</h1>${tagline}
  <div class="compliance">Registered Credit Provider — NCR ${lender.ncrNumber} &nbsp;·&nbsp; Authorised FSP ${lender.fspNumber}</div>
</div>

<div class="body">
  <p><b>${d.noticeDate}</b></p>
  <p>Dear ${d.clientName},</p>

  <p><b>Re: Section 129 Notice of Default — Account ${d.loanReference}</b></p>

  <p>This letter, together with the <b>Section 129 Notice attached as a PDF</b>, is your formal notice in terms of Section 129(1)(a) of the National Credit Act, 34 of 2005, that your credit agreement with ${name} is in default.</p>

  <div class="ref-block">
    <table>
      <tr><td class="label">Account reference</td><td class="value">${d.loanReference}</td></tr>
      <tr><td class="label">Days in arrears</td><td class="value">${d.daysInArrears} days</td></tr>
      <tr><td class="label">Amount in arrears</td><td class="value">${formatZAR(d.arrearsAmount)}</td></tr>
      <tr><td class="label">Total outstanding balance</td><td class="value">${formatZAR(d.outstandingBalance)}</td></tr>
      <tr><td class="label">Notice date</td><td class="value">${d.noticeDate}</td></tr>
    </table>
  </div>

  <p>You have <span class="deadline">10 (ten) business days</span> from the date of this notice to respond. Your options are set out in full in the attached PDF and include referring the matter to a debt counsellor, alternative dispute resolution agent, consumer court, or ombud — or contacting us directly to arrange payment.</p>

  <div class="attachment-note">
    <b>Attached:</b> Section 129 Notice — Account ${d.loanReference}.pdf
  </div>

  <p>To arrange payment or discuss your options, contact our collections department:</p>

  <p style="margin-left: 6px;">
    <b>Email:</b> <a href="mailto:${collectionsEmail}">${collectionsEmail}</a><br>
    <b>Phone:</b> ${phones}
  </p>

  <p>If no response is received within 10 business days, ${name} reserves the right to commence legal proceedings to recover the full outstanding balance without further notice.</p>

  <p>Yours faithfully,<br>
  <b>Collections Department</b><br>
  ${name}</p>
</div>

<div class="footer">
  This notice is issued in compliance with Section 129(1)(a) of the National Credit Act, No. 34 of 2005. The attached PDF is the operative notice; this email is the covering communication. If you believe this notice has been sent to you in error, contact us immediately at ${collectionsEmail}.<br><br>
  ${name} is a Registered Credit Provider (NCR ${lender.ncrNumber}) and an Authorised Financial Services Provider (FSP ${lender.fspNumber}).
</div>

</body>
</html>
`.trim()
}

export function section129Text(d: Section129Data): string {
  const lender = requireLenderIdentityFields(d.lender, IDENTITY_FIELDS)
  const phones = [lender.collectionsPhone, lender.collectionsPhoneSecondary].filter(Boolean).join(" / ")
  return `
SECTION 129 NOTICE — ${lender.legalName.toUpperCase()}
NCR Registration: ${lender.ncrNumber}

${d.noticeDate}

Dear ${d.clientName},

Re: Section 129 Notice of Default — Account ${d.loanReference}

This email, together with the Section 129 Notice attached as a PDF, is
your formal notice in terms of Section 129(1)(a) of the National Credit
Act, 34 of 2005, that your credit agreement with ${lender.legalName}
is in default.

  Account reference:         ${d.loanReference}
  Days in arrears:           ${d.daysInArrears} days
  Amount in arrears:         ${formatZAR(d.arrearsAmount)}
  Total outstanding balance: ${formatZAR(d.outstandingBalance)}
  Notice date:               ${d.noticeDate}

You have 10 (ten) business days from the date of this notice to respond.
Your options are set out in full in the attached PDF.

Attached: Section 129 Notice — Account ${d.loanReference}.pdf

Contact our collections department:
  Email: ${lender.collectionsEmail}
  Phone: ${phones}

If no response is received within 10 business days, ${lender.legalName}
reserves the right to commence legal proceedings to recover the full
outstanding balance without further notice.

Yours faithfully,
Collections Department
${lender.legalName}
NCR ${lender.ncrNumber} · FSP ${lender.fspNumber}
`.trim()
}
