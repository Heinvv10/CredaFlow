import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockDeal, type SigningActor } from "./signing-prepare"

export const MARITAL_REGIMES = ["IN_COMMUNITY", "OUT_OF_COMMUNITY", "UNMARRIED", "UNKNOWN"] as const
export interface SuretyConsentInput {
  maritalRegime: typeof MARITAL_REGIMES[number]
  spouseName: string | null
  witnessOne: string | null
  witnessTwo: string | null
  evidenceDocumentId: string | null
}
export function parseSuretyConsent(body: unknown): SuretyConsentInput | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected an object"
  const b = body as Record<string, unknown>
  if (!MARITAL_REGIMES.includes(b.maritalRegime as SuretyConsentInput["maritalRegime"])) return "Choose the surety's marital regime"
  const text = (key: string) => b[key] == null || b[key] === "" ? null : typeof b[key] === "string" && (b[key] as string).trim().length <= 200 ? (b[key] as string).trim() : undefined
  const spouseName = text("spouseName"), witnessOne = text("witnessOne"), witnessTwo = text("witnessTwo"), evidenceDocumentId = text("evidenceDocumentId")
  if ([spouseName, witnessOne, witnessTwo, evidenceDocumentId].includes(undefined)) return "Names and document id must be text of at most 200 characters"
  if (b.maritalRegime === "IN_COMMUNITY" && [spouseName, witnessOne, witnessTwo, evidenceDocumentId].some(Boolean) && (!spouseName || !witnessOne || !witnessTwo || !evidenceDocumentId || witnessOne.toLowerCase() === witnessTwo.toLowerCase())) return "In-community suretyships need the spouse, two distinct witnesses and a wet-ink consent document"
  return { maritalRegime: b.maritalRegime as SuretyConsentInput["maritalRegime"], spouseName: spouseName!, witnessOne: witnessOne!, witnessTwo: witnessTwo!, evidenceDocumentId: evidenceDocumentId! }
}

export async function recordSuretyConsent(actor: SigningActor, dealId: string, signerId: string, input: SuretyConsentInput) {
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, actor.tenantId, dealId)
    if (!deal || !["APPROVED", "CONTRACTED"].includes(deal.status)) return { error: "Consent is recorded on an approved or contracted deal", status: 409 }
    const signer = await tx.dealSigner.findFirst({ where: { id: signerId, dealId, tenantId: actor.tenantId, document: "SURETYSHIP" } })
    if (!signer) return { error: "Suretyship not found", status: 404 }
    if (await tx.payout.findUnique({ where: { dealId, tenantId: actor.tenantId } })) return { error: "Consent is fixed once payout is created", status: 409 }
    if (input.maritalRegime === "IN_COMMUNITY" && input.evidenceDocumentId) {
      const evidence = await tx.entityDocument.findFirst({ where: { id: input.evidenceDocumentId!, tenantId: actor.tenantId, dealId, uploadedByType: "staff", docType: "LEGAL_DOCUMENT", deletedAt: null } })
      if (!evidence) return { error: "Upload the wet-ink spouse consent as a legal document of this deal first", status: 422 }
    }
    const previous = await tx.suretyConsent.findUnique({ where: { signerId, tenantId: actor.tenantId } })
    const consent = await tx.suretyConsent.upsert({ where: { signerId, tenantId: actor.tenantId },
      create: { ...input, tenantId: actor.tenantId, signerId, verifiedById: actor.userId },
      update: { ...input, verifiedById: actor.userId, verifiedAt: new Date() } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_SURETY_CONSENT_VERIFIED, entity: "SuretyConsent", entityId: consent.id,
      oldValue: previous ? { maritalRegime: previous.maritalRegime, evidenceDocumentId: previous.evidenceDocumentId } : null,
      newValue: { dealId, signerId, ...input } }, tx)
    return { recorded: true }
  })
}
