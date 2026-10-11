import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { sealField } from "@/lib/email/secrets"
import { inboundHostAllowed } from "@/lib/email/inbound-host-guard"
import { getLenderBrandName } from "@/lib/config/identity"

const MASK = "••••••••"
const SECRET_FIELDS = ["clientSecret", "smtpPass", "imapPass"] as const

// Mask secrets for display. Applies to the stored value whether it is sealed
// (enc:v1:…) or a legacy plaintext row — the client is never shown either.
function maskConfig(cfg: Record<string, unknown>) {
  const masked = { ...cfg }
  for (const f of SECRET_FIELDS) {
    if (masked[f]) masked[f] = MASK
  }
  return masked
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const config = await prisma.emailConfig.findUnique({ where: { tenantId: tenant.id } })
    return NextResponse.json(config ? maskConfig(config as unknown as Record<string, unknown>) : null)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    const body = await req.json()

    // Don't overwrite secrets if placeholder sent. The stored value is already
    // sealed, and sealField is idempotent, so it survives this round trip.
    const existing = await prisma.emailConfig.findUnique({ where: { tenantId: tenant.id } })
    const safeBody = { ...body }
    if (safeBody.clientSecret === MASK) safeBody.clientSecret = existing?.clientSecret
    if (safeBody.smtpPass === MASK) safeBody.smtpPass = existing?.smtpPass
    if (safeBody.imapPass === MASK) safeBody.imapPass = existing?.imapPass

    // Refuse to STORE a mailbox this environment may not poll. Catching it here
    // means an operator never gets a config that silently fails later.
    const imapHost = safeBody.imapHost || null
    if (imapHost) {
      const decision = inboundHostAllowed(imapHost)
      if (!decision.allowed) {
        return NextResponse.json({ error: decision.reason }, { status: 400 })
      }
    }

    // Seal before write. FAILS CLOSED: with no WABA_ENC_KEY this throws and the
    // request 500s rather than writing a mail password in plaintext.
    let secrets: { clientSecret: string | null; smtpPass: string | null; imapPass: string | null }
    try {
      secrets = {
        clientSecret: (sealField(safeBody.clientSecret) as string | null | undefined) || null,
        smtpPass: (sealField(safeBody.smtpPass) as string | null | undefined) || null,
        imapPass: (sealField(safeBody.imapPass) as string | null | undefined) || null,
      }
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Could not encrypt email credentials" },
        { status: 500 },
      )
    }

    const fields = {
      provider: safeBody.provider,
      fromName: safeBody.fromName,
      fromAddress: safeBody.fromAddress,
      replyToAddress: safeBody.replyToAddress || null,
      tenantAzureId: safeBody.tenantAzureId || null,
      clientId: safeBody.clientId || null,
      clientSecret: secrets.clientSecret,
      smtpHost: safeBody.smtpHost || null,
      smtpPort: safeBody.smtpPort ? Number(safeBody.smtpPort) : null,
      smtpUser: safeBody.smtpUser || null,
      smtpPass: secrets.smtpPass,
      imapHost,
      imapPort: safeBody.imapPort ? Number(safeBody.imapPort) : null,
      imapUser: safeBody.imapUser || null,
      imapPass: secrets.imapPass,
      useTls: safeBody.useTls ?? true,
      active: safeBody.active ?? true,
    }

    const config = await prisma.emailConfig.upsert({
      where: { tenantId: tenant.id },
      update: fields,
      create: {
        tenantId: tenant.id,
        ...fields,
        provider: fields.provider ?? "IMAP_SMTP",
        fromName: fields.fromName ?? await getLenderBrandName(tenant.id),
      },
    })

    // Non-secret fields only. An audit row that echoed a credential would just
    // relocate the plaintext this task exists to remove.
    await logAudit({
      tenantId: tenant.id,
      userId: actor?.id,
      userEmail: actor?.email ?? undefined,
      action: AuditAction.EMAIL_CONFIG_UPDATED,
      entity: "EmailConfig",
      entityId: config.id,
      newValue: {
        provider: fields.provider,
        fromAddress: fields.fromAddress,
        replyToAddress: fields.replyToAddress,
        smtpHost: fields.smtpHost,
        smtpPort: fields.smtpPort,
        imapHost: fields.imapHost,
        imapPort: fields.imapPort,
        useTls: fields.useTls,
        active: fields.active,
      },
    })

    return NextResponse.json(maskConfig(config as unknown as Record<string, unknown>))
  })
}
