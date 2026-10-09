import { NextResponse, type NextRequest } from "next/server"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { hashDraftToken, verifyDraftToken } from "@/lib/insurance/disclosure-token"

const UPLOADS_ROOT = path.join(process.cwd(), "uploads", "disclosures")

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const guard = await requireApiRole("INSURANCE_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const blocked = await requireImsEnabled(tenant.id)
    if (blocked) return blocked

    const { token } = await params
    const verification = verifyDraftToken(token)
    if (!verification.ok) {
      return NextResponse.json({ error: verification.reason }, { status: 422 })
    }
    if (verification.payload.tenantId !== tenant.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 })
    }
    // TWO on-disk naming schemes, both derived from the token:
    //
    //   <sha256(token)>.pdf  — quote disclosures. A token carrying a quoteId
    //                          exceeds the 255-byte filename limit, so the
    //                          hash is used; it is fixed-length whatever the
    //                          payload grows to.
    //   <payload>.<sig>.pdf  — legacy single-life drafts, named after the whole
    //                          token. Still served, so disclosures already on
    //                          disk keep resolving. Do NOT split on "." to
    //                          derive a base name: the token itself has a dot.
    //
    // The URL is identical in both cases; only the storage name differs.
    const candidates = [
      path.join(UPLOADS_ROOT, tenant.id, `${hashDraftToken(token)}.pdf`),
      path.join(UPLOADS_ROOT, tenant.id, `${token}.pdf`),
    ]
    for (const filePath of candidates) {
      try {
        const buf = await readFile(filePath)
        return new NextResponse(buf, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
      } catch {
        // Try the next naming scheme.
      }
    }
    return NextResponse.json({ error: "not found" }, { status: 404 })
  })
}
