import { randomInt } from "crypto"
import type { Prisma } from "@prisma/client"

const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
const REFERRAL_CODE_LENGTH = 6
const DEFAULT_REFERRAL_CODE_PREFIX = "REF"

export function generateReferralCodeCandidate(prefix = DEFAULT_REFERRAL_CODE_PREFIX) {
  const safePrefix = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || DEFAULT_REFERRAL_CODE_PREFIX
  let suffix = ""
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    suffix += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)]
  }
  return `${safePrefix}${suffix}`
}

export async function generateUniqueReferralCode(
  prisma: ReferralLookupClient,
  tenantId: string,
  prefix = DEFAULT_REFERRAL_CODE_PREFIX,
) {
  const delegate = prisma.referralCode as { findUnique: (args: unknown) => Promise<unknown> }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateReferralCodeCandidate(prefix)
    const existing = await delegate.findUnique({ where: { tenantId_code: { tenantId, code } }, select: { id: true } })
    if (!existing) return code
  }
  throw new Error("Unable to generate a unique referral code")
}

export function normaliseReferralCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  const cleaned = value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "")
  return cleaned.length >= 3 && cleaned.length <= 32 ? cleaned : null
}

type ReferralCodeWithAgent = Prisma.ReferralCodeGetPayload<{ include: { agent: true } }>

type ReferralLookupClient = {
  referralCode: unknown
}

type ReferralEventClient = {
  referralEvent: unknown
}

export async function resolveReferralCode(
  prisma: ReferralLookupClient,
  opts: { tenantId: string; code: string | null | undefined },
): Promise<ReferralCodeWithAgent | null> {
  const code = normaliseReferralCode(opts.code)
  if (!code) return null
  const delegate = prisma.referralCode as { findFirst: (args: unknown) => Promise<unknown> }
  return delegate.findFirst({
    where: { tenantId: opts.tenantId, code, status: "ACTIVE", agent: { status: "ACTIVE" } },
    include: { agent: true },
  }) as Promise<ReferralCodeWithAgent | null>
}

// Resolve a stored referral-code id back to an active code + active agent.
// Used for repeat-loan attribution (Client.referralCodeId): a client
// referred by an agent keeps crediting that agent on new loans, but ONLY while
// both the code and the agent are still ACTIVE — mirrors resolveReferralCode.
export async function resolveReferralCodeById(
  prisma: ReferralLookupClient,
  opts: { tenantId: string; id: string | null | undefined },
): Promise<ReferralCodeWithAgent | null> {
  if (!opts.id) return null
  const delegate = prisma.referralCode as { findFirst: (args: unknown) => Promise<unknown> }
  return delegate.findFirst({
    where: { id: opts.id, tenantId: opts.tenantId, status: "ACTIVE", agent: { status: "ACTIVE" } },
    include: { agent: true },
  }) as Promise<ReferralCodeWithAgent | null>
}

export async function recordReferralEvent(
  prisma: ReferralEventClient,
  opts: {
    tenantId: string
    eventType: string
    source?: string | null
    referralCode?: ReferralCodeWithAgent | null
    leadId?: string | null
    attributionRaw?: string | null
    amountCents?: number | null
    commissionCents?: number | null
    commissionStatus?: string
    qualityFlag?: string | null
    metadata?: Prisma.InputJsonValue
  },
) {
  const delegate = prisma.referralEvent as { create: (args: unknown) => Promise<unknown> }
  return delegate.create({
    data: {
      tenantId: opts.tenantId,
      eventType: opts.eventType,
      source: opts.source ?? null,
      agentId: opts.referralCode?.agentId ?? null,
      codeId: opts.referralCode?.id ?? null,
      leadId: opts.leadId ?? null,
      attributionRaw: opts.attributionRaw ?? null,
      amountCents: opts.amountCents ?? null,
      commissionCents: opts.commissionCents ?? null,
      commissionStatus: opts.commissionStatus ?? "NOT_ELIGIBLE",
      qualityFlag: opts.qualityFlag ?? null,
      metadata: opts.metadata ?? undefined,
    },
  })
}
