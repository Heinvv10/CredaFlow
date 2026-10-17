import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, toDayNumber } from "./dates"
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
  suretySignedOn?: string | null
  consentSignedOn?: string | null
  consentBeforeSurety?: boolean
}
/** Date of the actual witnessed consent, not the later upload/verification. */
export function consentTimingProblem(consentSignedOn: string | null, consentBeforeSurety: boolean, signedAt: Date | null, today = sastCalendarDate(new Date())): string | null {
  if (!consentSignedOn) return "Record the actual date the spouse signed the witnessed consent"
  try { toDayNumber(consentSignedOn) } catch { return "Consent date must be a valid calendar date" }
  if (consentSignedOn > today) return "Consent cannot be dated in the future"
  if (!consentBeforeSurety) return "Confirm the witnessed spouse consent was obtained before the surety signed"
  if (signedAt && consentSignedOn > sastCalendarDate(signedAt)) return "Spouse consent must be obtained before the surety signs; later consent cannot ratify this suretyship"
  return null
}

export function parseSuretyConsent(body: unknown): SuretyConsentInput | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected an object"
  const b = body as Record<string, unknown>
  if (!MARITAL_REGIMES.includes(b.maritalRegime as SuretyConsentInput["maritalRegime"])) return "Choose the surety's marital regime"
  const text = (key: string) => b[key] == null || b[key] === "" ? null : typeof b[key] === "string" && (b[key] as string).trim().length <= 200 ? (b[key] as string).trim() : undefined
  const spouseName = text("spouseName"), witnessOne = text("witnessOne"), witnessTwo = text("witnessTwo"), evidenceDocumentId = text("evidenceDocumentId")
  if ([spouseName, witnessOne, witnessTwo, evidenceDocumentId].includes(undefined)) return "Names and document id must be text of at most 200 characters"
  if (b.maritalRegime === "IN_COMMUNITY" && [spouseName, witnessOne, witnessTwo, evidenceDocumentId].some(Boolean) && (!spouseName || !witnessOne || !witnessTwo || !evidenceDocumentId || witnessOne.toLowerCase() === witnessTwo.toLowerCase())) return "In-community suretyships need the spouse, two distinct witnesses and a wet-ink consent document"
  const consentSignedOn = text("consentSignedOn"), suretySignedOn = text("suretySignedOn")
  if (consentSignedOn === undefined || suretySignedOn === undefined) return "Consent and surety signing dates must be calendar dates"
  for (const date of [consentSignedOn, suretySignedOn]) {
    if (date) { try { toDayNumber(date) } catch { return "Consent and surety signing dates must be valid calendar dates" } }
  }
  const consentBeforeSurety = b.consentBeforeSurety === true || b.consentBeforeSurety === "on"
  if (b.maritalRegime === "IN_COMMUNITY" && evidenceDocumentId) {
    if (!suretySignedOn) return "Record the actual date the surety signed the wet-ink suretyship"
    try { toDayNumber(suretySignedOn) } catch { return "Surety signing date must be a valid calendar date" }
    if (suretySignedOn > sastCalendarDate(new Date())) return "Surety signing cannot be dated in the future"
    const problem = consentTimingProblem(consentSignedOn ?? null, consentBeforeSurety, new Date(`${suretySignedOn}T12:00:00Z`))
    if (problem) return problem
  }
  return { suretySignedOn: suretySignedOn ?? null, consentSignedOn: consentSignedOn ?? null, consentBeforeSurety, maritalRegime: b.maritalRegime as SuretyConsentInput["maritalRegime"], spouseName: spouseName!, witnessOne: witnessOne!, witnessTwo: witnessTwo!, evidenceDocumentId: evidenceDocumentId! }
}

export async function recordSuretyConsent(actor: SigningActor, dealId: string, signerId: string, input: SuretyConsentInput) {
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, actor.tenantId, dealId)
    if (!deal || !["APPROVED", "CONTRACTED"].includes(deal.status)) return { error: "Consent is recorded on an approved or contracted deal", status: 409 }
    const signer = await tx.dealSigner.findFirst({ where: { id: signerId, dealId, tenantId: actor.tenantId, document: "SURETYSHIP" } })
    if (!signer) return { error: "Suretyship not found", status: 404 }
    if (await tx.payout.findUnique({ where: { dealId, tenantId: actor.tenantId } })) return { error: "Consent is fixed once payout is created", status: 409 }
    if (input.maritalRegime === "IN_COMMUNITY" && input.evidenceDocumentId) {
      if (!input.suretySignedOn) return { error: "Record the actual date the surety signed the wet-ink suretyship", status: 422 }
      try { toDayNumber(input.suretySignedOn) } catch { return { error: "Surety signing date must be a valid calendar date", status: 422 } }
      if (input.suretySignedOn > sastCalendarDate(new Date()) || (signer.scanUploadedAt && input.suretySignedOn > sastCalendarDate(signer.scanUploadedAt))) return { error: "Actual surety signing must precede upload and cannot be in the future", status: 422 }
      const problem = consentTimingProblem(input.consentSignedOn ?? null, input.consentBeforeSurety === true, new Date(`${input.suretySignedOn}T12:00:00Z`))
      if (problem) return { error: problem, status: 422 }
      const evidence = await tx.entityDocument.findFirst({ where: { id: input.evidenceDocumentId!, tenantId: actor.tenantId, dealId, uploadedByType: "staff", docType: "LEGAL_DOCUMENT", deletedAt: null } })
      if (!evidence) return { error: "Upload the wet-ink spouse consent as a legal document of this deal first", status: 422 }
    }
    const previous = await tx.suretyConsent.findUnique({ where: { signerId, tenantId: actor.tenantId } })
    const stored = { ...input, suretySignedOn: input.suretySignedOn ? dbDate(input.suretySignedOn) : null, consentSignedOn: input.consentSignedOn ? dbDate(input.consentSignedOn) : null, consentBeforeSurety: input.consentBeforeSurety === true }
    const consent = await tx.suretyConsent.upsert({ where: { signerId, tenantId: actor.tenantId },
      create: { ...stored, tenantId: actor.tenantId, signerId, verifiedById: actor.userId },
      update: { ...stored, verifiedById: actor.userId, verifiedAt: new Date() } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_SURETY_CONSENT_VERIFIED, entity: "SuretyConsent", entityId: consent.id,
      oldValue: previous ? { maritalRegime: previous.maritalRegime, evidenceDocumentId: previous.evidenceDocumentId, consentSignedOn: previous.consentSignedOn?.toISOString().slice(0, 10) ?? null, suretySignedOn: previous.suretySignedOn?.toISOString().slice(0, 10) ?? null, consentBeforeSurety: previous.consentBeforeSurety } : null,
      newValue: { dealId, signerId, ...input } }, tx)
    return { recorded: true }
  })
}
