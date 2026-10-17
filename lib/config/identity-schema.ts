/**
 * Lender identity — the schema, types and pure validation, with no database
 * import, so NCA document generators and scripts can validate the identity
 * they print without loading Prisma. lib/config/identity.ts re-exports all of
 * this and adds the readers; see it for the history.
 */
import { z } from "zod"

export class LenderIdentityError extends Error {
  /** Column names that are missing or invalid. */
  readonly fields: string[]

  constructor(fields: string[], message?: string) {
    super(message ?? `Lender identity is not configured: missing or invalid ${fields.join(", ")}.`)
    this.name = "LenderIdentityError"
    this.fields = fields
  }
}

/** The `TenantConfig` columns that hold identity, exactly as stored. */
export type LenderIdentityColumns = {
  legalName: string | null
  brandName: string | null
  ncrNumber: string | null
  fscaNumber: string | null
  companyRegNumber: string | null
  registeredOffice: string | null
  publicEmail: string | null
  publicPhone: string | null
  publicWhatsapp: string | null
  collectionsEmail: string | null
  collectionsPhone: string | null
  collectionsPhoneSecondary: string | null
  brandTagline: string | null
  /** Calendar day, `YYYY-MM-DD` (stored as a DATE). */
  ncrRegistrationDate: string | null
  /** Calendar day, `YYYY-MM-DD` (stored as a DATE). */
  fscaAuthorisationDate: string | null
  ncrStatus: string | null
  headOfficeCity: string | null
}

/** The four optional regulatory details shown on the public regulatory page. */
export const REGULATORY_DETAIL_FIELDS = ["ncrRegistrationDate", "fscaAuthorisationDate", "ncrStatus", "headOfficeCity"] as const

/** The columns stored as a Postgres DATE; Prisma reads and writes them as a `Date` at UTC midnight. */
export const DATE_FIELDS = ["ncrRegistrationDate", "fscaAuthorisationDate"] as const

/** The columns as Prisma returns them: the DATE columns arrive as a `Date`. */
export type StoredLenderIdentityColumns = Omit<LenderIdentityColumns, (typeof DATE_FIELDS)[number]> & {
  [K in (typeof DATE_FIELDS)[number]]: string | Date | null
}

export const NCR_STATUSES = ["Registered", "Suspended", "Cancelled", "Deregistered"] as const
export type NcrStatus = (typeof NCR_STATUSES)[number]

export const LENDER_IDENTITY_SELECT = {
  legalName: true,
  brandName: true,
  ncrNumber: true,
  fscaNumber: true,
  companyRegNumber: true,
  registeredOffice: true,
  publicEmail: true,
  publicPhone: true,
  publicWhatsapp: true,
  collectionsEmail: true,
  collectionsPhone: true,
  collectionsPhoneSecondary: true,
  brandTagline: true,
  ncrRegistrationDate: true,
  fscaAuthorisationDate: true,
  ncrStatus: true,
  headOfficeCity: true,
} as const satisfies Record<keyof LenderIdentityColumns, true>

export const LENDER_IDENTITY_FIELDS = Object.keys(LENDER_IDENTITY_SELECT) as (keyof LenderIdentityColumns)[]

/** The three numbers that appear on NCA documents and must be typed twice. */
export const STATUTORY_FIELDS = ["ncrNumber", "fscaNumber", "companyRegNumber"] as const

export type LenderIdentity = {
  legalName: string
  tradingName: string
  ncrNumber: string
  /**
   * The FSCA licence number, or null for a lender that holds none (it sells no
   * insurance). Nothing may claim FAIS authorisation without it: every
   * consumer renders its FSP/FAIS line only when this is set, and a document
   * that prints it asks for it through requireLenderIdentityFields, which
   * refuses null.
   */
  fspNumber: string | null
  companyRegNumber: string
  registeredOfficeLines: string[]
  publicEmail: string
  publicPhone: string
  publicPhoneE164: string
  publicWhatsapp: string | null
  publicWhatsappE164: string | null
  collectionsEmail: string
  collectionsPhone: string
  collectionsPhoneSecondary: string | null
  brandTagline: string | null
  ncrRegistrationDate: string | null
  fscaAuthorisationDate: string | null
  ncrStatus: NcrStatus | null
  headOfficeCity: string | null
}

// Printable text: what the NCA documents can print. They use the PDF standard
// fonts, which encode WinAnsi (Windows-1252) only — Latin-1 plus the
// typographic marks below — so anything else (Ō, Ł, emoji) would crash a
// statutory render. No control characters either (a NUL or a newline in a
// name would corrupt a PDF field or an email header).
const PRINTABLE = /^[\u0020-\u007e\u00a0-\u00ff\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178]+$/

/** Trim; collapse inner whitespace runs; empty becomes null. */
function clean(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim().replace(/[ \t]+/g, " ")
  return trimmed === "" ? null : trimmed
}

const text = (min: number, max: number) =>
  z.string().min(min).max(max).regex(PRINTABLE, "must be printable text (Latin letters, no emoji or control characters)")

const required = <T extends z.ZodType>(schema: T) => z.preprocess(clean, schema)
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(clean, schema.nullable().optional())
const upper = (value: unknown) => {
  const v = clean(value)
  return typeof v === "string" ? v.toUpperCase() : v
}

// +27 followed by 9 digits, spaces allowed for display ("+27 11 000 0000").
const saPhone = z.string().max(20).refine(
  (v) => /^\+27\d{9}$/.test(v.replace(/ /g, "")),
  "must be +27 followed by 9 digits",
)
const email = z.string().max(254).pipe(z.email())

/** A `Date` as Prisma returns a DATE column (UTC midnight) → `YYYY-MM-DD`; anything else unchanged. */
export function storedDateString(value: unknown): unknown {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : value
}

/** Today's calendar day in South Africa, `YYYY-MM-DD`. */
function todaySast(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

// A real calendar day (2026-02-29 is refused) that is not in the future.
const pastDate = z.string().refine((v) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!match) return false
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return day.toISOString().slice(0, 10) === v
}, "must be a real date (YYYY-MM-DD)").refine((v) => v <= todaySast(), "must not be in the future")

const officeLines = z.string().max(500).transform((v, ctx) => {
  const lines = v.split(/\r?\n/).map((line) => line.trim().replace(/[ \t]+/g, " ")).filter(Boolean)
  if (lines.length < 1 || lines.length > 6 || lines.some((line) => line.length > 80 || !PRINTABLE.test(line))) {
    ctx.addIssue({ code: "custom", message: "must be 1-6 lines of at most 80 printable characters" })
    return z.NEVER
  }
  return lines.join("\n")
})

/**
 * Validates and normalises the stored columns. Shared by the reader (refuses
 * to return an invalid identity) and the writer (refuses to store one), so
 * the two can never disagree about what valid means.
 */
export const lenderIdentityColumnsSchema = z.object({
  legalName: required(text(2, 120)),
  brandName: required(text(2, 80)),
  ncrNumber: z.preprocess(upper, z.string().regex(/^NCRCP\d{1,8}$/, "must be NCRCP followed by digits")),
  fscaNumber: optional(z.string().regex(/^\d{1,8}$/, "must be the FSP licence number (digits only)")),
  companyRegNumber: z.preprocess(clean, z.string().regex(/^\d{4}\/\d{6}\/\d{2}$/, "must be a CIPC number like 2020/123456/07")),
  registeredOffice: z.preprocess(clean, officeLines),
  publicEmail: required(email),
  publicPhone: required(saPhone),
  publicWhatsapp: optional(saPhone),
  collectionsEmail: required(email),
  collectionsPhone: required(saPhone),
  collectionsPhoneSecondary: optional(saPhone),
  brandTagline: optional(text(1, 60)),
  ncrRegistrationDate: z.preprocess((v) => clean(storedDateString(v)), pastDate.nullable().optional()),
  fscaAuthorisationDate: z.preprocess((v) => clean(storedDateString(v)), pastDate.nullable().optional()),
  ncrStatus: optional(z.enum(NCR_STATUSES, { error: `must be one of ${NCR_STATUSES.join(", ")}` })),
  headOfficeCity: optional(text(2, 60)),
})

export type LenderIdentityParseResult =
  | { ok: true; columns: LenderIdentityColumns }
  | { ok: false; errors: Partial<Record<keyof LenderIdentityColumns, string>> }

/** Non-throwing validation, for the writer's per-field error messages. */
export function validateLenderIdentityColumns(raw: unknown): LenderIdentityParseResult {
  const result = lenderIdentityColumnsSchema.safeParse(raw ?? {})
  if (result.success) {
    const columns = Object.fromEntries(
      LENDER_IDENTITY_FIELDS.map((field) => [field, result.data[field] ?? null]),
    ) as LenderIdentityColumns
    return { ok: true, columns }
  }
  const errors: Partial<Record<keyof LenderIdentityColumns, string>> = {}
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof LenderIdentityColumns | undefined
    if (field && !errors[field]) errors[field] = issue.code === "invalid_type" ? "is required" : issue.message
  }
  return { ok: false, errors }
}

const e164 = (phone: string) => phone.replace(/ /g, "")

/** Throws `LenderIdentityError` naming every missing or invalid field. */
export function parseLenderIdentity(raw: Partial<StoredLenderIdentityColumns> | null | undefined): LenderIdentity {
  const result = lenderIdentityColumnsSchema.safeParse(raw ?? {})
  if (!result.success) {
    throw new LenderIdentityError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))])
  }
  const c = result.data
  return {
    legalName: c.legalName,
    tradingName: c.brandName,
    ncrNumber: c.ncrNumber,
    fspNumber: c.fscaNumber ?? null,
    companyRegNumber: c.companyRegNumber,
    registeredOfficeLines: c.registeredOffice.split("\n"),
    publicEmail: c.publicEmail,
    publicPhone: c.publicPhone,
    publicPhoneE164: e164(c.publicPhone),
    publicWhatsapp: c.publicWhatsapp ?? null,
    publicWhatsappE164: c.publicWhatsapp ? e164(c.publicWhatsapp) : null,
    collectionsEmail: c.collectionsEmail,
    collectionsPhone: c.collectionsPhone,
    collectionsPhoneSecondary: c.collectionsPhoneSecondary ?? null,
    brandTagline: c.brandTagline ?? null,
    ncrRegistrationDate: c.ncrRegistrationDate ?? null,
    fscaAuthorisationDate: c.fscaAuthorisationDate ?? null,
    ncrStatus: c.ncrStatus ?? null,
    headOfficeCity: c.headOfficeCity ?? null,
  }
}

/** `YYYY-MM-DD` → "7 October 2025", as the regulatory page prints a date. */
export function formatIdentityDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number)
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })
    .format(new Date(Date.UTC(year, month - 1, day)))
}

/** Validates one required identity field on its own; throws `LenderIdentityError([field])`. */
export function parseRequiredIdentityField(
  field: "legalName" | (typeof STATUTORY_FIELDS)[number],
  raw: unknown,
): string {
  const result = lenderIdentityColumnsSchema.shape[field].safeParse(raw)
  // fscaNumber is optional in the identity, but required wherever it is asked for.
  if (!result.success || result.data == null) throw new LenderIdentityError([field])
  return result.data
}

export function parseStatutoryNumber(field: (typeof STATUTORY_FIELDS)[number], raw: unknown): string {
  return parseRequiredIdentityField(field, raw)
}

export function parseNcrNumber(raw: unknown): string {
  return parseStatutoryNumber("ncrNumber", raw)
}

/** `LenderIdentity` field → the `TenantConfig` column that holds it. */
const IDENTITY_COLUMN = {
  legalName: "legalName",
  tradingName: "brandName",
  ncrNumber: "ncrNumber",
  fspNumber: "fscaNumber",
  companyRegNumber: "companyRegNumber",
  registeredOfficeLines: "registeredOffice",
  publicEmail: "publicEmail",
  publicPhone: "publicPhone",
  publicWhatsapp: "publicWhatsapp",
  collectionsEmail: "collectionsEmail",
  collectionsPhone: "collectionsPhone",
  collectionsPhoneSecondary: "collectionsPhoneSecondary",
  brandTagline: "brandTagline",
  ncrRegistrationDate: "ncrRegistrationDate",
  fscaAuthorisationDate: "fscaAuthorisationDate",
  ncrStatus: "ncrStatus",
  headOfficeCity: "headOfficeCity",
} as const satisfies Partial<Record<keyof LenderIdentity, keyof LenderIdentityColumns>>

export type PrintableIdentityField = keyof typeof IDENTITY_COLUMN

/**
 * Re-validates the identity fields an NCA document is about to print, with
 * the same schema as the reader and the writer, and returns exactly those
 * fields. A value that is missing, invalid or not in its stored (normalised)
 * form throws `LenderIdentityError` naming each failing column, so a caller
 * that hand-builds an identity cannot get a wrong number onto paper.
 */
export function requireLenderIdentityFields<K extends PrintableIdentityField>(
  identity: Partial<LenderIdentity> | null | undefined,
  fields: readonly K[],
): Pick<LenderIdentity, K> {
  const failed: string[] = []
  const picked: Partial<LenderIdentity> = {}
  for (const field of fields) {
    const column = IDENTITY_COLUMN[field]
    const value: unknown = identity?.[field]
    // The office prints as lines; it is stored, and validated, as one string.
    // A line holding its own line break would join to a valid string yet
    // print as one unbroken line, so lines must be plain.
    const stored = field === "registeredOfficeLines"
      ? (Array.isArray(value) && value.every((line) => typeof line === "string" && !/[\r\n]/.test(line)) ? value.join("\n") : undefined)
      : value
    const result = lenderIdentityColumnsSchema.shape[column].safeParse(stored)
    // The FSP number is optional in the identity, but a document that prints
    // it must have one: never "FSP null" on paper.
    const absentFsp = field === "fspNumber" && (stored ?? null) === null
    if (!result.success || absentFsp || (result.data ?? null) !== (stored ?? null)) {
      failed.push(column)
      continue
    }
    Object.assign(picked, { [field]: field === "registeredOfficeLines" ? [...(value as string[])] : (value ?? null) })
  }
  if (failed.length > 0) throw new LenderIdentityError(failed)
  return picked as Pick<LenderIdentity, K>
}

