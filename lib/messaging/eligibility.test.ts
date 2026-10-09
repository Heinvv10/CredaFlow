/* eslint-disable @typescript-eslint/no-explicit-any */
// vi.fn() mock resolved values don't match full Prisma return types — the
// partial shapes returned here are sufficient for the unit under test and the
// `as any` boundary keeps the mocks readable without duplicating every column.
import { describe, it, expect, beforeEach, vi } from "vitest"
import { canSend, currentConsent } from "./eligibility"
import type { EligibilityTemplate } from "./types"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findUnique: vi.fn() },
    contactConsent: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn() },
  },
}))

import { prisma } from "@/lib/prisma"

const contactId = "ct_test_1"
const tenantId = "tn1"

const serviceTemplate: EligibilityTemplate = {
  id: "t1",
  tenantId,
  key: "payment_reminder",
  category: "SERVICE",
  purposeRequired: null,
  statutoryOverride: false,
}

const transactionalTemplate: EligibilityTemplate = {
  ...serviceTemplate,
  id: "t2",
  key: "otp_email",
  category: "TRANSACTIONAL",
}

const marketingTemplate: EligibilityTemplate = {
  ...serviceTemplate,
  id: "t3",
  key: "promo_credit",
  category: "MARKETING",
  purposeRequired: "CROSS_SELL_CREDIT",
}

const insuranceTemplate: EligibilityTemplate = {
  ...serviceTemplate,
  id: "t4",
  key: "cross_sell_insurance",
  category: "MARKETING",
  purposeRequired: "CROSS_SELL_INSURANCE",
}

const statutoryTemplate: EligibilityTemplate = {
  ...serviceTemplate,
  id: "t5",
  key: "section_129_notice",
  category: "SERVICE",
  statutoryOverride: true,
}

// Base unblocked contact with no loans
const baseContact = {
  id: contactId,
  tenantId,
  blockedAt: null,
  status: "LEAD" as const,
  client: null,
}

const baseClientContact = {
  id: contactId,
  tenantId,
  blockedAt: null,
  status: "CLIENT" as const,
  client: {
    loans: [] as Array<{ id: string; status: string; closedAt: Date | null; daysInArrears: number }>,
  },
}

describe("canSend", () => {
  beforeEach(() => vi.clearAllMocks())

  // Test 1
  it("returns BLOCKED when contact.blockedAt is set", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({
      ...baseContact,
      blockedAt: new Date(),
    } as any)

    const r = await canSend(contactId, "EMAIL", serviceTemplate)
    expect(r).toEqual({ ok: false, reason: "BLOCKED" })
  })

  // Test 1b — defence in depth: status=BLOCKED is the operator/policy
  // classification (do-not-contact, deceased, fraud). Either signal blocks.
  it("returns BLOCKED when contact.status is BLOCKED (even with blockedAt null)", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({
      ...baseContact,
      blockedAt: null,
      status: "BLOCKED",
    } as any)

    const r = await canSend(contactId, "EMAIL", serviceTemplate)
    expect(r).toEqual({ ok: false, reason: "BLOCKED" })
  })

  // Test 2
  it("returns STATUTORY_OVERRIDE when template.statutoryOverride=true (bypasses channel opt-out)", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    // Even if there's a REVOKED SERVICE_COMMS consent, statutory override wins
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue({
      id: "cc1",
      status: "REVOKED",
    } as any)

    const r = await canSend(contactId, "EMAIL", statutoryTemplate)
    expect(r).toEqual({
      ok: true,
      basis: "STATUTORY_OVERRIDE",
      evidence: `template.statutoryOverride=${statutoryTemplate.key}`,
    })
  })

  // Test 3
  it("returns CHANNEL_OPTED_OUT when (channel, SERVICE_COMMS) has REVOKED row", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue({
      id: "cc2",
      status: "REVOKED",
      channel: "EMAIL",
      purpose: "SERVICE_COMMS",
    } as any)

    const r = await canSend(contactId, "EMAIL", serviceTemplate)
    expect(r).toEqual({ ok: false, reason: "CHANNEL_OPTED_OUT" })
  })

  // Test 4
  it("returns TRANSACTIONAL_OPERATIONAL for TRANSACTIONAL templates", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    // No channel opt-out
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)

    const r = await canSend(contactId, "EMAIL", transactionalTemplate)
    expect(r).toEqual({
      ok: true,
      basis: "TRANSACTIONAL_OPERATIONAL",
      evidence: "transactional template — no consent required",
    })
  })

  // Test 5
  it("returns SERVICE_COMMS_NCA for SERVICE templates with no channel opt-out", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)

    const r = await canSend(contactId, "EMAIL", serviceTemplate)
    expect(r).toEqual({
      ok: true,
      basis: "SERVICE_COMMS_NCA",
      // baseContact is a LEAD with no loans. The evidence records only facts
      // this lane actually established — it must not claim an agreement, and
      // equally must not claim an "open enquiry" it never checked for.
      evidence: `service template ${serviceTemplate.key} — contact status=LEAD, loans=0`,
    })
  })

  // Test 5b — the same lane, for a contact who genuinely has an agreement.
  it("records the real loan count for a client contact", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({
      ...baseClientContact,
      client: { loans: [{ id: "ln1", status: "ACTIVE", closedAt: null, daysInArrears: 0 }] },
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)

    const r = await canSend(contactId, "EMAIL", serviceTemplate)
    expect(r).toEqual({
      ok: true,
      basis: "SERVICE_COMMS_NCA",
      evidence: `service template ${serviceTemplate.key} — contact status=CLIENT, loans=1`,
    })
  })

  it("does not claim an agreement for a CLIENT contact with no loans", async () => {
    // status=CLIENT alone is not an agreement — a Client row can exist before
    // any loan is booked.
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseClientContact as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)

    const r = await canSend(contactId, "EMAIL", serviceTemplate)
    expect(r).toMatchObject({ ok: true, evidence: expect.stringContaining("loans=0") })
  })

  it("states no relationship conclusion at all — only facts it established", async () => {
    // This lane cannot distinguish an open enquiry from an unsolicited
    // contact (it serves UNKNOWN/DORMANT/STAFF too), so basisEvidence — which
    // an auditor reads as the reason the send was allowed — must not assert
    // either. Previously it hardcoded "on existing agreement" for everyone.
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ ...baseContact, status: "UNKNOWN" } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)

    const r = await canSend(contactId, "EMAIL", serviceTemplate)
    const evidence = r.ok ? r.evidence ?? "" : ""
    expect(evidence).toContain("status=UNKNOWN")
    for (const claim of ["existing agreement", "open enquiry"]) {
      expect(evidence).not.toContain(claim)
    }
  })

  // Test 6
  it("returns EXPLICIT_OPT_IN when (channel, purpose) has GRANTED row", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    // First call: SERVICE_COMMS exact → null; second: ALL_CHANNELS fallback → null;
    // third: purposeRequired exact → GRANTED
    vi.mocked(prisma.contactConsent.findFirst)
      .mockResolvedValueOnce(null) // SERVICE_COMMS channel check
      .mockResolvedValueOnce(null) // ALL_CHANNELS fallback for SERVICE_COMMS
      .mockResolvedValueOnce({
        id: "cc3",
        status: "GRANTED",
        source: "PORTAL_TOGGLE",
        channel: "EMAIL",
        purpose: "CROSS_SELL_CREDIT",
      } as any)

    const r = await canSend(contactId, "EMAIL", marketingTemplate)
    expect(r).toEqual({
      ok: true,
      basis: "EXPLICIT_OPT_IN",
      consentId: "cc3",
      evidence: "ContactConsent cc3 via PORTAL_TOGGLE",
    })
  })

  // Test 7
  it("returns REVOKED when (channel, purpose) has REVOKED row", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    vi.mocked(prisma.contactConsent.findFirst)
      .mockResolvedValueOnce(null) // SERVICE_COMMS exact
      .mockResolvedValueOnce(null) // SERVICE_COMMS ALL_CHANNELS fallback
      .mockResolvedValueOnce({
        id: "cc4",
        status: "REVOKED",
        channel: "EMAIL",
        purpose: "CROSS_SELL_CREDIT",
      } as any)

    const r = await canSend(contactId, "EMAIL", marketingTemplate)
    expect(r).toEqual({ ok: false, reason: "REVOKED" })
  })

  // Test 8
  it("returns NOT_ELIGIBLE_MARKETING_OBJECTED when GRANTED row on MARKETING_GLOBAL_OBJECTION exists", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    vi.mocked(prisma.contactConsent.findFirst)
      .mockResolvedValueOnce(null) // SERVICE_COMMS exact
      .mockResolvedValueOnce(null) // SERVICE_COMMS ALL_CHANNELS
      .mockResolvedValueOnce(null) // purposeRequired exact (no consent)
      .mockResolvedValueOnce(null) // purposeRequired ALL_CHANNELS (no consent)
      .mockResolvedValueOnce({
        id: "cc5",
        status: "GRANTED",
        channel: "EMAIL",
        purpose: "MARKETING_GLOBAL_OBJECTION",
      } as any)

    const r = await canSend(contactId, "EMAIL", marketingTemplate)
    expect(r).toEqual({ ok: false, reason: "NOT_ELIGIBLE_MARKETING_OBJECTED" })
  })

  // Test 9
  it("returns NOT_ELIGIBLE_INSURANCE_S69_OPINION_PENDING when tenant flag false and template.purposeRequired=CROSS_SELL_INSURANCE", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({
      ...baseClientContact,
      client: {
        loans: [{ id: "l1", status: "ACTIVE", closedAt: null, daysInArrears: 0 }],
      },
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      insuranceCrossSellS69OpinionReceived: false,
      softOptInClosedLoanTailEnabled: false,
    } as any)

    const r = await canSend(contactId, "EMAIL", insuranceTemplate)
    expect(r).toEqual({
      ok: false,
      reason: "NOT_ELIGIBLE_INSURANCE_S69_OPINION_PENDING",
    })
  })

  // Test 10
  it("returns S69_SOFT_OPT_IN when contact is CLIENT with ACTIVE loan and CROSS_SELL_CREDIT template", async () => {
    const activeLoan = { id: "l1", status: "ACTIVE", closedAt: null, daysInArrears: 0 }
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({
      ...baseClientContact,
      client: { loans: [activeLoan] },
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      insuranceCrossSellS69OpinionReceived: false,
      softOptInClosedLoanTailEnabled: false,
    } as any)

    const r = await canSend(contactId, "EMAIL", marketingTemplate)
    expect(r).toEqual({
      ok: true,
      basis: "S69_SOFT_OPT_IN",
      evidence: `s.69(3)(a) — loan ${activeLoan.id} status=${activeLoan.status} daysInArrears=${activeLoan.daysInArrears}`,
    })
  })

  // Test 11
  it("returns NO_CONSENT_ON_FILE when none of the lanes apply", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      insuranceCrossSellS69OpinionReceived: false,
      softOptInClosedLoanTailEnabled: false,
    } as any)

    const r = await canSend(contactId, "EMAIL", marketingTemplate)
    expect(r).toEqual({ ok: false, reason: "NO_CONSENT_ON_FILE" })
  })

  // Test 14
  it("honours the closed-loan 12-month tail only when Tenant.softOptInClosedLoanTailEnabled=true", async () => {
    const elevenMonthsAgo = new Date(Date.now() - 11 * 30 * 24 * 60 * 60 * 1000)
    const closedLoan = {
      id: "l2",
      status: "COMPLETED",
      closedAt: elevenMonthsAgo,
      daysInArrears: 0,
    }

    // flag = false → should NOT qualify (no ACTIVE loan, tail disabled)
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({
      ...baseClientContact,
      client: { loans: [closedLoan] },
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      insuranceCrossSellS69OpinionReceived: false,
      softOptInClosedLoanTailEnabled: false,
    } as any)

    const rFlagOff = await canSend(contactId, "EMAIL", marketingTemplate)
    expect(rFlagOff).toEqual({ ok: false, reason: "NO_CONSENT_ON_FILE" })

    vi.clearAllMocks()

    // flag = true → 11 months within 12-month tail → should qualify
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({
      ...baseClientContact,
      client: { loans: [closedLoan] },
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      insuranceCrossSellS69OpinionReceived: false,
      softOptInClosedLoanTailEnabled: true,
    } as any)

    const rFlagOn = await canSend(contactId, "EMAIL", marketingTemplate)
    expect(rFlagOn).toEqual({
      ok: true,
      basis: "S69_SOFT_OPT_IN",
      evidence: `s.69(3)(a) — loan ${closedLoan.id} status=${closedLoan.status} daysInArrears=${closedLoan.daysInArrears}`,
    })
  })
})

describe("currentConsent", () => {
  beforeEach(() => vi.clearAllMocks())

  // Test 12
  it("falls back to ALL_CHANNELS row for channel-agnostic purposes (MARKETING_GLOBAL_OBJECTION etc.)", async () => {
    const allChannelsRow = {
      id: "cc6",
      channel: "ALL_CHANNELS",
      purpose: "MARKETING_GLOBAL_OBJECTION",
      status: "GRANTED",
    }
    vi.mocked(prisma.contactConsent.findFirst)
      .mockResolvedValueOnce(null) // exact-channel lookup misses
      .mockResolvedValueOnce(allChannelsRow as any) // ALL_CHANNELS fallback hits

    const result = await currentConsent(contactId, "EMAIL", "MARKETING_GLOBAL_OBJECTION", tenantId)
    expect(result).toEqual(allChannelsRow)
    // Verify the ALL_CHANNELS query was made
    expect(prisma.contactConsent.findFirst).toHaveBeenCalledTimes(2)
    const secondCall = vi.mocked(prisma.contactConsent.findFirst).mock.calls[1]?.[0]
    expect((secondCall as any)?.where?.channel).toBe("ALL_CHANNELS")
    expect((secondCall as any)?.where?.tenantId).toBe(tenantId)
  })

  // Test 13
  it("ignores effectiveTo-set rows (only returns the latest-effective)", async () => {
    const currentRow = {
      id: "cc7",
      channel: "EMAIL",
      purpose: "SERVICE_COMMS",
      status: "GRANTED",
      effectiveTo: null,
    }
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValueOnce(currentRow as any)

    const result = await currentConsent(contactId, "EMAIL", "SERVICE_COMMS", tenantId)
    expect(result).toEqual(currentRow)

    // Confirm the query filters effectiveTo: null
    const firstCall = vi.mocked(prisma.contactConsent.findFirst).mock.calls[0]?.[0]
    expect((firstCall as any)?.where?.effectiveTo).toBeNull()
    expect((firstCall as any)?.where?.tenantId).toBe(tenantId)
  })

  it("scopes the contact and every eligibility consent read to the template tenant", async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(baseContact as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null)

    await canSend(contactId, "EMAIL", marketingTemplate)

    expect(prisma.contact.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: contactId, tenantId },
    }))
    expect(prisma.contactConsent.findFirst).toHaveBeenCalled()
    for (const [args] of vi.mocked(prisma.contactConsent.findFirst).mock.calls) {
      expect((args as any).where).toEqual(expect.objectContaining({
        tenantId,
        contactId,
      }))
    }
  })
})
