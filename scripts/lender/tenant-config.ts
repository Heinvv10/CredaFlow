/**
 * The tenant config file read by lender:bootstrap-tenant: who the lender is,
 * its brand colours and its feature flags. Validated with the same schemas the
 * app itself uses (lib/config/identity-schema.ts, lib/theme/tenant-colours.ts),
 * so a file that passes here is one the app will read and render.
 *
 * Like Settings > Lender identity, the three statutory numbers must be given
 * twice (`statutoryConfirm`): a transposed digit would otherwise be printed on
 * every NCA document.
 */
import { z } from "zod"
import {
  LENDER_IDENTITY_FIELDS,
  STATUTORY_FIELDS,
  validateLenderIdentityColumns,
  type LenderIdentityColumns,
} from "@/lib/config/identity-schema"
import { DEFAULT_TENANT_COLOURS, tenantColourErrors, type TenantColours } from "@/lib/theme/tenant-colours"

/** Feature flag name in the file -> TenantConfig column; the value is the schema default. */
export const FEATURE_COLUMNS = {
  lms: ["featureLms", true],
  crm: ["featureCrm", false],
  ims: ["featureIms", false],
  bureauSubmission: ["featureBureauSubmission", false],
  marketing: ["featureMarketing", false],
  portal: ["featurePortal", true],
  reports: ["featureReports", true],
} as const

export type FeatureColumn = (typeof FEATURE_COLUMNS)[keyof typeof FEATURE_COLUMNS][0]

export type TenantBootstrapConfig = {
  slug: string
  name: string
  domain: string | null
  colours: TenantColours
  features: Record<FeatureColumn, boolean>
  identity: LenderIdentityColumns
}

export type TenantConfigParse = { ok: true; config: TenantBootstrapConfig } | { ok: false; errors: string[] }

const featureShape = Object.fromEntries(Object.keys(FEATURE_COLUMNS).map((k) => [k, z.boolean().optional()]))

const fileSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "must be lower-case letters, digits and hyphens (1-40 chars)"),
  name: z.string().trim().min(2).max(120),
  domain: z.string().regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, "must be a lower-case hostname").nullable().optional(),
  colours: z.strictObject({ primaryColor: z.string(), secondaryColor: z.string(), darkColor: z.string() }).partial().optional(),
  features: z.strictObject(featureShape).optional(),
  identity: z.record(z.string(), z.unknown()),
  statutoryConfirm: z.record(z.string(), z.unknown()),
})

const norm = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim().toUpperCase() : null)

export function parseTenantConfig(raw: unknown): TenantConfigParse {
  const file = fileSchema.safeParse(raw)
  if (!file.success) {
    return { ok: false, errors: file.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`) }
  }
  const errors: string[] = []
  const f = file.data

  const unknown = Object.keys(f.identity).filter((k) => !(LENDER_IDENTITY_FIELDS as string[]).includes(k))
  if (unknown.length > 0) errors.push(`identity: unknown field(s) ${unknown.join(", ")}`)
  const identity = validateLenderIdentityColumns(Object.fromEntries(LENDER_IDENTITY_FIELDS.map((k) => [k, f.identity[k] ?? null])))
  if (!identity.ok) for (const [k, m] of Object.entries(identity.errors)) errors.push(`identity.${k}: ${m}`)

  for (const field of STATUTORY_FIELDS) {
    if (norm(f.statutoryConfirm[field]) !== norm(f.identity[field])) {
      errors.push(`statutoryConfirm.${field}: must repeat identity.${field} exactly`)
    }
  }
  const extra = Object.keys(f.statutoryConfirm).filter((k) => !(STATUTORY_FIELDS as readonly string[]).includes(k))
  if (extra.length > 0) errors.push(`statutoryConfirm: unknown field(s) ${extra.join(", ")}`)

  const colours: TenantColours = { ...DEFAULT_TENANT_COLOURS, ...f.colours }
  for (const [k, m] of Object.entries(tenantColourErrors(colours))) errors.push(`colours.${k}: ${m}`)

  if (errors.length > 0 || !identity.ok) return { ok: false, errors }
  const features = Object.fromEntries(
    Object.entries(FEATURE_COLUMNS).map(([key, [column, dflt]]) => [column, f.features?.[key as keyof typeof FEATURE_COLUMNS] ?? dflt]),
  ) as Record<FeatureColumn, boolean>
  return { ok: true, config: { slug: f.slug, name: f.name, domain: f.domain ?? null, colours, features, identity: identity.columns } }
}
