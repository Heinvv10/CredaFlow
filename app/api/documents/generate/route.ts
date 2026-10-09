import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import {
  generateDocument,
  MissingTokenError,
  SystemGenerationNotAllowedError,
  TemplateUnavailableError,
} from "@/lib/documents/render"

/**
 * Generates a document for a client from a catalogue **CUSTOM** template
 * and persists it as a `ClientDocument` (see `lib/documents/render.ts`).
 * Never returns the raw PDF bytes here — callers fetch the rendered
 * document via the existing `app/api/documents/[id]/view/route.ts`, which
 * POPIA-logs the access. Gated at CREDIT_OFFICER: this persists a
 * ClientDocument (PII) and can trigger a signing workflow, so it sits
 * above a read-only role; a CLIENT session is not in the staff role
 * hierarchy and is rejected with 403 by `requireApiRole`.
 *
 * SYSTEM templates (credit agreement, Section 129 — NCA-mandated legal
 * documents) are explicitly excluded via `allowSystem: false`: they must
 * only be generated through their dedicated, higher-gated routes
 * (`app/api/applications/[id]/agreement/route.ts` = CREDIT_OFFICER,
 * `app/api/loans/section129/route.ts` = COLLECTIONS_OFFICER). Without this,
 * a staff member could bypass those role checks by calling this generic
 * route with a SYSTEM `templateKey`.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json()) as {
      templateKey?: string
      clientId?: string
      loanId?: string
      applicationId?: string
    }

    if (!body.templateKey?.trim() || !body.clientId?.trim()) {
      return NextResponse.json(
        { error: "templateKey and clientId are required" },
        { status: 400 }
      )
    }

    try {
      const { clientDocumentId } = await generateDocument({
        tenantId: tenant.id,
        templateKey: body.templateKey,
        clientId: body.clientId,
        loanId: body.loanId,
        applicationId: body.applicationId,
        staffUserId: guard.user.id,
        allowSystem: false,
      })
      return NextResponse.json({ clientDocumentId })
    } catch (e) {
      if (e instanceof TemplateUnavailableError) {
        return NextResponse.json(
          { error: "This document template is not published and available for generation." },
          { status: 409 }
        )
      }
      if (e instanceof MissingTokenError) {
        return NextResponse.json(
          { error: "Missing required fields", missing: e.missing },
          { status: 422 }
        )
      }
      if (e instanceof SystemGenerationNotAllowedError) {
        return NextResponse.json(
          { error: "System documents must be generated via their dedicated routes" },
          { status: 403 }
        )
      }
      if (e instanceof Error && /not found/i.test(e.message)) {
        return NextResponse.json({ error: e.message }, { status: 404 })
      }
      throw e
    }
  })
}
