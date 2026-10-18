// The asset-finance documents a lender owns the wording of, and exactly what
// of each it may change (docs/asset-finance/evidence/lender-owned-templates/SPEC.md).
//
// One DocumentTemplate per lender per family variant; its key is
// "<family>.<variant>" (the database CHECK DocumentTemplate_asset_finance_shape
// lists the same keys). Every variant is versioned and approved by the lender;
// only the commercial (non-CPA, non-NCA) agreement variants take lender text:
// replacement text for the family's editable clauses and up to
// MAX_ADDITIONAL_TERMS additional terms. CPA variants (s49 conspicuousness
// cannot be given to free text), NCA agreements (s90: an unlawful term may not
// be included at all), suretyships (they would widen the surety's liability)
// and resolutions take none: their lender version approves the starter for
// that lender. Everything else — the sections, particulars, pricing,
// schedules, rate and enforcement clauses, statutory and CPA notices — is
// protected and rendered by the trusted renderers from validated deal data.
import type { DealDocumentKind } from "@prisma/client"
import { ISA_INSURANCE_STARTER } from "../wording/instalment-sale"
import { ISA_CESSION_STARTER, ISA_NOTICES_STARTER } from "../wording/instalment-sale-enforcement"
import { LEASE_CESSION_STARTER } from "../wording/lease-agreement-end"
import type { AssetTemplateToken } from "./tokens"

/**
 * The protected renderers' revision, recorded on every issuance. Bump it when
 * a protected section's output changes, so an issuance says which system text
 * it was printed with.
 */
export const SYSTEM_REVISION = "2026-10-18.1"

/** The starter wording's revision, recorded in a version adopted from it. */
export const STARTER_REVISION = "2026-10-18.1"

export const MAX_ADDITIONAL_TERMS = 10

export type AssetTemplateFamily = "af.isa" | "af.lease.operating" | "af.lease.fml" | "af.nca" | "af.suretyship" | "af.resolution"

export interface EditableClause {
  id: string
  /** The clause number printed, e.g. "7.6". */
  number: string
  heading: string
  starter: string
  requiredTokens: readonly AssetTemplateToken[]
}

export interface AssetTemplateFamilyDef {
  family: AssetTemplateFamily
  name: string
  document: DealDocumentKind
  variants: readonly { variant: string; label: string }[]
  editable: readonly EditableClause[]
  tokens: readonly AssetTemplateToken[]
  /** The prefix additional terms are numbered under ("7." prints 7.14, 7.15, …; "" prints 12, 13, …). */
  numberPrefix: string
  /** The protected clause numbers the text may cite, by variant. */
  protectedClauses: (variant: string) => readonly string[]
}

const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)
const IDENTITY_TOKENS: readonly AssetTemplateToken[] = ["lender.legalName", "lender.tradingName", "lender.registeredOffice", "agreement.reference"]
const COMMERCIAL_OR_CPA = [
  { variant: "commercial", label: "Consumer Protection Act does not apply" },
  { variant: "cpa", label: "Consumer Protection Act applies" },
] as const

const LEASE_CESSION: EditableClause = {
  id: "cession", number: "9.13", heading: "Cession and assignment", starter: LEASE_CESSION_STARTER, requiredTokens: [],
}

export const ASSET_TEMPLATE_FAMILIES: readonly AssetTemplateFamilyDef[] = [
  {
    family: "af.isa",
    name: "Instalment sale agreement",
    document: "AGREEMENT",
    variants: COMMERCIAL_OR_CPA,
    editable: [
      { id: "insurance", number: "7.6", heading: "Insurance of the goods", starter: ISA_INSURANCE_STARTER, requiredTokens: [] },
      { id: "cession", number: "7.11", heading: "Cession and assignment", starter: ISA_CESSION_STARTER, requiredTokens: [] },
      {
        id: "notices", number: "7.12", heading: "Domicilium and notices", starter: ISA_NOTICES_STARTER,
        requiredTokens: ["lender.registeredOffice", "purchaser.domicilium"],
      },
    ],
    tokens: [...IDENTITY_TOKENS, "purchaser.domicilium"],
    numberPrefix: "7.",
    protectedClauses: () => range("7.", 1, 13),
  },
  {
    family: "af.lease.operating",
    name: "Operating lease agreement",
    document: "AGREEMENT",
    variants: COMMERCIAL_OR_CPA,
    editable: [LEASE_CESSION],
    tokens: IDENTITY_TOKENS,
    numberPrefix: "9.",
    protectedClauses: () => range("9.", 1, 15),
  },
  {
    family: "af.lease.fml",
    name: "Full-maintenance lease agreement",
    document: "AGREEMENT",
    variants: COMMERCIAL_OR_CPA,
    editable: [LEASE_CESSION],
    tokens: IDENTITY_TOKENS,
    numberPrefix: "9.",
    protectedClauses: () => range("9.", 1, 17),
  },
  {
    family: "af.nca",
    name: "NCA asset credit agreement",
    document: "AGREEMENT",
    variants: [
      { variant: "instalment_sale", label: "Instalment sale (NCA)" },
      { variant: "finance_lease", label: "Finance lease (NCA)" },
    ],
    editable: [],
    // The NCA agreement prints no trading name.
    tokens: ["lender.legalName", "lender.registeredOffice", "agreement.reference"],
    numberPrefix: "",
    // Clauses 1 to 11 and their sub-clauses (e.g. 6.2, 10.1).
    protectedClauses: () => [...range("", 1, 11), ...range("", 1, 11).flatMap((n) => range(`${n}.`, 1, 9))],
  },
  {
    family: "af.suretyship",
    name: "Deed of suretyship",
    document: "SURETYSHIP",
    variants: [
      { variant: "commercial", label: "Principal agreement outside the NCA" },
      { variant: "nca", label: "Principal agreement under the NCA" },
    ],
    editable: [],
    tokens: IDENTITY_TOKENS,
    numberPrefix: "5.",
    protectedClauses: () => range("5.", 1, 8),
  },
  {
    family: "af.resolution",
    name: "Entity resolution",
    document: "RESOLUTION",
    variants: [{ variant: "standard", label: "All entity types" }],
    editable: [],
    tokens: IDENTITY_TOKENS,
    numberPrefix: "4.",
    protectedClauses: () => range("4.", 1, 3),
  },
]

export interface AssetTemplateKey {
  family: AssetTemplateFamilyDef
  variant: string
  key: string
}

export function familyDef(family: string): AssetTemplateFamilyDef | null {
  return ASSET_TEMPLATE_FAMILIES.find((f) => f.family === family) ?? null
}

/** "af.isa.cpa" → its family and variant; null for any other key. */
export function parseTemplateKey(key: string): AssetTemplateKey | null {
  for (const family of ASSET_TEMPLATE_FAMILIES) {
    for (const { variant } of family.variants) {
      if (`${family.family}.${variant}` === key) return { family, variant, key }
    }
  }
  return null
}

/** The variants that take lender text (SPEC.md §2). */
const LENDER_TEXT_KEYS: ReadonlySet<string> = new Set(["af.isa.commercial", "af.lease.operating.commercial", "af.lease.fml.commercial"])

/** Whether this variant takes lender text at all. */
export function takesLenderText(key: AssetTemplateKey): boolean {
  return LENDER_TEXT_KEYS.has(key.key)
}

/** The clauses a lender may replace in this variant: none unless it takes lender text. */
export function editableClauses(key: AssetTemplateKey): readonly EditableClause[] {
  return takesLenderText(key) ? key.family.editable : []
}

/** Starter revisions a version may record: the current one and every earlier one. */
export const STARTER_REVISIONS: readonly string[] = [STARTER_REVISION]

export const ALL_TEMPLATE_KEYS: readonly string[] = ASSET_TEMPLATE_FAMILIES.flatMap((f) => f.variants.map((v) => `${f.family}.${v.variant}`))

/** The printed number of the n-th (0-based) additional term. */
export function additionalTermNumber(family: AssetTemplateFamilyDef, variant: string, index: number): string {
  const last = family.protectedClauses(variant).filter((n) => !n.slice(family.numberPrefix.length).includes(".")).length
  return `${family.numberPrefix}${last + index + 1}`
}
