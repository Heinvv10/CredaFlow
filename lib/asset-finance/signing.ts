// Who must sign an asset deal's documents, and whether they have (goal §4.9,
// decision 2a.5). Pure: the routes and the document loader feed it rows.
//
// AGREEMENT and RESOLUTION: each active AUTHORISED_SIGNATORY of the entity.
// With none recorded, each active DIRECTOR of a COMPANY or TRUSTEE of a TRUST
// signs instead. A CC or PARTNERSHIP has no fallback: its authorised
// signatories must be recorded before its documents can be prepared (who may
// bind a CC or a partnership is the lender's legal team's call, not a default).
// The signer row's role is AUTHORISED_SIGNATORY either way: it is the capacity
// they sign in.
//
// SURETYSHIP: each active SURETY of the entity signs their own. A deal has no
// surety table: its sureties are its entity's active SURETY relationships
// (lib/asset-finance/deal-create.ts). A person who is a director and a surety
// signs the agreement, the resolution and their suretyship.
//
// The database mirrors these rules: dealRequiredSignatories and
// guardAssetDealContract in prisma/migrations/20261013112000_asset_finance_signing.
import type {
  BusinessEntityType,
  DealDocumentKind,
  DealSignerRole,
  EntityDocumentType,
  EntityRole,
  SignatureMethod,
} from "@prisma/client"

export interface SigningRelationship {
  clientId: string
  role: EntityRole
  active: boolean
}

export interface RequiredSigner {
  clientId: string
  role: DealSignerRole
  document: DealDocumentKind
}

const FALLBACK_AUTHORITY: Partial<Record<BusinessEntityType, EntityRole>> = {
  COMPANY: "DIRECTOR",
  TRUST: "TRUSTEE",
}

/** The wet-ink scan's EntityDocument type for each document. */
export const SIGNED_DOC_TYPE: Record<DealDocumentKind, EntityDocumentType> = {
  AGREEMENT: "SIGNED_AGREEMENT",
  SURETYSHIP: "SIGNED_SURETYSHIP",
  RESOLUTION: "SIGNED_RESOLUTION",
}

export const DEAL_DOCUMENT_LABELS: Record<DealDocumentKind, string> = {
  AGREEMENT: "Instalment sale agreement",
  SURETYSHIP: "Suretyship",
  RESOLUTION: "Resolution",
}

function activeWithRole(relationships: readonly SigningRelationship[], role: EntityRole): string[] {
  return [...new Set(relationships.filter((r) => r.active && r.role === role).map((r) => r.clientId))]
}

/** Who signs the agreement and the resolution, in relationship order; empty when nobody can. */
export function requiredAuthorityClientIds(
  entityType: BusinessEntityType,
  relationships: readonly SigningRelationship[],
): string[] {
  const signatories = activeWithRole(relationships, "AUTHORISED_SIGNATORY")
  if (signatories.length > 0) return signatories
  const fallback = FALLBACK_AUTHORITY[entityType]
  return fallback ? activeWithRole(relationships, fallback) : []
}

/** Each active SURETY, in relationship order. */
export function suretyClientIds(relationships: readonly SigningRelationship[]): string[] {
  return activeWithRole(relationships, "SURETY")
}

/** The full required set: agreement and resolution per signatory, a suretyship per surety. */
export function deriveRequiredSigners(
  entityType: BusinessEntityType,
  relationships: readonly SigningRelationship[],
): RequiredSigner[] {
  const authority = requiredAuthorityClientIds(entityType, relationships)
  return [
    ...authority.map((clientId) => ({ clientId, role: "AUTHORISED_SIGNATORY" as const, document: "AGREEMENT" as const })),
    ...authority.map((clientId) => ({ clientId, role: "AUTHORISED_SIGNATORY" as const, document: "RESOLUTION" as const })),
    ...suretyClientIds(relationships).map((clientId) => ({ clientId, role: "SURETY" as const, document: "SURETYSHIP" as const })),
  ]
}

// A type, not an interface, so it is a Prisma JSON value as it stands.
export type PreparedSigner = {
  clientId: string
  document: DealDocumentKind
}

const DOCUMENTS: readonly DealDocumentKind[] = ["AGREEMENT", "RESOLUTION", "SURETYSHIP"]

/** AssetFinanceDeal.preparedSigners: the required set at preparation, in signing order. */
export function preparedSignerSet(required: readonly RequiredSigner[]): PreparedSigner[] {
  return required.map(({ clientId, document }) => ({ clientId, document }))
}

/** The required set a deal was prepared with, read back from preparedSigners. Throws on a malformed value. */
export function requiredFromPrepared(value: unknown): RequiredSigner[] {
  if (!Array.isArray(value)) throw new TypeError("AssetFinanceDeal.preparedSigners must be a JSON array")
  return value.map((entry: unknown) => {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {}
    const document = DOCUMENTS.find((d) => d === record.document)
    if (typeof record.clientId !== "string" || !document) {
      throw new TypeError("AssetFinanceDeal.preparedSigners entries are { clientId, document }")
    }
    return { clientId: record.clientId, document, role: document === "SURETYSHIP" ? "SURETY" : "AUTHORISED_SIGNATORY" }
  })
}

export interface SignerEvidence {
  method: SignatureMethod | null
  signedAt: Date | null
  signatureSha256: string | null
  scanDocumentId: string | null
  confirmedById: string | null
  confirmedAt: Date | null
}

export type SignerState = "PENDING" | "AWAITING_CONFIRMATION" | "SIGNED" | "CONFIRMED"

export function signerState(s: SignerEvidence): SignerState {
  if (s.method === "E_SIGN" && s.signedAt && s.signatureSha256) return "SIGNED"
  if (s.method === "WET_INK" && s.scanDocumentId) return s.confirmedById && s.confirmedAt ? "CONFIRMED" : "AWAITING_CONFIRMATION"
  return "PENDING"
}

export function isSignerSatisfied(s: SignerEvidence): boolean {
  const state = signerState(s)
  return state === "SIGNED" || state === "CONFIRMED"
}

export const SIGNER_STATE_LABELS: Record<SignerState, string> = {
  PENDING: "Not signed",
  AWAITING_CONFIRMATION: "Scan awaiting confirmation",
  SIGNED: "E-signed",
  CONFIRMED: "Wet ink confirmed",
}

export interface Outstanding {
  clientId: string
  document: DealDocumentKind
  /** MISSING: no signer row (prepare the documents again). */
  state: "MISSING" | "PENDING" | "AWAITING_CONFIRMATION"
}

/** What still stands between the deal and CONTRACTED; empty when it may be contracted. */
export function outstandingSigners(
  required: readonly RequiredSigner[],
  rows: readonly (SignerEvidence & { clientId: string; document: DealDocumentKind })[],
): Outstanding[] {
  const out: Outstanding[] = []
  const key = (clientId: string, document: DealDocumentKind) => `${document}:${clientId}`
  const byKey = new Map(rows.map((r) => [key(r.clientId, r.document), r]))
  for (const need of required) {
    if (!byKey.has(key(need.clientId, need.document))) out.push({ clientId: need.clientId, document: need.document, state: "MISSING" })
  }
  for (const row of rows) {
    const state = signerState(row)
    if (state === "PENDING" || state === "AWAITING_CONFIRMATION") out.push({ clientId: row.clientId, document: row.document, state })
  }
  return out
}
