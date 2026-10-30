import { formatZAR, escapeHtml } from "@/lib/utils"
import type { LenderIdentity } from "@/lib/config/identity"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales"
import { createTranslator } from "@/lib/i18n/translate"

export type PortalEmailIdentity = Pick<LenderIdentity, "tradingName" | "legalName" | "ncrNumber" | "publicEmail">

function contactLink(identity: PortalEmailIdentity): string {
  const email = escapeHtml(identity.publicEmail)
  return `<a href="mailto:${email}" style="color:#4F46E5;">${email}</a>`
}

function baseLayout(identity: PortalEmailIdentity, header: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;font-size:14px;color:#1B1D24;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <!-- Header -->
      <tr><td style="background:#1B1D24;padding:28px 32px;border-radius:8px 8px 0 0;">
        <p style="margin:0;color:#4F46E5;font-size:18px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(identity.tradingName)}</p>
        <p style="margin:6px 0 0;color:#f3f4f6;font-size:11px;letter-spacing:1px;text-transform:uppercase;">${header}</p>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#ffffff;padding:32px;border:1px solid #e5e7eb;border-top:none;">
        ${body}
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#1B1D24;padding:18px 32px;border-radius:0 0 8px 8px;text-align:center;">
        <p style="margin:0;color:#888;font-size:11px;">NCR Registered Credit Provider &middot; ${escapeHtml(identity.ncrNumber)} &middot; <a href="mailto:${escapeHtml(identity.publicEmail)}" style="color:#4F46E5;text-decoration:none;">${escapeHtml(identity.publicEmail)}</a></p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`
}

export function applicationSubmittedEmail(
  identity: PortalEmailIdentity,
  clientName: string,
  reference: string,
  productName: string,
  amount: number,
  portalUrl?: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const t = createTranslator(locale, "comms")
  // A real, tappable button beats a plain "log into your portal" sentence and
  // gives the customer a one-click route to track/continue their application.
  const portalCta = portalUrl
    ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td align="center">
      <a href="${portalUrl}" style="display:inline-block;background:#4F46E5;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:14px;letter-spacing:0.5px;">${t("trackMyApplication")}</a>
    </td></tr></table>`
    : ""
  const portalLine = portalUrl
    ? `<p style="margin:0 0 8px;color:#444;line-height:1.6;">${t("trackWithLink")}</p>`
    : `<p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("trackWithoutLink")}</p>`
  const body = `
    <p style="margin:0 0 16px;font-size:16px;font-weight:bold;color:#1B1D24;">${t("submittedHeading")}</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("dear", { name: clientName })}</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("submittedThanks", { brand: escapeHtml(identity.tradingName) })}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border:1px solid #e5e7eb;border-radius:6px;margin:20px 0;">
      <tr><td style="padding:20px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;width:160px;">${t("labelReference")}</td>
            <td style="padding:6px 0;font-weight:bold;color:#1B1D24;">${reference}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">${t("labelProduct")}</td>
            <td style="padding:6px 0;color:#1B1D24;">${productName}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">${t("labelAppliedAmount")}</td>
            <td style="padding:6px 0;color:#4F46E5;font-weight:bold;">${formatZAR(amount)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">${t("labelStatus")}</td>
            <td style="padding:6px 0;"><span style="background:#DBEAFE;color:#1E40AF;font-size:11px;font-weight:bold;padding:2px 8px;border-radius:4px;text-transform:uppercase;">${t("statusSubmitted")}</span></td>
          </tr>
        </table>
      </td></tr>
    </table>

    ${portalLine}
    ${portalCta}
    <p style="margin:0 0 24px;color:#444;line-height:1.6;">${t("submittedDecisionTime")}</p>

    <p style="margin:0;color:#888;font-size:12px;line-height:1.6;">${t("anyQuestionsContact", { link: contactLink(identity) })}</p>
  `
  return baseLayout(identity, t("headerSubmitted"), body)
}

export function identityConflictNoticeEmail(identity: PortalEmailIdentity, params: {
  clientName: string
  portalUrl: string
  maskedOtherLabel: string
  maskedOtherValue: string
}): string {
  const { clientName, portalUrl, maskedOtherLabel, maskedOtherValue } = params
  const safeName = escapeHtml(clientName)
  const safeLabel = escapeHtml(maskedOtherLabel)
  const safeValue = escapeHtml(maskedOtherValue)
  const body = `
    <p style="margin:0 0 16px;font-size:16px;font-weight:bold;color:#1B1D24;">Did you just try to apply?</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">Dear <strong>${safeName}</strong>,</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">We received a loan application on our website that matched your existing ${escapeHtml(identity.tradingName)} profile, but it used a ${safeLabel} we don&rsquo;t have on file for you (<strong>${safeValue}</strong>). For your security we did not change any of your details.</p>
    <p style="margin:0 0 8px;color:#444;line-height:1.6;">If this was you, continue securely in your client portal &mdash; sign in if you already have a password, or set one up in a minute:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td align="center">
      <a href="${portalUrl}" style="display:inline-block;background:#4F46E5;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:14px;letter-spacing:0.5px;">Continue in the portal</a>
    </td></tr></table>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">If this wasn&rsquo;t you, you can safely ignore this email &mdash; nothing has changed on your account.</p>
    <p style="margin:0;color:#888;font-size:12px;line-height:1.6;">Questions? Contact us at ${contactLink(identity)}</p>
  `
  return baseLayout(identity, "Portal Sign-In Request", body)
}

export function applicationApprovedEmail(
  identity: PortalEmailIdentity,
  clientName: string,
  reference: string,
  productName: string,
  amount: number,
  portalUrl: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const t = createTranslator(locale, "comms")
  const body = `
    <p style="margin:0 0 16px;font-size:16px;font-weight:bold;color:#1B1D24;">${t("approvedHeading")}</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("dear", { name: clientName })}</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("approvedBody", { approved: `<strong style="color:#15803D;">${t("approvedWord")}</strong>` })}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin:20px 0;">
      <tr><td style="padding:20px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;width:160px;">${t("labelReference")}</td>
            <td style="padding:6px 0;font-weight:bold;color:#1B1D24;">${reference}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">${t("labelProduct")}</td>
            <td style="padding:6px 0;color:#1B1D24;">${productName}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">${t("labelApprovedAmount")}</td>
            <td style="padding:6px 0;color:#4F46E5;font-weight:bold;">${formatZAR(amount)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">${t("labelStatus")}</td>
            <td style="padding:6px 0;"><span style="background:#DCFCE7;color:#166534;font-size:11px;font-weight:bold;padding:2px 8px;border-radius:4px;text-transform:uppercase;">${t("statusApproved")}</span></td>
          </tr>
        </table>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FEF9C3;border:1px solid #FDE047;border-radius:6px;padding:16px 20px;margin:20px 0;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-weight:bold;color:#92400E;font-size:13px;">&#9888; ${t("actionSignTitle")}</p>
        <p style="margin:0;color:#78350F;font-size:12px;line-height:1.5;">${t("actionSignBody")}</p>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td align="center">
        <a href="${portalUrl}" style="display:inline-block;background:#4F46E5;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:14px;letter-spacing:0.5px;">${t("reviewSignCta")}</a>
      </td></tr>
    </table>

    <p style="margin:0;color:#888;font-size:12px;line-height:1.6;">${t("notYouContact", { link: contactLink(identity) })}</p>
  `
  return baseLayout(identity, t("headerApproved"), body)
}

export function applicationDeclinedEmail(
  identity: PortalEmailIdentity,
  clientName: string,
  reference: string,
  reason: string,
  /** The lender's approved paragraph for an automated decision (lib/decisioning/notice.ts); absent for a decision a person took. */
  automatedNotice?: string | null,
): string {
  const body = `
    <p style="margin:0 0 16px;font-size:16px;font-weight:bold;color:#1B1D24;">Regarding your loan application</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">Dear <strong>${clientName}</strong>,</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">Thank you for your interest in ${escapeHtml(identity.tradingName)}. After careful consideration of your application (<strong>${reference}</strong>), we regret to inform you that we are unable to approve your request at this time.</p>

    ${reason ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;margin:20px 0;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px;">Reason</p>
        <p style="margin:0;color:#7F1D1D;line-height:1.6;">${reason}</p>
      </td></tr>
    </table>
    ` : ""}${automatedNotice ? `
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">${escapeHtml(automatedNotice)}</p>` : ""}

    <p style="margin:0 0 16px;color:#444;line-height:1.6;">This decision was made in accordance with the National Credit Act (NCA) affordability requirements. You have the right to:</p>
    <ul style="margin:0 0 16px;padding-left:20px;color:#444;line-height:1.8;">
      <li>Request the reasons for this decision in writing</li>
      <li>Contact the NCR (National Credit Regulator) if you believe this decision was unfair</li>
      <li>Reapply in the future should your circumstances change</li>
    </ul>

    <p style="margin:0 0 16px;color:#444;line-height:1.6;">We encourage you to review your financial situation and welcome you to apply again in the future.</p>
    <p style="margin:0;color:#888;font-size:12px;line-height:1.6;">For any queries, please contact us at ${contactLink(identity)}</p>
  `
  return baseLayout(identity, "Loan Application Update", body)
}

export function paymentDueReminderEmail(
  identity: PortalEmailIdentity,
  clientName: string,
  amount: number,
  dueDate: string,
  reference: string
): string {
  const body = `
    <p style="margin:0 0 16px;font-size:16px;font-weight:bold;color:#1B1D24;">Payment reminder</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">Dear <strong>${clientName}</strong>,</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">This is a friendly reminder that a payment is due on your ${escapeHtml(identity.tradingName)} loan account.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FEF9C3;border:1px solid #FDE047;border-radius:6px;margin:20px 0;">
      <tr><td style="padding:20px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;width:160px;">Loan Reference</td>
            <td style="padding:6px 0;font-weight:bold;color:#1B1D24;">${reference}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">Amount Due</td>
            <td style="padding:6px 0;color:#4F46E5;font-size:20px;font-weight:bold;">${formatZAR(amount)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">Due Date</td>
            <td style="padding:6px 0;font-weight:bold;color:#92400E;">${dueDate}</td>
          </tr>
        </table>
      </td></tr>
    </table>

    <p style="margin:0 0 16px;color:#444;line-height:1.6;">Please make your payment by the due date. You can make an EFT payment to:</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border:1px solid #e5e7eb;border-radius:6px;margin:0 0 20px;">
      <tr><td style="padding:16px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:4px 0;color:#888;font-size:12px;width:140px;">Bank</td>
            <td style="padding:4px 0;color:#1B1D24;">First National Bank</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#888;font-size:12px;">Account Holder</td>
            <td style="padding:4px 0;color:#1B1D24;">${escapeHtml(identity.legalName)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#888;font-size:12px;">Reference</td>
            <td style="padding:4px 0;font-weight:bold;color:#4F46E5;">${reference}</td>
          </tr>
        </table>
      </td></tr>
    </table>

    <p style="margin:0;color:#888;font-size:12px;line-height:1.6;">Questions? Contact us at ${contactLink(identity)}</p>
  `
  return baseLayout(identity, "Payment Due Reminder", body)
}

export function paymentReceivedEmail(
  identity: PortalEmailIdentity,
  clientName: string,
  amount: number,
  reference: string,
  outstanding: number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const t = createTranslator(locale, "comms")
  const body = `
    <p style="margin:0 0 16px;font-size:16px;font-weight:bold;color:#1B1D24;">${t("receivedHeading")}</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("dear", { name: clientName })}</p>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("receivedBody")}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin:20px 0;">
      <tr><td style="padding:20px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;width:180px;">${t("labelLoanReference")}</td>
            <td style="padding:6px 0;font-weight:bold;color:#1B1D24;">${reference}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">${t("labelPaymentAmount")}</td>
            <td style="padding:6px 0;color:#15803D;font-size:20px;font-weight:bold;">${formatZAR(amount)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#888;font-size:12px;">${t("labelOutstanding")}</td>
            <td style="padding:6px 0;color:#1B1D24;font-weight:bold;">${formatZAR(outstanding)}</td>
          </tr>
        </table>
      </td></tr>
    </table>

    <p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("receivedGoodStanding")}</p>
    <p style="margin:0;color:#888;font-size:12px;line-height:1.6;">${t("anyQueriesContact", { link: contactLink(identity) })}</p>
  `
  return baseLayout(identity, t("headerReceived"), body)
}
