/* eslint-disable @typescript-eslint/no-explicit-any */
// vi.fn() mock resolved values don't match full Prisma return types — the
// partial shapes returned here are sufficient for the unit under test and the
// `as any` boundary keeps the mocks readable without duplicating every column.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contactConsent: { findFirst: vi.fn() },
  },
}))

import { prisma } from "@/lib/prisma"
import { getChannelAvailability } from "./channel-availability"

const tenantId = "tn1"

const baseContact = {
  id: "ct1",
  primaryEmail: null as string | null,
  primaryPhone: null as string | null,
  primaryWaJid: null as string | null,
  blockedAt: null as Date | null,
  status: "CLIENT",
}

describe("getChannelAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no consent rows found on either the exact-channel or the
    // ALL_CHANNELS fallback query.
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null as any)
  })

  afterEach(() => {
    delete process.env.BULKSMS_DRY_RUN
  })

  it("email-only contact: EMAIL enabled, WHATSAPP/SMS disabled with 'No ... on file'", async () => {
    const r = await getChannelAvailability({
      tenantId,
      contact: { ...baseContact, primaryEmail: "a@b.com" },
      whatsappEnabled: true,
    })

    expect(r.EMAIL).toEqual({ enabled: true, toValue: "a@b.com" })
    expect(r.WHATSAPP).toEqual({ enabled: false, reason: "No WhatsApp on file" })
    expect(r.SMS).toEqual({ enabled: false, reason: "No SMS on file" })
  })

  it("contact with no email at all: EMAIL disabled with 'No email on file'", async () => {
    const r = await getChannelAvailability({
      tenantId,
      contact: { ...baseContact, primaryPhone: "+27821234567" },
      whatsappEnabled: true,
    })

    expect(r.EMAIL).toEqual({ enabled: false, reason: "No email on file" })
  })

  it("blocked contact (blockedAt set): all channels disabled with 'Do not contact'", async () => {
    const r = await getChannelAvailability({
      tenantId,
      contact: {
        ...baseContact,
        primaryEmail: "a@b.com",
        primaryPhone: "+27821234567",
        primaryWaJid: "27821234567@s.whatsapp.net",
        blockedAt: new Date(),
      },
      whatsappEnabled: true,
    })

    expect(r.EMAIL).toEqual({ enabled: false, toValue: "a@b.com", reason: "Do not contact" })
    expect(r.WHATSAPP).toEqual({
      enabled: false,
      toValue: "27821234567@s.whatsapp.net",
      reason: "Do not contact",
    })
    expect(r.SMS).toEqual({ enabled: false, toValue: "+27821234567", reason: "Do not contact" })
    // Blocked short-circuits before any opt-out consent lookup.
    expect(prisma.contactConsent.findFirst).not.toHaveBeenCalled()
  })

  it("blocked contact via status===BLOCKED (blockedAt null): all channels disabled with 'Do not contact'", async () => {
    const r = await getChannelAvailability({
      tenantId,
      contact: { ...baseContact, primaryEmail: "a@b.com", status: "BLOCKED" },
      whatsappEnabled: true,
    })

    expect(r.EMAIL).toEqual({ enabled: false, toValue: "a@b.com", reason: "Do not contact" })
  })

  it("blocked contact with no WHATSAPP/SMS identity on file: still reports 'Do not contact', not 'No ... on file'", async () => {
    const r = await getChannelAvailability({
      tenantId,
      contact: { ...baseContact, primaryEmail: "a@b.com", blockedAt: new Date() },
      whatsappEnabled: true,
    })

    expect(r.WHATSAPP.reason).toBe("Do not contact")
    expect(r.SMS.reason).toBe("Do not contact")
    expect(r.WHATSAPP.enabled).toBe(false)
    expect(r.SMS.enabled).toBe(false)
  })

  it("whatsappEnabled:false disables WHATSAPP with 'WhatsApp channel is off' (EMAIL/SMS unaffected)", async () => {
    const r = await getChannelAvailability({
      tenantId,
      contact: {
        ...baseContact,
        primaryEmail: "a@b.com",
        primaryPhone: "+27821234567",
        primaryWaJid: "27821234567@s.whatsapp.net",
      },
      whatsappEnabled: false,
    })

    expect(r.WHATSAPP).toEqual({
      enabled: false,
      toValue: "27821234567@s.whatsapp.net",
      reason: "WhatsApp channel is off",
    })
    expect(r.EMAIL).toEqual({ enabled: true, toValue: "a@b.com" })
    expect(r.SMS).toEqual({ enabled: true, toValue: "+27821234567" })
  })

  it("BULKSMS_DRY_RUN=true disables SMS with 'SMS not enabled' (EMAIL/WHATSAPP unaffected)", async () => {
    process.env.BULKSMS_DRY_RUN = "true"

    const r = await getChannelAvailability({
      tenantId,
      contact: {
        ...baseContact,
        primaryEmail: "a@b.com",
        primaryPhone: "+27821234567",
        primaryWaJid: "27821234567@s.whatsapp.net",
      },
      whatsappEnabled: true,
    })

    expect(r.SMS).toEqual({ enabled: false, toValue: "+27821234567", reason: "SMS not enabled" })
    expect(r.EMAIL).toEqual({ enabled: true, toValue: "a@b.com" })
    expect(r.WHATSAPP).toEqual({ enabled: true, toValue: "27821234567@s.whatsapp.net" })
  })

  it("WHATSAPP toValue falls back to primaryPhone when primaryWaJid is null", async () => {
    const r = await getChannelAvailability({
      tenantId,
      contact: { ...baseContact, primaryPhone: "+27821234567" },
      whatsappEnabled: true,
    })

    expect(r.WHATSAPP).toEqual({ enabled: true, toValue: "+27821234567" })
  })

  it("SERVICE_COMMS REVOKED consent on a channel disables it with 'Client opted out'", async () => {
    ;(prisma.contactConsent.findFirst as any).mockImplementation(async (args: any) => {
      if (args?.where?.channel === "EMAIL" && args?.where?.purpose === "SERVICE_COMMS") {
        return { id: "cc1", status: "REVOKED", channel: "EMAIL", purpose: "SERVICE_COMMS" }
      }
      return null
    })

    const r = await getChannelAvailability({
      tenantId,
      contact: {
        ...baseContact,
        primaryEmail: "a@b.com",
        primaryPhone: "+27821234567",
      },
      whatsappEnabled: true,
    })

    expect(r.EMAIL).toEqual({ enabled: false, toValue: "a@b.com", reason: "Client opted out" })
    expect(r.SMS).toEqual({ enabled: true, toValue: "+27821234567" })
    // WHATSAPP falls back to primaryPhone (primaryWaJid is null) and only
    // EMAIL's SERVICE_COMMS consent is REVOKED in this mock, so it's unaffected.
    expect(r.WHATSAPP).toEqual({ enabled: true, toValue: "+27821234567" })
  })

  it("calls currentConsent with SERVICE_COMMS purpose per channel (reuses eligibility helper)", async () => {
    await getChannelAvailability({
      tenantId,
      contact: { ...baseContact, primaryEmail: "a@b.com" },
      whatsappEnabled: true,
    })

    expect(prisma.contactConsent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contactId: "ct1",
          channel: "EMAIL",
          purpose: "SERVICE_COMMS",
          effectiveTo: null,
        }),
      }),
    )
  })
})
