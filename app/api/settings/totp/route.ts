import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { generateTotpSecret, generateTotpUri, verifyTotpCode } from "@/lib/totp"
import { withTenantContext } from "@/lib/tenant"
import { getLenderBrandName } from "@/lib/config/identity"

// GET: generate a new TOTP secret for the current user
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  return withTenantContext(req, async (tenant) => {
    const secret = generateTotpSecret()
    const otpauth = generateTotpUri(session.user.email, secret, await getLenderBrandName(tenant.id))

    return NextResponse.json({ secret, otpauth })
  })
}

// POST: verify and enable TOTP
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  return withTenantContext(req, async () => {
    const body = await req.json() as { secret: string; code: string }
    if (!body.secret || !body.code) {
      return NextResponse.json({ error: "secret and code are required" }, { status: 400 })
    }

    const isValid = verifyTotpCode(body.code, body.secret)
    if (!isValid) {
      return NextResponse.json({ error: "Invalid verification code" }, { status: 422 })
    }

    await prisma.user.update({
      where: { id: session.user.id },
      data: { totpSecret: body.secret, totpEnabled: true },
    })

    return NextResponse.json({ ok: true })
  })
}

// DELETE: disable TOTP
export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  return withTenantContext(req, async () => {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { totpSecret: null, totpEnabled: false },
    })

    return NextResponse.json({ ok: true })
  })
}
