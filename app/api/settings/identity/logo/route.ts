import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { LOGO_MAX_BYTES, getLenderLogo, removeLenderLogo, setLenderLogo } from "@/lib/config/lender-logo"

// The letterhead logo prints on every NCA document, so changing it carries the
// same guard as PUT /api/settings/identity: ADMIN, and a sign-in that verified
// a TOTP code (see that route for why the claim, not the account flag).
const WRITE_ROLE = "ADMIN"

/**
 * The request body, or null once it passes `cap` bytes. Read chunk by chunk so
 * a body that declares no length (chunked) is cut off at the cap rather than
 * buffered whole.
 */
async function readBodyCapped(req: NextRequest, cap: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

function totpRequired() {
  return NextResponse.json(
    { error: "Sign in with two-factor authentication to change the logo. Enable it under Settings → Security, then sign out and back in." },
    { status: 403 },
  )
}

/** The logo for the staff shell. Any signed-in staff member; never public. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const bytes = await getLenderLogo(tenant.id)
    if (!bytes) return NextResponse.json({ error: "No logo is set." }, { status: 404 })
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    })
  })
}

/** Body: the PNG bytes. Validated by content (lib/config/lender-logo.ts), not by any declared type. */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole(WRITE_ROLE)
  if (guard.error) return guard.error
  if (guard.user.totpVerified !== true) return totpRequired()

  return withTenantContext(req, async (tenant) => {
    const declared = Number(req.headers.get("content-length") ?? 0)
    if (declared > LOGO_MAX_BYTES) return NextResponse.json({ error: "The logo must be at most 512 KB." }, { status: 413 })
    const bytes = await readBodyCapped(req, LOGO_MAX_BYTES)
    if (!bytes) return NextResponse.json({ error: "The logo must be at most 512 KB." }, { status: 413 })

    try {
      const result = await setLenderLogo(prisma, {
        tenantId: tenant.id,
        actor: { id: guard.user.id, email: guard.user.email },
        bytes,
        ipAddress: callerIp(req),
      })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      return NextResponse.json(result)
    } catch (e) {
      console.error("Failed to store the lender logo:", e)
      return NextResponse.json({ error: "Failed to store the logo" }, { status: 500 })
    }
  })
}

export async function DELETE(req: NextRequest) {
  const guard = await requireApiRole(WRITE_ROLE)
  if (guard.error) return guard.error
  if (guard.user.totpVerified !== true) return totpRequired()

  return withTenantContext(req, async (tenant) => {
    try {
      return NextResponse.json(await removeLenderLogo(prisma, {
        tenantId: tenant.id,
        actor: { id: guard.user.id, email: guard.user.email },
        ipAddress: callerIp(req),
      }))
    } catch (e) {
      console.error("Failed to remove the lender logo:", e)
      return NextResponse.json({ error: "Failed to remove the logo" }, { status: 500 })
    }
  })
}
