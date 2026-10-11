import { NextRequest, NextResponse } from "next/server"
import { Channel, Prisma, TemplateCategory } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import {
  buildTemplateCreateComponents,
  templateLanguageProblem,
  templateNameProblem,
} from "@/lib/whatsapp/template-create"
import { submitTemplateForApproval, wabaFieldsChanged } from "@/lib/whatsapp/template-submit"

/**
 * Authoring endpoint for the WABA columns of a MessageTemplate — the writer the
 * registration chain depends on: without it every template's wabaTemplateName
 * stays null and none can register.
 *
 * Separate from the sibling POST that edits sms/email copy: that route sits at
 * the LOAN_ADMIN floor, while submitting a template to Meta for approval binds
 * the tenant's WABA account and is an ADMIN act. Keeping them apart also leaves
 * the existing editor's contract untouched.
 */

type WabaTemplateInput = {
  event?: unknown
  wabaTemplateName?: unknown
  language?: unknown
  category?: unknown
  headerContent?: unknown
  bodyTemplate?: unknown
  footer?: unknown
  buttons?: unknown
  active?: unknown
}

/**
 * Categories this editor may write. MARKETING is deliberately excluded: the
 * schema requires a `purposeRequired` consent purpose alongside it, and every
 * template registers with Meta as UTILITY (WABA_TEMPLATE_CATEGORY), which is
 * not a marketing class. Authoring a MARKETING row here would produce a
 * template whose consent lane and whose Meta class disagree.
 */
const AUTHORABLE_CATEGORIES = new Set<TemplateCategory>([
  TemplateCategory.SERVICE,
  TemplateCategory.TRANSACTIONAL,
])

/** Trimmed string, or "" for anything that is not a string. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Trimmed string, or null when absent/blank — the column's empty state. */
function optionalText(value: unknown): string | null {
  const trimmed = text(value)
  return trimmed === "" ? null : trimmed
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 })
}

/**
 * Why the save did or did not reach Meta. `unchanged` is the ONLY benign
 * non-submit — it means the template is already registered and nothing
 * review-relevant moved. Distinguishing it from a failure stops the editor
 * reporting "not resubmitted" in the same reassuring tone as a real success.
 */
type SubmitOutcome = {
  attempted: boolean
  ok: boolean
  reason: "unchanged" | "submitted" | "rejected"
  error?: string
}

export async function PUT(req: NextRequest): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  const body = (await req.json().catch(() => null)) as WabaTemplateInput | null
  if (!body || typeof body !== "object") return bad("Invalid body")

  const event = text(body.event)
  if (!event) return bad("event is required")

  // Required, not optional: a row with no Meta name can never register, and
  // the auto-submit gate below silently skips it — which would report a
  // template that will never send as a successful save.
  const wabaTemplateName = text(body.wabaTemplateName)
  const nameProblem = templateNameProblem(wabaTemplateName)
  if (nameProblem) return bad(`wabaTemplateName ${nameProblem}`)

  // No `|| "en"` default: silently choosing a language for a blank field means
  // registering a template in a language nobody chose.
  const language = text(body.language)
  const languageProblem = templateLanguageProblem(language)
  if (languageProblem) return bad(`language ${languageProblem}`)

  // Drives the consent lane in lib/messaging/eligibility.ts. A null category
  // matches no lane and every send is refused with NO_CONSENT_ON_FILE, so this
  // is required rather than defaulted — the lawful basis is not ours to guess.
  const category = body.category as TemplateCategory
  if (!AUTHORABLE_CATEGORIES.has(category)) {
    return bad(`category must be one of: ${[...AUTHORABLE_CATEGORIES].join(", ")}`)
  }

  const headerContent = optionalText(body.headerContent)
  const bodyTemplate = text(body.bodyTemplate)
  const footer = optionalText(body.footer)
  const buttons = body.buttons

  // The gate that makes this endpoint safe: build the exact CREATE-shape
  // payload Meta will receive, using the real builder rather than a re-check.
  // It validates the buttons blob too (buildButtonsComponent is its last step),
  // so one call covers header, body, footer and buttons. A template that cannot
  // register must never reach the database — a stored-but-unregisterable row
  // looks configured in the editor and silently never sends.
  try {
    buildTemplateCreateComponents({ bodyTemplate, headerContent, footer, buttons })
  } catch (err) {
    return bad(err instanceof Error ? err.message : "template is not valid for registration")
  }

  const active = typeof body.active === "boolean" ? body.active : true

  return withTenantContext(req, async (tenant) => {
    const where = {
      tenantId_event_channel: { tenantId: tenant.id, event, channel: Channel.WHATSAPP },
    }

    // Captured for the change guard below: a single upsert gives no before-image,
    // and re-submitting an unchanged template restarts Meta's review for nothing.
    const before = await prisma.messageTemplate.findUnique({ where })

    // The dispatcher (lib/notifications.ts) resolves templates by `key`, NOT by
    // (event, channel). A null-keyed row is invisible to it, and its
    // missing-template guard aborts the whole event — so an authored template
    // would silently kill the matching email and SMS sends too.
    //
    // But NEVER re-derive an existing key. A seeded key does not always follow
    // `<event>_whatsapp`: the old collections reminder row is
    // `payment_reminder_sent` keyed `payment_reminder_whatsapp`. Code looks rows
    // up by key literal (lib/collections/reminders.ts reads
    // `<waTemplateEvent>_whatsapp`, and a miss blocks that trigger's WhatsApp
    // leg), so re-keying a row on save would silently stop its sends.
    // Fill a MISSING key, preserve anything already there. `||` not `??`: a
    // blank key is as unreachable as a null one and cannot be a deliberate
    // choice, so it is repaired too — while any real key, derived or not,
    // survives untouched.
    const key = before?.key || `${event}_whatsapp`

    const wabaColumns = {
      wabaTemplateName,
      language,
      category,
      key,
      // buildTemplateCreateComponents only ever emits a TEXT header, so the
      // stored discriminator follows the header's presence rather than drifting.
      headerType: headerContent ? "TEXT" : null,
      headerContent,
      bodyTemplate,
      footer,
      // Json? column: DbNull writes SQL NULL, which is what the readers
      // (buildButtonsComponent / readSendButtons) treat as "no buttons".
      buttons: (buttons ?? Prisma.DbNull) as Prisma.InputJsonValue | Prisma.NullTypes.DbNull,
      active,
      // Legacy required column. Kept equal to bodyTemplate so a session-window
      // send (which reads `body`) and a template send (which reads
      // `bodyTemplate`) cannot show a borrower two different messages.
      body: bodyTemplate,
    }

    let template
    try {
      template = await prisma.messageTemplate.upsert({
        where,
        create: { tenantId: tenant.id, event, channel: Channel.WHATSAPP, ...wabaColumns },
        update: wabaColumns,
      })
    } catch (err) {
      // `key` carries its own @@unique([tenantId, key]). A clash means some
      // other row already owns it; without this the operator gets an opaque 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return NextResponse.json(
          { error: `another template already uses the key ${key}` },
          { status: 409 },
        )
      }
      throw err
    }

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "WABA_TEMPLATE_UPDATED",
      entity: "MessageTemplate",
      entityId: template.id,
      oldValue: before
        ? {
            wabaTemplateName: before.wabaTemplateName,
            language: before.language,
            // Recorded because `key` decides whether the dispatcher can reach
            // this template at all — a change to it is a change to whether the
            // event sends, so it must leave a trace.
            key: before.key,
            // Recorded because changing it changes the lawful basis the
            // eligibility engine applies to every future send.
            category: before.category,
            headerContent: before.headerContent,
            bodyTemplate: before.bodyTemplate,
            footer: before.footer,
            buttons: before.buttons,
            active: before.active,
          }
        : null,
      newValue: {
        wabaTemplateName, language, category, key, headerContent, bodyTemplate, footer,
        buttons: buttons ?? null, active,
      },
    })

    let submit: SubmitOutcome = { attempted: false, ok: false, reason: "unchanged" }
    let saved = template

    // Retry whenever the template is not actually registered, not only when a
    // field changed. wabaFieldsChanged knows what the operator edited; it knows
    // nothing about whether the last submission landed. Without the second
    // clause a failed submit is unrecoverable — every later save is a no-op,
    // and today the first submit always fails (WABA_ENC_KEY is unset).
    //
    // providerStatus is part of the test because createWabaTemplate falls back
    // to `id: ""` when Meta omits one: a blank id alone would read as "never
    // registered" and re-CREATE an already-approved template on every save,
    // collecting a "name already exists" rejection each time. A submit that
    // landed always set providerStatus, so the pair cannot both be empty.
    const neverRegistered = !template.providerTemplateId && !template.providerStatus
    if (wabaFieldsChanged(before, template) || neverRegistered) {
      try {
        await submitTemplateForApproval(tenant.id, template.id)
        // submitTemplateForApproval writes providerTemplateId/providerStatus on
        // its own row, so re-read rather than returning the pre-submit copy —
        // otherwise the editor shows a blank status until the next page load.
        saved = (await prisma.messageTemplate.findUnique({ where })) ?? template
        submit = { attempted: true, ok: true, reason: "submitted" }
      } catch (err) {
        // A Meta failure must not fail the local save — but it must not be
        // invisible either. The operator gets the rejection reason (Meta's own
        // message: no credentials are echoed) and can resubmit after fixing it.
        const message = err instanceof Error ? err.message : "submission failed"
        console.error("[settings/notifications/waba] template submit failed:", err)
        submit = { attempted: true, ok: false, reason: "rejected", error: message }
      }
    }

    return NextResponse.json({ template: saved, submit })
  })
}
