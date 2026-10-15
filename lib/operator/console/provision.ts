/**
 * Provision a lender from the operator console: the same validation and the
 * same create path as `npm run lender:bootstrap-tenant` (scripts/lender/
 * tenant-config.ts, scripts/lender/bootstrap-tenant.ts), under the creating
 * operator, followed by an invite to the lender's first SUPER_ADMIN.
 *
 * The invite is a set-password link (account-links.ts): unlike the break-glass
 * CLI, the operator never holds the new admin's password. Bootstrap's
 * one-shot rule holds trivially: the tenant was created by this request.
 */
import type { PrismaClient } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { parseTenantConfig } from "@/scripts/lender/tenant-config"
import { bootstrapTenant, TenantBootstrapRefusal } from "@/scripts/lender/bootstrap-tenant"
import type { OperatorPrincipal } from "../console-auth"
import { emailInUse, INVITE_LINK_HOURS, issueAccountToken, lenderPasswordUrl, sendAccountLink, UNUSABLE_EMAIL, unusablePasswordHash } from "./account-links"
import { normaliseTenantDomain, tenantDomainRefusal, tenantSlugRefusal } from "@/lib/config/tenant-domain"

export type ProvisionResult =
  | { ok: true; tenantId: string; adminUserId: string; inviteSent: boolean }
  | { ok: false; status: 400 | 409 | 422; error: string; errors?: string[] }

const adminSchema = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(120),
})

export async function provisionLender(principal: OperatorPrincipal, body: unknown): Promise<ProvisionResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Invalid JSON body" }
  const { admin, ...file } = body as Record<string, unknown>
  // Tenant.domain is stored normalised (lib/config/tenant-domain.ts).
  const domain = normaliseTenantDomain(file.domain)
  if (domain.ok) file.domain = domain.domain
  const parsed = parseTenantConfig(file)
  const adminParsed = adminSchema.safeParse(
    admin && typeof admin === "object" ? { ...admin, email: String((admin as { email?: unknown }).email ?? "").trim().toLowerCase() } : admin,
  )
  const errors = [
    ...(domain.ok ? [] : [`domain: ${domain.error}`]),
    ...(parsed.ok ? [] : parsed.errors),
    ...(adminParsed.success ? [] : adminParsed.error.issues.map((i) => `admin.${i.path.join(".")}: ${i.message}`)),
  ]
  if (!domain.ok || !parsed.ok || !adminParsed.success) return { ok: false, status: 422, error: "The lender details are not valid", errors }
  const config = parsed.config
  const adminInput = adminParsed.data

  // Never a host the deployment or another lender already serves (B1).
  const domainRefusal = config.domain ? await tenantDomainRefusal(config.domain, null) : null
  if (domainRefusal) return { ok: false, status: 422, error: "The lender details are not valid", errors: [`domain: ${domainRefusal}`] }
  // Nor may its subdomain host be another lender's domain (the reverse collision).
  const slugRefusal = await tenantSlugRefusal(config.slug)
  if (slugRefusal) return { ok: false, status: 422, error: "The lender details are not valid", errors: [slugRefusal] }

  // Create-only: the CLI treats an identical file as a no-op, the console never does.
  const [slugTaken, emailTaken] = await Promise.all([
    prisma.tenant.findUnique({ where: { slug: config.slug }, select: { id: true } }),
    emailInUse(adminInput.email),
  ])
  if (slugTaken) return { ok: false, status: 409, error: `A lender with slug "${config.slug}" already exists` }
  // Whose account it is (another lender's, another operator's) is not said.
  if (emailTaken) return { ok: false, status: 409, error: UNUSABLE_EMAIL }

  // The app client is the extended one; bootstrapTenant and the template seed
  // take a plain PrismaClient (the CLI's). Tenant, TenantConfig and the
  // templates are written with explicit tenant ids, so the extension adds nothing.
  const db = prisma as unknown as PrismaClient
  let tenantId: string
  try {
    const result = await bootstrapTenant(db, config, {
      dryRun: false,
      operator: `operator-console:${principal.email}`,
      operatorId: principal.operatorId,
      actor: { userId: principal.id, email: principal.email },
      seedTemplates: async (id, brand) => {
        const { seedDocumentTemplates } = await import("@/prisma/seed-document-templates")
        const { seedDefaultMessageTemplates } = await import("@/lib/messaging/default-templates")
        await seedDocumentTemplates(id)
        await seedDefaultMessageTemplates(db, id, brand)
      },
    })
    // "unchanged": the slug was created between the check above and here.
    if (result.status !== "created" || !result.tenantId) {
      return { ok: false, status: 409, error: `A lender with slug "${config.slug}" already exists` }
    }
    tenantId = result.tenantId
  } catch (err) {
    if (err instanceof TenantBootstrapRefusal) return { ok: false, status: 409, error: err.message }
    throw err
  }

  const { adminUserId, token } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: adminInput.email, name: adminInput.name, role: "SUPER_ADMIN", tenantId, active: true,
        password: await unusablePasswordHash(),
      },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId, userId: principal.id, userEmail: principal.email,
      action: AuditAction.LENDER_ADMIN_INVITED, entity: "User", entityId: user.id,
      newValue: { email: adminInput.email, role: "SUPER_ADMIN", by: "operator-console", expiresInHours: INVITE_LINK_HOURS },
    }, tx)
    return { adminUserId: user.id, token: await issueAccountToken(tx, user.id, INVITE_LINK_HOURS) }
  })
  const inviteSent = await sendAccountLink({
    to: adminInput.email, name: adminInput.name, kind: "invite",
    organisation: config.identity.brandName ?? config.name,
    url: () => lenderPasswordUrl({ domain: config.domain }, token), hours: INVITE_LINK_HOURS,
  })
  return { ok: true, tenantId, adminUserId, inviteSent }
}
