// The ASSET_FINANCE branch of the document template routes
// (app/api/documents/templates/**): the same URLs and LOAN_ADMIN guard as the
// custom letters, with the rules of ./store.ts.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getLenderIdentity, LenderIdentityError } from "@/lib/config/identity"
import type { StaffUser } from "@/lib/auth-guards"
import { parseContent } from "./content"
import { renderTemplatePreview } from "./preview"
import type { StoreResult, TemplateActor } from "./store"
import { validContent } from "./validate"

export function templateActor(user: Pick<StaffUser, "id" | "email" | "totpVerified">, tenantId: string): TemplateActor {
  return { tenantId, userId: user.id, userEmail: user.email, totpVerified: user.totpVerified }
}

export function storeResponse<T>(result: StoreResult<T>, status = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.value, { status })
  return NextResponse.json({ error: result.error, ...(result.problems ? { problems: result.problems } : {}) }, { status: result.status })
}

export const ASSET_TEMPLATE_FIXED = NextResponse.json(
  { error: "An asset-finance template's document is fixed; change its wording by saving a new draft version" },
  { status: 403 },
)

/**
 * The preview PDF of a saved version (`versionId`) or of unsaved `content`,
 * with the lender's identity, a synthetic deal and the DRAFT mark. A saved
 * version's content hash is returned in X-Template-Content-Sha256: the
 * approver posts it back, so an approval binds exactly what was previewed.
 */
export async function assetTemplatePreview(tenantId: string, template: { id: string; key: string }, body: { versionId?: unknown; content?: unknown }): Promise<NextResponse> {
  let text: string
  let sha: string | null = null
  if (typeof body.versionId === "string") {
    const version = await prisma.documentTemplateVersion.findFirst({ where: { id: body.versionId, templateId: template.id } })
    if (!version?.content) return NextResponse.json({ error: "Not found" }, { status: 404 })
    text = version.content
    sha = version.contentSha256
  } else {
    const content = parseContent(JSON.stringify(body.content ?? null))
    if (!content) return NextResponse.json({ error: "The wording is not in the template format" }, { status: 422 })
    text = JSON.stringify(content)
  }
  const checked = validContent(template.key, text)
  if (!checked.ok) return NextResponse.json({ error: "The wording cannot be previewed", problems: checked.problems }, { status: 422 })
  let lender
  try {
    lender = await getLenderIdentity(tenantId)
  } catch (error) {
    if (error instanceof LenderIdentityError) {
      return NextResponse.json({ error: `Complete your lender identity before previewing legal documents: ${error.message}` }, { status: 422 })
    }
    throw error
  }
  const pdf = await renderTemplatePreview(template.key, checked.content, lender)
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${template.key}-preview.pdf"`,
      "Cache-Control": "no-store",
      ...(sha ? { "X-Template-Content-Sha256": sha } : {}),
    },
  })
}
