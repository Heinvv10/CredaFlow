import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import bcrypt from "bcryptjs"

export async function POST(req: NextRequest) {
  const { token, password } = await req.json() as { token: string; password: string }

  if (!token || !password) {
    return NextResponse.json({ error: "Token and password are required" }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { resetToken: token },
    select: { id: true, resetTokenExp: true, active: true },
  })

  if (!user || !user.active) {
    return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 })
  }
  if (!user.resetTokenExp || user.resetTokenExp < new Date()) {
    return NextResponse.json({ error: "This reset link has expired. Please request a new one." }, { status: 400 })
  }

  const hashed = await bcrypt.hash(password, 12)

  // Bumping tokenVersion invalidates any existing JWT sessions for this user
  // — important because a password reset implies the old credentials may be
  // compromised.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashed,
      resetToken: null,
      resetTokenExp: null,
      tokenVersion: { increment: 1 },
    },
  })

  return NextResponse.json({ ok: true })
}

// Validate token (GET) — used to check before showing the form
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  if (!token) return NextResponse.json({ valid: false })

  const user = await prisma.user.findUnique({
    where: { resetToken: token },
    select: { id: true, name: true, resetTokenExp: true, active: true },
  })

  if (!user || !user.active || !user.resetTokenExp || user.resetTokenExp < new Date()) {
    return NextResponse.json({ valid: false })
  }

  return NextResponse.json({ valid: true, name: user.name })
}
