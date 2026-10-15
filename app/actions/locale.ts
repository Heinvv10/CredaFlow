"use server"

import { cookies } from "next/headers"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"
import { getResolvedTenantId } from "@/lib/tenant"
import { getTenantEnabledLocales, loadSession } from "@/lib/i18n/server"
import { LOCALE_COOKIE, isLocale } from "@/lib/i18n/locales"

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

export type SetLocaleResult = { ok: true } | { ok: false; error: string }

/**
 * The language switcher's write. Sets the browser's cookie and, for a
 * signed-in client, stores the choice as `Client.preferredLanguage`, which is
 * also the language their emails and WhatsApp messages go out in. Refuses a
 * language the tenant has not enabled.
 */
export async function setLocaleAction(requested: string): Promise<SetLocaleResult> {
  if (!isLocale(requested)) return { ok: false, error: "Unknown language" }

  const session = await loadSession()
  const client = session?.user?.role === "CLIENT" && session.user.tenantId && session.user.id
    ? { id: session.user.id, tenantId: session.user.tenantId, email: session.user.email ?? undefined }
    : null
  const tenantId = client ? client.tenantId : await getResolvedTenantId()
  const enabled = await getTenantEnabledLocales(tenantId)
  if (!enabled.includes(requested)) return { ok: false, error: "Language not offered" }

  ;(await cookies()).set(LOCALE_COOKIE, requested, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  })

  if (client) {
    const before = await prisma.client.findFirst({
      where: { id: client.id, tenantId: client.tenantId },
      select: { preferredLanguage: true },
    })
    if (before && before.preferredLanguage !== requested) {
      await prisma.client.update({
        where: { id: client.id, tenantId: client.tenantId },
        data: { preferredLanguage: requested },
      })
      await logAudit({
        // No userId: AuditLog.userId references User (staff); a client is
        // identified by email, as in app/api/portal/profile.
        tenantId: client.tenantId,
        userEmail: client.email,
        action: AuditAction.CLIENT_UPDATED,
        entity: "Client",
        entityId: client.id,
        oldValue: { preferredLanguage: before.preferredLanguage },
        newValue: { preferredLanguage: requested },
      })
    }
  }
  return { ok: true }
}
