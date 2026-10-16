import { NextRequest, NextResponse } from "next/server"
import { getDocumentCaller } from "@/lib/document-auth"
import { withTenantContextLoggingRefusal } from "@/lib/documents/tenant-refusal"
import { refuseReadOnlyDocumentWrite } from "@/lib/documents/write-access"
import { captureSelfie, type SelfieUploader } from "@/lib/kyc/selfie-capture.server"

/**
 * Authenticated selfie capture (staff tab and portal upload).
 *
 * The pipeline itself lives in lib/kyc/selfie-capture.server.ts because the
 * consumer capture-link route runs the identical one. What stays here is the
 * part that is genuinely this route's: proving who the caller is.
 */
export async function POST(req: NextRequest) {
  const caller = await getDocumentCaller()
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return withTenantContextLoggingRefusal(req, { documentId: "selfie", caller }, async (tenant) => {
    const readOnly = await refuseReadOnlyDocumentWrite({ caller, documentId: "selfie", tenantId: tenant.id, action: "selfie", req })
    if (readOnly) return readOnly

    // The original handler wrapped everything from formData parsing onward in
    // this try/catch. A malformed multipart body throws inside req.formData(),
    // and without the catch it escapes as an unstructured 500 instead of the
    // JSON error every client of this route expects.
    try {
      const formData = await req.formData()
      const image = formData.get("image") as File | null
      const clientIdParam = formData.get("clientId") as string | null

      const uploader: SelfieUploader = caller.type === "client"
        ? { type: "client", clientId: caller.clientId, email: caller.email }
        : { type: "staff", userId: caller.userId }

      const result = await captureSelfie({
        tenantId: tenant.id,
        // A client uploads only for themselves; a staff caller must name the
        // client, and captureSelfie refuses a null one in the original's
        // position (after the image checks).
        clientId: caller.type === "client" ? caller.clientId : clientIdParam,
        image,
        uploader,
      })
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status })
      }
      return NextResponse.json(result.document, { status: 201 })
    } catch (error) {
      console.error("Selfie upload failed:", error)
      return NextResponse.json({ error: "Failed to upload selfie" }, { status: 500 })
    }
  })
}
