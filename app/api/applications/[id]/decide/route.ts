import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { decideApplication } from "./decide-application"

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await ctx.params

      let formData: FormData
      try {
        formData = await req.formData()
      } catch {
        return NextResponse.json(
          { error: "Expected multipart/form-data body" },
          { status: 400 }
        )
      }
      return decideApplication({ tenant, user: guard.user, id, formData })
    })
  } catch (error) {
    // A bare catch here discarded the cause entirely, so a failing decision
    // surfaced as an unattributable 500 with nothing in the logs.
    console.error("[decide] decision failed:", error)
    return NextResponse.json(
      { error: "Failed to process decision" },
      { status: 500 }
    )
  }
}
