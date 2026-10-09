import { NextResponse } from "next/server"
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { isValidSaPhone } from "@/lib/validation/client-wizard"

// Fields a client may self-edit from /portal/profile. `email` is deliberately
// excluded — it is the auth-session identity and changing it without a
// verification flow risks lockout. Changes to email/banking go through staff
// support. `clientId` on the request body is ignored: the row is always
// resolved from session.user.email, blocking cross-client IDOR.
const NULLABLE_KEYS = [
  "whatsapp",
  "addressLine1",
  "suburb",
  "city",
  "province",
  "postalCode",
] as const

const EDITABLE_KEYS = ["phone", ...NULLABLE_KEYS] as const

type EditableKey = (typeof EDITABLE_KEYS)[number]

function normalizeString(value: unknown, { nullable }: { nullable: boolean }): string | null | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed === "") return nullable ? null : ""
  return trimmed
}

export async function PUT(req: Request) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const requested: Partial<Record<EditableKey, string | null>> = {}
  for (const key of EDITABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue
    const nullable = key !== "phone"
    const value = normalizeString(body[key], { nullable })
    if (value === undefined) {
      return NextResponse.json({ error: `${key} must be a string.` }, { status: 400 })
    }
    if (key === "phone" && (value === null || !isValidSaPhone(value))) {
      return NextResponse.json(
        { error: "phone must be a South African mobile number (e.g. 0821234567 or +27821234567)." },
        { status: 400 },
      )
    }
    if (key === "whatsapp" && value !== null && !isValidSaPhone(value)) {
      return NextResponse.json(
        { error: "whatsapp must be a South African mobile number (e.g. 0821234567 or +27821234567)." },
        { status: 400 },
      )
    }
    requested[key] = value
  }

  if (Object.keys(requested).length === 0) {
    return NextResponse.json({ error: "No editable fields provided." }, { status: 400 })
  }

  return withTenantContext(req, async (tenant) => {
    const existing = await prisma.client.findFirst({
      where: { email: session.user.email!, tenantId: tenant.id },
      select: {
        id: true,
        phone: true,
        whatsapp: true,
        addressLine1: true,
        suburb: true,
        city: true,
        province: true,
        postalCode: true,
      },
    })
    if (!existing) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 })
    }

    // Build the DB update payload from CHANGED keys only — writing unchanged
    // columns would dirty-stamp Client.updatedAt for fields that didn't move,
    // which muddies "when was X last changed" audits on a regulated lender.
    const update: Prisma.ClientUpdateInput = {}
    const oldValue: Record<string, string | null> = {}
    const newValue: Record<string, string | null> = {}
    for (const key of EDITABLE_KEYS) {
      if (!(key in requested)) continue
      const before = existing[key] ?? null
      const after = requested[key] ?? null
      if (before === after) continue
      if (key === "phone") {
        // phone is non-nullable; the validation above guarantees a non-empty string here.
        update.phone = after as string
      } else {
        update[key] = after
      }
      oldValue[key] = before
      newValue[key] = after
    }

    if (Object.keys(newValue).length === 0) {
      return NextResponse.json({ ok: true, changed: false })
    }

    await prisma.client.update({
      where: { id: existing.id },
      data: update,
    })

    await logAudit({
      tenantId: tenant.id,
      userEmail: session.user.email!,
      action: AuditAction.CLIENT_UPDATED,
      entity: "Client",
      entityId: existing.id,
      oldValue,
      newValue,
    })

    return NextResponse.json({ ok: true, changed: true })
  })
}
