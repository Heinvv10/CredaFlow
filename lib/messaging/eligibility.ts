import { prisma } from "@/lib/prisma"
import type { Channel, ConsentPurpose, ContactConsent } from "@prisma/client"
import type { Eligibility, EligibilityTemplate, PrismaLike } from "./types"

/**
 * currentConsentInternal — fetch the active (effectiveTo IS NULL) consent row
 * for a given (contactId, channel, purpose) using any Prisma-compatible client
 * (global or transaction). Falls back to an ALL_CHANNELS row when no
 * channel-specific row exists, so callers don't need to duplicate the
 * ALL_CHANNELS sentinel logic.
 */
async function currentConsentInternal(
  client: PrismaLike,
  contactId: string,
  channel: Channel,
  purpose: ConsentPurpose,
  tenantId: string,
): Promise<ContactConsent | null> {
  const exact = await client.contactConsent.findFirst({
    where: { tenantId, contactId, channel, purpose, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  })
  if (exact) return exact
  // ALL_CHANNELS sentinel — used for channel-agnostic purposes such as
  // MARKETING_GLOBAL_OBJECTION which applies regardless of channel.
  return client.contactConsent.findFirst({
    where: {
      tenantId,
      contactId,
      channel: "ALL_CHANNELS",
      purpose,
      effectiveTo: null,
    },
    orderBy: { effectiveFrom: "desc" },
  })
}

/**
 * currentConsent — public wrapper that uses the global prisma client.
 * For transactional callers use currentConsentInternal with the tx client.
 */
export async function currentConsent(
  contactId: string,
  channel: Channel,
  purpose: ConsentPurpose,
  tenantId: string,
): Promise<ContactConsent | null> {
  return currentConsentInternal(prisma, contactId, channel, purpose, tenantId)
}

/**
 * evaluateEligibility — the 11-lane POPIA / NCA evaluation logic, parameterised
 * over a Prisma-compatible client so it can run both outside a transaction
 * (canSend) and inside one (canSendTx in send.ts). Exported for use by
 * canSendTx; the public API entry point is canSend.
 *
 * Evaluation order (first match wins):
 *   1. Contact blocked                → BLOCKED
 *   2. Statutory override template    → STATUTORY_OVERRIDE
 *   3. Channel opted-out (SERVICE_COMMS REVOKED) → CHANNEL_OPTED_OUT
 *   4. TRANSACTIONAL category         → TRANSACTIONAL_OPERATIONAL
 *   5. SERVICE category               → SERVICE_COMMS_NCA
 *   6. MARKETING — explicit GRANTED   → EXPLICIT_OPT_IN
 *   7. MARKETING — REVOKED row        → REVOKED
 *   8. MARKETING — global objection   → NOT_ELIGIBLE_MARKETING_OBJECTED
 *   9. CROSS_SELL_INSURANCE, no S69 opinion → NOT_ELIGIBLE_INSURANCE_S69_OPINION_PENDING
 *  10. CLIENT + active/tail loan, soft-opt-in lane → S69_SOFT_OPT_IN
 *  11. Fallthrough                    → NO_CONSENT_ON_FILE
 */
// Export for canSendTx in send.ts. The public canSend is the thin wrapper below.
export async function evaluateEligibility(
  client: PrismaLike,
  contactId: string,
  channel: Channel,
  template: EligibilityTemplate,
): Promise<Eligibility> {
  // Lane 1: Contact blocked — schema has two block signals (defence in depth):
  //   • blockedAt    — set when a suppression event was observed
  //   • status=BLOCKED — operator/policy classification (do-not-contact, deceased, fraud)
  // Either one is sufficient to refuse a send.
  const contact = await client.contact.findUnique({
    where: { id: contactId, tenantId: template.tenantId },
    include: { client: { include: { loans: true } } },
  })
  if (!contact || contact.blockedAt || contact.status === "BLOCKED") {
    return { ok: false, reason: "BLOCKED" }
  }

  // Lane 2: Statutory override — bypasses all channel opt-out checks
  if (template.statutoryOverride === true) {
    return {
      ok: true,
      basis: "STATUTORY_OVERRIDE",
      evidence: `template.statutoryOverride=${template.key}`,
    }
  }

  // Lane 3: Channel opted-out — SERVICE_COMMS REVOKED means "unsubscribed
  // from all non-statutory comms on this channel".
  const channelOptOut = await currentConsentInternal(
    client,
    contactId,
    channel,
    "SERVICE_COMMS",
    template.tenantId,
  )
  if (channelOptOut?.status === "REVOKED") {
    return { ok: false, reason: "CHANNEL_OPTED_OUT" }
  }

  // Lane 4: TRANSACTIONAL — password resets, OTPs; bypass marketing rules
  if (template.category === "TRANSACTIONAL") {
    return {
      ok: true,
      basis: "TRANSACTIONAL_OPERATIONAL",
      evidence: "transactional template — no consent required",
    }
  }

  // Lane 5: SERVICE — operational comms.
  //
  // `evidence` is persisted verbatim as Message.basisEvidence — the
  // authoritative "why was this send permitted?" answer an auditor reads — so
  // it records only facts this function actually established, and draws no
  // conclusion about the relationship.
  //
  // It used to hardcode "on existing agreement", which was false for every
  // LEAD/UNKNOWN/DORMANT contact and for any CLIENT with no loan booked. The
  // fix is not a better-worded claim: this lane cannot tell an open enquiry
  // from an unsolicited contact, so it must not assert either. `loans` is the
  // raw count from the contact's client (any status — Lane 10 is the one that
  // qualifies loans by status/tail; do not read a live agreement into it).
  if (template.category === "SERVICE") {
    const loanCount = contact.client?.loans.length ?? 0
    return {
      ok: true,
      basis: "SERVICE_COMMS_NCA",
      evidence: `service template ${template.key} — contact status=${contact.status}, loans=${loanCount}`,
    }
  }

  // Lanes 6–10 apply to MARKETING templates only.
  // Lane 6 + 7: Check for explicit GRANTED / REVOKED consent on the
  // template's required purpose.
  if (template.purposeRequired) {
    const consent = await currentConsentInternal(
      client,
      contactId,
      channel,
      template.purposeRequired,
      template.tenantId,
    )
    if (consent?.status === "GRANTED") {
      return {
        ok: true,
        basis: "EXPLICIT_OPT_IN",
        consentId: consent.id,
        evidence: `ContactConsent ${consent.id} via ${consent.source}`,
      }
    }
    if (consent?.status === "REVOKED") {
      return { ok: false, reason: "REVOKED" }
    }
  }

  // Lane 8: POPIA s.69(3)(c)(ii) master objection — "stop all marketing"
  if (template.category === "MARKETING") {
    const globalObjection = await currentConsentInternal(
      client,
      contactId,
      channel,
      "MARKETING_GLOBAL_OBJECTION",
      template.tenantId,
    )
    if (globalObjection?.status === "GRANTED") {
      return { ok: false, reason: "NOT_ELIGIBLE_MARKETING_OBJECTED" }
    }
  }

  // Lanes 9 + 10: Soft-opt-in — POPIA s.69(3)(a) active credit relationship.
  // Only applies to cross-sell purposes.
  const softOptInLane =
    template.purposeRequired === "CROSS_SELL_CREDIT" ||
    template.purposeRequired === "CROSS_SELL_INSURANCE"

  if (softOptInLane) {
    // Single tenant read for both the insurance S69-opinion gate (Lane 9) and
    // the closed-loan 12-month tail predicate (Lane 10).
    const tenant = await client.tenant.findUnique({
      where: { id: template.tenantId },
      select: {
        insuranceCrossSellS69OpinionReceived: true,
        softOptInClosedLoanTailEnabled: true,
      },
    })

    // Lane 9: Insurance cross-sell is additionally gated by a tenant-level
    // S69 legal-opinion flag.
    if (template.purposeRequired === "CROSS_SELL_INSURANCE") {
      if (!tenant?.insuranceCrossSellS69OpinionReceived) {
        return { ok: false, reason: "NOT_ELIGIBLE_INSURANCE_S69_OPINION_PENDING" }
      }
    }

    // Lane 10: S69 soft opt-in — CLIENT status + qualifying loan.
    // A "qualifying loan" is either ACTIVE, or COMPLETED/WRITTEN_OFF/CANCELLED
    // within the 12-month tail window (only when tenant flag is enabled).
    const now = Date.now()
    const TWELVE_MONTHS = 365 * 24 * 60 * 60 * 1000

    const qualifyingLoan = contact.client?.loans.find(
      (l) =>
        l.status === "ACTIVE" ||
        (tenant?.softOptInClosedLoanTailEnabled &&
          l.closedAt !== null &&
          l.closedAt !== undefined &&
          now - l.closedAt.getTime() < TWELVE_MONTHS),
    )

    const isActiveRelationship = contact.status === "CLIENT" && !!qualifyingLoan

    if (isActiveRelationship && qualifyingLoan) {
      return {
        ok: true,
        basis: "S69_SOFT_OPT_IN",
        evidence: `s.69(3)(a) — loan ${qualifyingLoan.id} status=${qualifyingLoan.status} daysInArrears=${qualifyingLoan.daysInArrears}`,
      }
    }
  }

  // Lane 11: Fallthrough — no lawful basis found
  return { ok: false, reason: "NO_CONSENT_ON_FILE" }
}

/**
 * canSend — public thin wrapper. Calls evaluateEligibility with the global
 * prisma client. For transactional sends, use canSendTx from send.ts.
 */
export async function canSend(
  contactId: string,
  channel: Channel,
  template: EligibilityTemplate,
): Promise<Eligibility> {
  return evaluateEligibility(prisma, contactId, channel, template)
}
