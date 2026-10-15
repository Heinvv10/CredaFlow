import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { hashDraftToken, verifyDraftToken } from "@/lib/insurance/disclosure-token"
import { readFile, storagePathAt } from "@/lib/storage"

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
    // Read through lib/storage: the PDFs are encrypted at rest like every other
    // upload. Only a missing file moves on to the next scheme; a file that fails
    // its integrity check is an error (fail closed), never skipped past.
    const candidates = [
      `disclosures/${tenant.id}/${hashDraftToken(token)}.pdf`,
      `disclosures/${tenant.id}/${token}.pdf`,
    ]
    for (const relative of candidates) {
      try {
        const buf = await readFile(storagePathAt(relative))
        return new NextResponse(new Uint8Array(buf), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    return NextResponse.json({ error: "not found" }, { status: 404 })
  })
}
