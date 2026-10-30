import { escapeHtml } from "@/lib/utils"
import type { LenderIdentity } from "@/lib/config/identity"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales"
import { createTranslator } from "@/lib/i18n/translate"

// Loan-event emails that have no dedicated portal template (moved out of
// lib/notifications.ts). The disbursement email takes its copy from the comms
// catalogue in the client's language; the regulatory footer line stays
// English. The overdue notice is collections: English in every language.

export function disbursedHtml(identity: LenderIdentity, name: string, ref: string, locale: Locale = DEFAULT_LOCALE): string {
  const t = createTranslator(locale, "comms")
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;font-size:14px;color:#1B1D24;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
<table style="max-width:600px;width:100%;" cellpadding="0" cellspacing="0">
<tr><td style="background:#1B1D24;padding:28px 32px;border-radius:8px 8px 0 0;">
<p style="margin:0;color:#4F46E5;font-size:18px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(identity.tradingName)}</p>
<p style="margin:6px 0 0;color:#f3f4f6;font-size:11px;letter-spacing:1px;text-transform:uppercase;">${t("headerDisbursed")}</p></td></tr>
<tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;">
<p style="margin:0 0 16px;font-size:16px;font-weight:bold;">${t("disbursedHeading")}</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("dear", { name })}</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">${t("disbursedBody", { ref })}</p>
<p style="margin:0;color:#888;font-size:12px;">${t("questions")} <a href="mailto:${escapeHtml(identity.publicEmail)}" style="color:#4F46E5;">${escapeHtml(identity.publicEmail)}</a></p>
</td></tr>
<tr><td style="background:#1B1D24;padding:18px 32px;border-radius:0 0 8px 8px;text-align:center;">
<p style="margin:0;color:#888;font-size:11px;">${identity.ncrNumber ? `NCR Registered Credit Provider &middot; ${escapeHtml(identity.ncrNumber)}` : escapeHtml(identity.legalName)}</p></td></tr>
</table></td></tr></table></body></html>`
}

export function overdueHtml(identity: LenderIdentity, name: string, days: number, ref: string): string {
  const daysText = days ? ` by <strong>${days} days</strong>` : ""
  // Quote the loan reference so a client paying by EFT/deposit puts it on the
  // payment and the bank-sync reconciler makes an EXACT match.
  const refLine = ref
    ? `<p style="margin:0 0 16px;color:#444;line-height:1.6;">Please quote your loan reference <strong>${ref}</strong> on your payment so we can allocate it to your account.</p>`
    : ""
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;font-size:14px;color:#1B1D24;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
<table style="max-width:600px;width:100%;" cellpadding="0" cellspacing="0">
<tr><td style="background:#1B1D24;padding:28px 32px;border-radius:8px 8px 0 0;">
<p style="margin:0;color:#4F46E5;font-size:18px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(identity.tradingName)}</p>
<p style="margin:6px 0 0;color:#f3f4f6;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Payment Overdue</p></td></tr>
<tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;">
<p style="margin:0 0 16px;font-size:16px;font-weight:bold;">Payment overdue notice</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">Dear <strong>${name}</strong>,</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">Your loan payment is overdue${daysText}. Please make payment as soon as possible to avoid additional fees and to protect your credit record.</p>
${refLine}
<p style="margin:0;color:#888;font-size:12px;">Questions? <a href="mailto:${escapeHtml(identity.publicEmail)}" style="color:#4F46E5;">${escapeHtml(identity.publicEmail)}</a></p>
</td></tr>
<tr><td style="background:#1B1D24;padding:18px 32px;border-radius:0 0 8px 8px;text-align:center;">
<p style="margin:0;color:#888;font-size:11px;">${identity.ncrNumber ? `NCR Registered Credit Provider &middot; ${escapeHtml(identity.ncrNumber)}` : escapeHtml(identity.legalName)}</p></td></tr>
</table></td></tr></table></body></html>`
}
