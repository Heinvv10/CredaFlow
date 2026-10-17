/**
 * The message templates a new tenant starts with, and the function the seed
 * calls to create them.
 *
 * These rows used to be written by data migrations, for one named tenant only,
 * so a database built from the migrations had none. They are seeded per
 * tenant instead. Wherever the copy names the lender it carries
 * SEED_BRAND_TOKEN, which the seed replaces with the tenant's brand
 * (`brandName ?? tenant.name`, as the SMS copy does): it is not a send-time
 * variable, so a stored row never contains it.
 *
 * Not seeded: `section129_email`. Its body was the forked lender's statutory
 * notice. The S129 email path (MESSAGING_NEW_SEND_S129) refuses with
 * "template not found" until a tenant creates one with its own identity.
 *
 * WhatsApp bodies come from WABA_BODY_TEMPLATES, so the stored row and the
 * variables the code supplies cannot drift (template-vars-contract.test.ts).
 */
import type { Channel, PrismaClient, TemplateCategory } from "@prisma/client"
import { SEED_BRAND_TOKEN, WABA_BODY_TEMPLATES, withSeededBrand } from "@/lib/whatsapp/template-vars"
import { OTP_MESSAGE_TEMPLATES } from "./otp-templates"

export type DefaultMessageTemplate = {
  key: string
  event: string
  channel: Channel
  category: TemplateCategory
  subject?: string
  body: string
  bodyTemplate?: string
  statutoryOverride?: boolean
  redactStoredBody?: boolean
  wabaTemplateName?: string
}

export const DEFAULT_MESSAGE_TEMPLATES: readonly DefaultMessageTemplate[] = [
  {
    key: "asset_finance_rate_notice_email", event: "asset_finance_rate_notice", channel: "EMAIL", category: "SERVICE",
    subject: "{{subject}}", body: "{{text}}", bodyTemplate: "{{html}}",
    statutoryOverride: false,
  },
  {
    key: "asset_finance_rate_notice_nca_email", event: "asset_finance_rate_notice_nca", channel: "EMAIL", category: "SERVICE",
    subject: "{{subject}}", body: "{{text}}", bodyTemplate: "{{html}}",
    statutoryOverride: true,
  },
  {
    key: "agent_reengagement_whatsapp", event: "agent_reengagement", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.agent_reengagement, bodyTemplate: WABA_BODY_TEMPLATES.agent_reengagement,
    wabaTemplateName: "agent_reengagement",
  },
  {
    key: "agreement_delivery_email", event: "agreement_delivery", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "Your signed credit agreement — {{applicationReference}}",
    body: "Attached is your copy of the signed credit agreement {{applicationReference}}. Please keep it for your records.",
    bodyTemplate: "<p>Good day{{greeting}},</p>\n<p>Attached is your copy of the credit agreement you signed with {{lenderName}}, countersigned by the credit provider. Please keep it for your records.</p>\n<p>If anything in it looks wrong, contact your consultant before your first repayment date.</p>\n<p>{{lenderName}}</p>",
    statutoryOverride: true,
  },
  {
    key: "application_declined_email", event: "application_declined", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "{{subject}}",
    body: "{{text}}",
    bodyTemplate: "{{html}}",
  },
  {
    key: "application_declined_sms", event: "application_declined", channel: "SMS", category: "TRANSACTIONAL",
    body: "{{body}}",
  },
  {
    key: "application_declined_whatsapp", event: "application_declined", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: WABA_BODY_TEMPLATES.application_declined, bodyTemplate: WABA_BODY_TEMPLATES.application_declined,
  },
  {
    key: "application_submitted_email", event: "application_submitted", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "{{subject}}",
    body: "{{text}}",
    bodyTemplate: "{{html}}",
  },
  {
    key: "application_submitted_sms", event: "application_submitted", channel: "SMS", category: "TRANSACTIONAL",
    body: "{{body}}",
  },
  {
    key: "application_submitted_whatsapp", event: "application_submitted", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: WABA_BODY_TEMPLATES.application_submitted, bodyTemplate: WABA_BODY_TEMPLATES.application_submitted,
  },
  {
    key: "loan_approved_email", event: "loan_approved", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "{{subject}}",
    body: "{{text}}",
    bodyTemplate: "{{html}}",
  },
  {
    key: "loan_approved_sms", event: "loan_approved", channel: "SMS", category: "TRANSACTIONAL",
    body: "{{body}}",
  },
  {
    key: "loan_approved_whatsapp", event: "loan_approved", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: WABA_BODY_TEMPLATES.loan_approved, bodyTemplate: WABA_BODY_TEMPLATES.loan_approved,
  },
  {
    key: "entity_payment_due_whatsapp", event: "entity_payment_due", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.entity_payment_due, bodyTemplate: WABA_BODY_TEMPLATES.entity_payment_due,
    wabaTemplateName: "entity_payment_due",
  },
  {
    key: "entity_payment_overdue_whatsapp", event: "entity_payment_overdue", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.entity_payment_overdue, bodyTemplate: WABA_BODY_TEMPLATES.entity_payment_overdue,
    wabaTemplateName: "entity_payment_overdue",
  },
  {
    key: "entity_payment_received_email", event: "entity_payment_received", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "{{subject}}",
    body: "{{text}}",
    bodyTemplate: "{{html}}",
  },
  {
    key: "entity_payment_received_whatsapp", event: "entity_payment_received", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: WABA_BODY_TEMPLATES.entity_payment_received, bodyTemplate: WABA_BODY_TEMPLATES.entity_payment_received,
    wabaTemplateName: "entity_payment_received",
  },
  {
    key: "entity_reminder_email", event: "entity_reminder", channel: "EMAIL", category: "SERVICE",
    subject: "{{subject}}",
    body: "{{text}}",
    bodyTemplate: "{{html}}",
  },
  {
    key: "loan_disbursed_email", event: "loan_disbursed", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "{{subject}}",
    body: "{{text}}",
    bodyTemplate: "{{html}}",
  },
  {
    key: "loan_disbursed_sms", event: "loan_disbursed", channel: "SMS", category: "TRANSACTIONAL",
    body: "{{body}}",
  },
  {
    key: "loan_disbursed_whatsapp", event: "loan_disbursed", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: WABA_BODY_TEMPLATES.loan_disbursed, bodyTemplate: WABA_BODY_TEMPLATES.loan_disbursed,
  },
  {
    key: "loan_overdue_1d_whatsapp", event: "loan_overdue_1d", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.loan_overdue_1d, bodyTemplate: WABA_BODY_TEMPLATES.loan_overdue_1d,
    wabaTemplateName: "loan_overdue_1d",
  },
  {
    key: "loan_overdue_7d_whatsapp", event: "loan_overdue_7d", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.loan_overdue_7d, bodyTemplate: WABA_BODY_TEMPLATES.loan_overdue_7d,
    wabaTemplateName: "loan_overdue_7d",
  },
  {
    key: "loan_overdue_email", event: "loan_overdue", channel: "EMAIL", category: "SERVICE",
    subject: "{{subject}}",
    body: "{{text}}",
    bodyTemplate: "{{html}}",
  },
  {
    key: "loan_overdue_sms", event: "loan_overdue", channel: "SMS", category: "SERVICE",
    body: "{{body}}",
  },
  {
    key: "loan_overdue_whatsapp", event: "loan_overdue", channel: "WHATSAPP", category: "SERVICE",
    body: "{{body}}",
  },
  {
    key: "pasq_link_email", event: "pasq_link_email", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "Your pre-agreement statement and quotation",
    body: "{{lenderName}}: your pre-agreement statement and quotation is ready. Open and confirm it here: {{url}} (link expires in 48 hours).",
    bodyTemplate: "<p>Good day{{greeting}},</p>\n<p>Your pre-agreement statement and quotation from {{lenderName}} is ready. A copy is attached to this email for your records.</p>\n<p>Please open the secure link below to review and confirm that you received it:</p>\n<p><a href=\"{{url}}\">{{url}}</a></p>\n<p>The link expires in 48 hours and can only be used once. If it expires, your consultant can send a new one.</p>\n<p>{{lenderName}}</p>",
    statutoryOverride: true, redactStoredBody: true,
  },
  {
    key: "pasq_link_sms", event: "pasq_link_sms", channel: "SMS", category: "TRANSACTIONAL",
    body: "{{lenderName}}: your pre-agreement statement and quotation is ready. Open and confirm it here: {{url}} (link expires in 48 hours).",
    statutoryOverride: true, redactStoredBody: true,
  },
  {
    key: "pasq_link_whatsapp", event: "pasq_link_whatsapp", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: "{{lenderName}}: your pre-agreement statement and quotation is ready. Open and confirm it here: {{url}} (link expires in 48 hours).",
    redactStoredBody: true,
  },
  {
    key: "payment_due_3d_whatsapp", event: "payment_due_3d", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.payment_due_3d, bodyTemplate: WABA_BODY_TEMPLATES.payment_due_3d,
    wabaTemplateName: "payment_due_3d",
  },
  {
    key: "payment_received_email", event: "payment_received", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "{{subject}}",
    body: "{{text}}",
    bodyTemplate: "{{html}}",
  },
  {
    key: "payment_received_sms", event: "payment_received", channel: "SMS", category: "TRANSACTIONAL",
    body: "{{body}}",
  },
  {
    key: "payment_received_whatsapp", event: "payment_received", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: WABA_BODY_TEMPLATES.payment_received, bodyTemplate: WABA_BODY_TEMPLATES.payment_received,
  },
  {
    key: "payment_reminder_0d_v2_whatsapp", event: "payment_reminder_0d_v2", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.payment_reminder_0d_v2, bodyTemplate: WABA_BODY_TEMPLATES.payment_reminder_0d_v2,
    wabaTemplateName: "payment_reminder_0d_v2",
  },
  {
    key: "payment_reminder_0d_v3_whatsapp", event: "payment_reminder_0d_v3", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.payment_reminder_0d_v3, bodyTemplate: WABA_BODY_TEMPLATES.payment_reminder_0d_v3,
    wabaTemplateName: "payment_reminder_0d_v3",
  },
  {
    key: "payment_reminder_0d_whatsapp", event: "payment_reminder_0d", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.payment_reminder_0d, bodyTemplate: WABA_BODY_TEMPLATES.payment_reminder_0d,
    wabaTemplateName: "payment_reminder_0d",
  },
  {
    key: "payment_reminder_1d_whatsapp", event: "payment_reminder_1d", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.payment_reminder_1d, bodyTemplate: WABA_BODY_TEMPLATES.payment_reminder_1d,
    wabaTemplateName: "payment_reminder_1d",
  },
  {
    key: "payment_reminder_7d_whatsapp", event: "payment_reminder_7d", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.payment_reminder_7d, bodyTemplate: WABA_BODY_TEMPLATES.payment_reminder_7d,
    wabaTemplateName: "payment_reminder_7d",
  },
  {
    key: "payment_reminder_overdue_1d_whatsapp", event: "payment_reminder_overdue_1d", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.payment_reminder_overdue_1d, bodyTemplate: WABA_BODY_TEMPLATES.payment_reminder_overdue_1d,
    wabaTemplateName: "payment_reminder_overdue_1d",
  },
  {
    key: "payment_reminder_overdue_3d_whatsapp", event: "payment_reminder_overdue_3d", channel: "WHATSAPP", category: "SERVICE",
    body: WABA_BODY_TEMPLATES.payment_reminder_overdue_3d, bodyTemplate: WABA_BODY_TEMPLATES.payment_reminder_overdue_3d,
    wabaTemplateName: "payment_reminder_overdue_3d",
  },
  {
    key: "payment_reminder_sms", event: "payment_reminder_sent", channel: "SMS", category: "SERVICE",
    body: "{{body}}",
  },
  {
    key: "payment_reminder_whatsapp", event: "payment_reminder_sent", channel: "WHATSAPP", category: "SERVICE",
    body: "{{body}}",
  },
  {
    key: "portal_activation_email", event: "portal_activation", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "Activate Your {{lenderName}} Portal Account",
    body: "Your {{lenderName}} portal activation code is: {{otp}}. It expires in 15 minutes.",
    bodyTemplate: "<div style=\"font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f8f9fb;border-radius:8px;\">\n  <div style=\"text-align:center;margin-bottom:24px;\">\n    <p style=\"font-size:11px;font-weight:bold;letter-spacing:4px;text-transform:uppercase;color:#4F46E5;\">{{lenderName}}</p>\n    <p style=\"font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-top:4px;\">CLIENT PORTAL</p>\n  </div>\n  <h2 style=\"color:#1B1D24;margin-bottom:8px;\">Activate Your Portal Account</h2>\n  <p style=\"color:#555;margin-bottom:24px;\">Hi {{firstName}}, use the code below to activate your portal account. It expires in 15 minutes.</p>\n  <div style=\"background:#1B1D24;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px;\">\n    <p style=\"color:#4F46E5;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;\">Your activation code</p>\n    <p style=\"color:#fff;font-size:36px;font-weight:bold;letter-spacing:8px;margin:0;\">{{otp}}</p>\n  </div>\n  <p style=\"color:#888;font-size:12px;\">If you did not request to activate a portal account, you can safely ignore this email.</p>\n</div>",
    redactStoredBody: true,
  },
  {
    key: "portal_forgot_password_email", event: "portal_forgot_password", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "Your {{lenderName}} Portal Password Reset Code",
    body: "Your {{lenderName}} portal password reset code is: {{otp}}. It expires in 15 minutes.",
    bodyTemplate: "<div style=\"font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f8f9fb;border-radius:8px;\">\n  <div style=\"text-align:center;margin-bottom:24px;\">\n    <p style=\"font-size:11px;font-weight:bold;letter-spacing:4px;text-transform:uppercase;color:#4F46E5;\">{{lenderName}}</p>\n    <p style=\"font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-top:4px;\">CLIENT PORTAL</p>\n  </div>\n  <h2 style=\"color:#1B1D24;margin-bottom:8px;\">Password Reset Request</h2>\n  <p style=\"color:#555;margin-bottom:24px;\">Hi {{firstName}}, use the code below to reset your portal password. It expires in 15 minutes.</p>\n  <div style=\"background:#1B1D24;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px;\">\n    <p style=\"color:#4F46E5;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;\">Your reset code</p>\n    <p style=\"color:#fff;font-size:36px;font-weight:bold;letter-spacing:8px;margin:0;\">{{otp}}</p>\n  </div>\n  <p style=\"color:#888;font-size:12px;\">If you did not request a password reset, you can safely ignore this email.</p>\n</div>",
    redactStoredBody: true,
  },
  ...OTP_MESSAGE_TEMPLATES,
]

/** The template as stored for a tenant whose brand is `lenderName`. */
export function defaultTemplateForTenant(t: DefaultMessageTemplate, lenderName: string): DefaultMessageTemplate {
  const brand = (v: string | undefined) => (v === undefined ? undefined : withSeededBrand(v, lenderName))
  return { ...t, subject: brand(t.subject), body: brand(t.body)!, bodyTemplate: brand(t.bodyTemplate) }
}

/**
 * Create every default template the tenant lacks, as the old SQL seed's
 * `ON CONFLICT DO NOTHING` did. A default is skipped when the tenant already
 * has a row with the same `key` OR the same (event, channel) — the Settings UI
 * writes key-less rows, and an operator may re-key one, and either would make
 * the create violate a unique. Existing rows are never updated.
 */
export async function seedDefaultMessageTemplates(
  db: Pick<PrismaClient, "messageTemplate">,
  tenantId: string,
  lenderName: string,
): Promise<void> {
  if (!lenderName.trim() || lenderName.includes(SEED_BRAND_TOKEN)) {
    throw new Error("seedDefaultMessageTemplates: lenderName is required")
  }
  for (const t of DEFAULT_MESSAGE_TEMPLATES) {
    const existing = await db.messageTemplate.findFirst({
      where: { tenantId, OR: [{ key: t.key }, { event: t.event, channel: t.channel }] },
      select: { id: true },
    })
    if (existing) continue
    await db.messageTemplate.create({ data: { tenantId, ...defaultTemplateForTenant(t, lenderName) } })
  }
}
