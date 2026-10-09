import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import type { Session } from "next-auth"

function isAuthorized(req: NextRequest, session: Session | null): boolean {
  if (session?.user?.role !== "SUPER_ADMIN") return false
  const adminSecret = req.headers.get("x-admin-secret")
  const envSecret = process.env.ADMIN_SECRET
  if (!envSecret) return false
  return adminSecret === envSecret
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!isAuthorized(req, session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const tenants = await prisma.tenant.findMany({
    include: { config: true },
    orderBy: { createdAt: "asc" },
  })

  return NextResponse.json(tenants)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!isAuthorized(req, session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: {
    slug: string
    name: string
    domain?: string
    primaryColor?: string
    secondaryColor?: string
    darkColor?: string
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.slug || !body.name) {
    return NextResponse.json({ error: "slug and name are required" }, { status: 400 })
  }

  const existing = await prisma.tenant.findUnique({ where: { slug: body.slug } })
  if (existing) {
    return NextResponse.json({ error: "Tenant slug already exists" }, { status: 409 })
  }

  const tenant = await prisma.tenant.create({
    data: {
      slug: body.slug,
      name: body.name,
      domain: body.domain ?? null,
      status: "PROVISIONING",
      config: {
        create: {
          primaryColor: body.primaryColor ?? "#4F46E5",
          secondaryColor: body.secondaryColor ?? "#4338CA",
          darkColor: body.darkColor ?? "#0B0D12",
        },
      },
    },
    include: { config: true },
  })

  return NextResponse.json(tenant, { status: 201 })
}
