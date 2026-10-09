import type { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"

/**
 * Mapping the umbrella POPIA checkbox on the apply / client wizard to the
 * granular `ClientConsent` row. Bureau enquiry, insurance underwriting,
 * third-party sharing and the automated affordability decision are all
 * required to process a loan — granting umbrella POPIA consent on the
 * application form authorises them. SMS / email marketing are NOT covered
 * by the umbrella under POPIA s.69; clients must enable those separately
 * (e.g. from the portal profile page).
 *
 * Asymmetry: on REVOKE we only flip the four processing-required purposes.
 * Marketing toggles are out-of-scope for the umbrella by design and must
 * not be trampled — a client who opted into SMS marketing separately keeps
 * that opt-in until they explicitly revoke it. The granular row's
 * `withdrawnAt` records the umbrella revocation for audit; consumers
 * (e.g. the bureau gate) read both fields.
 *
 * Backfill vs. ongoing: the backfill migration grants all four processing
 * purposes for every pre-existing client with `popiaConsentGiven = true`,
 * because those rows pre-date granular capture and there is no user
 * preference to respect. The ongoing path here NEVER overwrites an
 * existing non-withdrawn row, since the client may have already opted out
 * of (e.g.) insurance underwriting and that toggle must be respected.
 */
const UMBRELLA_GRANTED = {
  creditBureauEnquiry: true,
  insuranceUnderwriting: true,
  smsMarketing: false,
  emailMarketing: false,
  thirdPartySharing: true,
  automatedDecisionMaking: true,
} as const

const PROCESSING_PURPOSES_REVOKED = {
  creditBureauEnquiry: false,
  insuranceUnderwriting: false,
  thirdPartySharing: false,
  automatedDecisionMaking: false,
} as const

// Structural type: both the extended `prisma` client and the transaction
// client returned from `prisma.$transaction(async (tx) => …)` on that
// extended client share the same `clientConsent` model delegate, which is
// all this helper needs. Pinning to `typeof prisma` would reject the tx;
// the bare `Prisma.TransactionClient` would reject the extended client.
type ConsentDb = Pick<typeof prisma, "clientConsent">

/**
 * Upserts a ClientConsent row in lockstep with Client.popiaConsentGiven.
 *
 * Callers are responsible for running this inside the same transaction as
 * the Client create/update — see `app/api/clients/route.ts` and
 * `app/api/clients/[id]/route.ts` for the canonical pattern.
 */
export async function syncClientConsent(
  db: ConsentDb,
  opts: {
    clientId: string
    popiaConsentGiven: boolean
    capturedBy?: string | null
  },
): Promise<void> {
  const existing = await db.clientConsent.findUnique({
    where: { clientId: opts.clientId },
    select: { id: true, withdrawnAt: true },
  })

  if (!opts.popiaConsentGiven) {
    if (existing && existing.withdrawnAt === null) {
      await db.clientConsent.update({
        where: { clientId: opts.clientId },
        data: {
          ...PROCESSING_PURPOSES_REVOKED,
          withdrawnAt: new Date(),
          withdrawnBy: opts.capturedBy ?? null,
        },
      })
    }
    return
  }

  if (!existing) {
    await db.clientConsent.create({
      data: {
        clientId: opts.clientId,
        ...UMBRELLA_GRANTED,
        capturedBy: opts.capturedBy ?? null,
      },
    })
    return
  }

  if (existing.withdrawnAt !== null) {
    await db.clientConsent.update({
      where: { clientId: opts.clientId },
      data: {
        ...UMBRELLA_GRANTED,
        withdrawnAt: null,
        withdrawnBy: null,
        capturedAt: new Date(),
        capturedBy: opts.capturedBy ?? null,
      },
    })
  }
}

export const PROCESSING_PURPOSES = [
  "creditBureauEnquiry",
  "insuranceUnderwriting",
  "thirdPartySharing",
  "automatedDecisionMaking",
] as const

export const ALL_PURPOSES = [
  ...PROCESSING_PURPOSES,
  "smsMarketing",
  "emailMarketing",
] as const

export type ConsentPurposes = {
  creditBureauEnquiry: boolean
  insuranceUnderwriting: boolean
  smsMarketing: boolean
  emailMarketing: boolean
  thirdPartySharing: boolean
  automatedDecisionMaking: boolean
}

export type ConsentRow = ConsentPurposes & { withdrawnAt: Date | null }

type AuditEvent =
  | { action: typeof AuditAction.CONSENT_GRANTED; purposes: string[]; reason?: string }
  | { action: typeof AuditAction.CONSENT_WITHDRAWN; purposes: string[]; reason?: string }
  | {
      action: typeof AuditAction.CONSENT_PURPOSE_CHANGED
      purpose: keyof ConsentPurposes
      from: boolean
      to: boolean
      reason?: string
    }

export type ConsentTransition = {
  updates: Partial<ConsentPurposes> & {
    withdrawnAt?: Date | null
    withdrawnBy?: string | null
    capturedAt?: Date
    capturedBy?: string | null
  }
  auditEvents: AuditEvent[]
}

/**
 * Pure diff-and-emit for per-purpose consent changes. Bulk withdrawal / re-grant of all four processing purposes
 * is treated as a wholesale umbrella event (single CONSENT_WITHDRAWN /
 * CONSENT_GRANTED); anything else is a CONSENT_PURPOSE_CHANGED per dirty
 * field. Fresh rows where all four happen to flip false→true do NOT count as
 * a bulk grant — only re-instating a previously-withdrawn row qualifies.
 */
export function computeConsentTransition(
  current: ConsentRow,
  desired: Partial<ConsentPurposes>,
  opts: { actorId: string | null; reason?: string },
): ConsentTransition {
  const changed: Array<keyof ConsentPurposes> = []
  const updates: ConsentTransition["updates"] = {}

  for (const key of ALL_PURPOSES) {
    if (desired[key] === undefined) continue
    if (desired[key] === current[key]) continue
    changed.push(key)
    updates[key] = desired[key]
  }

  if (changed.length === 0) {
    return { updates: {}, auditEvents: [] }
  }

  const processingChanged = changed.filter((k) =>
    PROCESSING_PURPOSES.includes(k as (typeof PROCESSING_PURPOSES)[number]),
  )
  const allFourProcessing = processingChanged.length === PROCESSING_PURPOSES.length
  const marketingChanged = changed.filter(
    (k) => k === "smsMarketing" || k === "emailMarketing",
  )
  const onlyProcessing = marketingChanged.length === 0
  const allFourFlippedSameWay =
    allFourProcessing &&
    onlyProcessing &&
    PROCESSING_PURPOSES.every((k) => desired[k] === desired.creditBureauEnquiry)

  if (allFourFlippedSameWay && desired.creditBureauEnquiry === false) {
    // Bulk withdrawal
    updates.withdrawnAt = new Date()
    updates.withdrawnBy = opts.actorId
    return {
      updates,
      auditEvents: [
        {
          action: AuditAction.CONSENT_WITHDRAWN,
          purposes: [...PROCESSING_PURPOSES],
          reason: opts.reason,
        },
      ],
    }
  }

  if (
    allFourFlippedSameWay &&
    desired.creditBureauEnquiry === true &&
    current.withdrawnAt !== null
  ) {
    // Bulk re-grant of a previously withdrawn row
    updates.withdrawnAt = null
    updates.withdrawnBy = null
    updates.capturedAt = new Date()
    updates.capturedBy = opts.actorId
    return {
      updates,
      auditEvents: [
        {
          action: AuditAction.CONSENT_GRANTED,
          purposes: [...PROCESSING_PURPOSES],
          reason: opts.reason,
        },
      ],
    }
  }

  // Partial / mixed / fresh-row case — one event per dirty field
  const auditEvents: AuditEvent[] = changed.map((purpose) => ({
    action: AuditAction.CONSENT_PURPOSE_CHANGED,
    purpose,
    from: current[purpose],
    to: desired[purpose] as boolean,
    reason: opts.reason,
  }))

  return { updates, auditEvents }
}
