import { prisma } from "@/lib/prisma"
import { createWabaTemplate } from "./graph-templates"
import { buildTemplateCreateComponents, WABA_TEMPLATE_CATEGORY } from "./template-create"
import { getWabaTemplateCreds } from "@/lib/whatsapp-cloud-config"

type WabaFields = {
  wabaTemplateName: string | null
  language: string
  headerContent: string | null
  bodyTemplate: string | null
  footer: string | null
  buttons: unknown
}

const WABA_FIELDS: Array<keyof WabaFields> = [
  "wabaTemplateName", "language", "headerContent", "bodyTemplate", "footer", "buttons",
]

/** True when a Meta-review-relevant field changed (avoids needless re-submits). */
export function wabaFieldsChanged(before: WabaFields | null, after: WabaFields): boolean {
  if (!before) return true
  return WABA_FIELDS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}

/**
 * Submits a stored WABA template to Meta for approval and records the returned
 * providerTemplateId + providerStatus (PENDING). No-op for templates without a
 * wabaTemplateName. Category maps our product taxonomy → Meta's coarse buckets;
 * marketing-class templates carry higher per-message cost (see PRD cost model).
 */
export async function submitTemplateForApproval(
  tenantId: string,
  templateId: string,
): Promise<{ submitted: boolean; providerStatus?: string }> {
  const t = await prisma.messageTemplate.findUnique({ where: { id: templateId, tenantId } })
  if (!t || !t.wabaTemplateName) return { submitted: false }

  // All Phase 2 templates register as UTILITY. Marketing-class mapping is
  // deferred (Open item #2) — refine when marketing templates are defined.
  // Shared with the editor's payload preview so the two cannot disagree.
  const category = WABA_TEMPLATE_CATEGORY
  // Meta's CREATE endpoint takes the DEFINITION shape (positional {{1}} text +
  // example values) — deliberately not the send-time parameter shape. An
  // untranslatable buttons value throws rather than being dropped, so Meta
  // never approves a template the operator did not actually author. Built
  // before the credential read so an invalid template costs no decrypt.
  const components = buildTemplateCreateComponents({
    bodyTemplate: t.bodyTemplate,
    headerContent: t.headerContent,
    footer: t.footer,
    buttons: t.buttons,
  })

  const creds = await getWabaTemplateCreds(tenantId)
  const created = await createWabaTemplate(creds, {
    name: t.wabaTemplateName,
    language: t.language,
    category,
    components,
  })

  await prisma.messageTemplate.update({
    where: { id: templateId, tenantId },
    data: { providerTemplateId: created.id, providerStatus: "PENDING" },
  })
  return { submitted: true, providerStatus: "PENDING" }
}
