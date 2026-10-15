import { NextRequest, NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { CredentialInputError, redactTenantCredentials, sealCredential } from "@/lib/integrations/tenant-credentials"
import { cleanAddressLine } from "@/lib/bureau-submission/clean"
import { SUPPLIER_NUMBER } from "@/lib/bureau-submission/generate"
import { dayToDbDate, isDay } from "@/lib/bureau-submission/period"
import type { Session } from "next-auth"
import { normaliseTenantDomain, tenantDomainRefusal } from "@/lib/config/tenant-domain"
import { LENDER_IDENTITY_FIELDS } from "@/lib/config/identity"
import { DEFAULT_TENANT_COLOURS, TENANT_COLOUR_VARS, tenantColourErrors, type TenantColourField, type TenantColours } from "@/lib/theme/tenant-colours"
import { applyTenantLanguages } from "@/lib/i18n/language-settings"

class LanguagesInvalid extends Error {}

class TenantColoursInvalid extends Error {
  constructor(readonly fields: Partial<Record<TenantColourField, string>>) {
    super("Tenant colours fail validation")
  }
}

function isAuthorized(req: NextRequest, session: Session | null): boolean {
  if (session?.user?.role !== "SUPER_ADMIN") return false
  const adminSecret = req.headers.get("x-admin-secret")
  const envSecret = process.env.ADMIN_SECRET
  if (!envSecret) return false
  return adminSecret === envSecret
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const session = await auth()
  if (!isAuthorized(req, session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { tenantId } = await params

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { config: true },
  })

  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 })
  }

  return NextResponse.json(redactTenantCredentials(tenant))
}

// Sealed on write (lib/integrations/tenant-credentials.ts); null clears one.
const CREDENTIAL_KEYS = ["netcashKey", "bulkSmsKey", "transunionKey"] as const

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const session = await auth()
  if (!isAuthorized(req, session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { tenantId } = await params

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  })
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // Lender identity (brandName, ncrNumber, fscaNumber, companyRegNumber and
  // the other identity columns) is NOT writable here: it goes only through
  // PUT /api/settings/identity (lib/config/identity-write.ts), which
  // validates, demands statutory numbers twice and audits. Sent here, those
  // keys are refused rather than silently dropped.
  // logoUrl too: the letterhead logo is uploaded, validated and audited only
  // through /api/settings/identity/logo (lib/config/lender-logo.ts).
  const identityKeys = [...LENDER_IDENTITY_FIELDS, "logoUrl"].filter((key) => key in body)
  if (identityKeys.length > 0) {
    return NextResponse.json(
      { error: `Lender identity fields are edited in Settings → Lender identity, not here: ${identityKeys.join(", ")}` },
      { status: 400 },
    )
  }

  // Split top-level tenant fields vs config fields
  const {
    name, domain, status,
    primaryColor, secondaryColor, darkColor,
    faviconUrl,
    featureLms, featureCrm, featureIms, featureMarketing, featurePortal, featureReports,
    featureBureauSubmission, bureauSupplierNumber, bureauTradingName, bureauReportingStartDate,
    ..._ // discard unknown fields
  } = body as Record<string, string | boolean | null | undefined>

  // Colours are checked as the set the tenant will have after this write: a
  // value that is not #rrggbb, or any text/surface pair below WCAG AA in light
  // or dark mode, refuses the whole request (lib/theme/tenant-colours.ts).
  // The check runs in the write's transaction, under the tenant row lock, so
  // two concurrent changes to different colours cannot each pass against the
  // old set and commit a combination that fails.
  const colourKeys = (Object.keys(TENANT_COLOUR_VARS) as TenantColourField[]).filter((key) => body[key] !== undefined)

  // Borrower-facing languages (lib/i18n). Turning af/zu/xh on shows borrowers
  // a machine-drafted catalogue, so each needs a native-speaker review
  // acknowledgement (languageReviewAcknowledgements), validated and audited by
  // applyTenantLanguages in this route's transaction. English is always on.
  const languagesRequested = body.enabledLanguages !== undefined || body.languageReviewAcknowledgements !== undefined

  const tenantUpdate: Record<string, unknown> = {}
  if (name !== undefined) tenantUpdate.name = name
  if (domain !== undefined) {
    // Normalised, and never a host the deployment or another lender serves
    // (lib/config/tenant-domain.ts).
    const parsed = normaliseTenantDomain(domain)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 422 })
    const refusal = parsed.domain ? await tenantDomainRefusal(parsed.domain, tenantId) : null
    if (refusal) return NextResponse.json({ error: refusal }, { status: 422 })
    tenantUpdate.domain = parsed.domain
  }
  if (status !== undefined) tenantUpdate.status = status

  const configUpdate: Record<string, unknown> = {}
  if (primaryColor !== undefined) configUpdate.primaryColor = primaryColor
  if (secondaryColor !== undefined) configUpdate.secondaryColor = secondaryColor
  if (darkColor !== undefined) configUpdate.darkColor = darkColor
  if (faviconUrl !== undefined) configUpdate.faviconUrl = faviconUrl
  if (featureLms !== undefined) configUpdate.featureLms = featureLms
  if (featureCrm !== undefined) configUpdate.featureCrm = featureCrm
  if (featureIms !== undefined) configUpdate.featureIms = featureIms
  if (featureMarketing !== undefined) configUpdate.featureMarketing = featureMarketing
  if (featurePortal !== undefined) configUpdate.featurePortal = featurePortal
  if (featureReports !== undefined) configUpdate.featureReports = featureReports
  const credentialKeys = CREDENTIAL_KEYS.filter((key) => body[key] !== undefined)
  for (const key of credentialKeys) {
    const value = body[key]
    if (value !== null && (typeof value !== "string" || value.length === 0)) {
      return NextResponse.json({ error: `${key} must be a non-empty string, or null` }, { status: 400 })
    }
    try {
      configUpdate[key] = value === null ? null : sealCredential(value)
    } catch (e) {
      if (e instanceof CredentialInputError) {
        return NextResponse.json({ error: `${key}: enter the credential itself, not a sealed value` }, { status: 400 })
      }
      console.error("Refusing to store a provider credential:", e)
      return NextResponse.json({ error: "Credential encryption is not configured on this deployment" }, { status: 500 })
    }
  }

  // Bureau data submission (lib/bureau-submission). These decide whether real
  // people's loans are reported to a credit bureau and under whose name, so
  // unlike the fields above they are validated and their change is audited.
  const bureauUpdate: Record<string, unknown> = {}
  if (featureBureauSubmission !== undefined) {
    if (typeof featureBureauSubmission !== "boolean") {
      return NextResponse.json({ error: "featureBureauSubmission must be a boolean" }, { status: 400 })
    }
    bureauUpdate.featureBureauSubmission = featureBureauSubmission
  }
  if (bureauSupplierNumber !== undefined) {
    const supplier = typeof bureauSupplierNumber === "string" ? bureauSupplierNumber.trim().toUpperCase() : bureauSupplierNumber
    if (supplier !== null && (typeof supplier !== "string" || !SUPPLIER_NUMBER.test(supplier))) {
      return NextResponse.json({ error: "bureauSupplierNumber must be 1-10 letters and digits, or null" }, { status: 400 })
    }
    bureauUpdate.bureauSupplierNumber = supplier
  }
  if (bureauTradingName !== undefined) {
    // Stored as typed; the generator cleans it into the header. Refused here
    // only when nothing printable would be left, or it could not fit.
    const name = typeof bureauTradingName === "string" ? bureauTradingName.trim() : bureauTradingName
    if (name !== null && (typeof name !== "string" || name.length > 60 || /[\x00-\x1F\x7F]/.test(name) || !cleanAddressLine(name))) {
      return NextResponse.json({ error: "bureauTradingName must be 1-60 printable characters, or null" }, { status: 400 })
    }
    bureauUpdate.bureauTradingName = name
  }
  if (bureauReportingStartDate !== undefined) {
    if (bureauReportingStartDate !== null && (typeof bureauReportingStartDate !== "string" || !isDay(bureauReportingStartDate))) {
      return NextResponse.json({ error: "bureauReportingStartDate must be YYYY-MM-DD, or null" }, { status: 400 })
    }
    bureauUpdate.bureauReportingStartDate = typeof bureauReportingStartDate === "string" ? dayToDbDate(bureauReportingStartDate) : null
  }
  Object.assign(configUpdate, bureauUpdate)

  const bureauKeys = Object.keys(bureauUpdate)
  const tenantData = {
    ...tenantUpdate,
    ...(Object.keys(configUpdate).length > 0 && {
      config: {
        upsert: {
          create: configUpdate,
          update: configUpdate,
        },
      },
    }),
  }
  if (bureauKeys.length === 0 && colourKeys.length === 0 && credentialKeys.length === 0 && !languagesRequested) {
    const updated = await prisma.tenant.update({ where: { id: tenantId }, data: tenantData, include: { config: true } })
    return NextResponse.json(redactTenantCredentials(updated))
  }

  // The change and its audit rows commit together, or neither does.
  const day = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : value)
  const updated = await prisma.$transaction(async (tx) => {
    if (colourKeys.length > 0 || languagesRequested) {
      // Locks the Tenant row, not TenantConfig: the config row may not exist
      // yet. The read below is a new statement, so under READ COMMITTED it
      // sees whatever the previous lock holder committed. NO KEY UPDATE
      // serialises colour changes without blocking the FOR KEY SHARE lock that
      // every insert referencing this tenant takes.
      await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE id = ${tenantId} FOR NO KEY UPDATE`
    }
    if (languagesRequested) {
      const languages = await applyTenantLanguages(tx, {
        tenantId,
        actor: { id: session?.user?.id ?? null, email: session?.user?.email ?? null },
        input: { enabledLanguages: body.enabledLanguages, acknowledgements: body.languageReviewAcknowledgements },
      })
      if (!languages.ok) throw new LanguagesInvalid(languages.error)
    }
    const before = await tx.tenantConfig.findUnique({ where: { tenantId } })
    if (colourKeys.length > 0) {
      const next = { ...DEFAULT_TENANT_COLOURS, ...before, ...Object.fromEntries(colourKeys.map((key) => [key, body[key]])) } as TenantColours
      const colourErrors = tenantColourErrors(next)
      if (Object.keys(colourErrors).length > 0) throw new TenantColoursInvalid(colourErrors)
    }
    const result = await tx.tenant.update({ where: { id: tenantId }, data: tenantData, include: { config: true } })
    if (colourKeys.length > 0) {
      await logAuditStrict({
        tenantId,
        userId: session?.user?.id,
        userEmail: session?.user?.email ?? undefined,
        action: AuditAction.TENANT_COLOURS_UPDATED,
        entity: "TenantConfig",
        entityId: tenantId,
        oldValue: Object.fromEntries(colourKeys.map((key) => [key, before?.[key] ?? null])),
        newValue: Object.fromEntries(colourKeys.map((key) => [key, configUpdate[key]])),
      }, tx)
    }
    if (credentialKeys.length > 0) {
      // Which credentials changed, never their values.
      await logAuditStrict({
        tenantId,
        userId: session?.user?.id,
        userEmail: session?.user?.email ?? undefined,
        action: AuditAction.PROVIDER_CREDENTIALS_UPDATED,
        entity: "TenantConfig",
        entityId: tenantId,
        newValue: { updatedKeys: credentialKeys, cleared: credentialKeys.filter((key) => body[key] === null) },
      }, tx)
    }
    if (bureauKeys.length === 0) return result
    await logAuditStrict({
      tenantId,
      userId: session?.user?.id,
      userEmail: session?.user?.email ?? undefined,
      action: AuditAction.BUREAU_CONFIG_UPDATED,
      entity: "TenantConfig",
      entityId: tenantId,
      oldValue: Object.fromEntries(bureauKeys.map((key) => [key, day((before as Record<string, unknown> | null)?.[key] ?? null)])),
      newValue: Object.fromEntries(bureauKeys.map((key) => [key, day(bureauUpdate[key])])),
    }, tx)
    return result
  }).catch((e: unknown) => {
    // Thrown before anything is written, so the transaction rolls back clean.
    if (e instanceof TenantColoursInvalid || e instanceof LanguagesInvalid) return e
    throw e
  })
  if (updated instanceof LanguagesInvalid) {
    return NextResponse.json({ error: updated.message }, { status: 400 })
  }
  if (updated instanceof TenantColoursInvalid) {
    return NextResponse.json({ error: "Tenant colours fail validation", fields: updated.fields }, { status: 422 })
  }

  if (colourKeys.length > 0 || languagesRequested) {
    // The colours (or languages) are committed; a failed invalidation only
    // leaves the old values cached for getTenantConfig's 300 s, so it must not
    // fail the write.
    // expire: 0, not "max": the next page load must draw the new palette,
    // not serve the stale one while revalidating.
    try {
      revalidateTag(`tenant-config-${tenantId}`, { expire: 0 })
    } catch (e) {
      console.error("Tenant colours saved but tenant-config cache was not invalidated:", e)
    }
  }

  return NextResponse.json(redactTenantCredentials(updated))
}
