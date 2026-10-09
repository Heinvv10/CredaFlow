/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findFirst: vi.fn() },
    contactIdentity: { findMany: vi.fn() },
  },
}))
vi.mock("@/lib/messaging/channel-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/channel-availability")>()),
  getChannelAvailability: vi.fn(),
}))
vi.mock("./settings", () => ({ getCommsSettings: vi.fn() }))

import { contactReplyChannels } from "./reply-channels"
import { prisma } from "@/lib/prisma"
import { getChannelAvailability } from "@/lib/messaging/channel-availability"
import { getCommsSettings } from "./settings"

const CONTACT = {
  id: "ct1", primaryPhone: null, primaryWaJid: null, primaryEmail: null,
  blockedAt: null, status: "ACTIVE",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: true } as any)
  vi.mocked(prisma.contact.findFirst).mockResolvedValue(CONTACT as any)
  vi.mocked(prisma.contactIdentity.findMany).mockResolvedValue([] as any)
  vi.mocked(getChannelAvailability).mockResolvedValue({
    EMAIL: { enabled: true, toValue: "c@x.co" },
    WHATSAPP: { enabled: true, toValue: "27820000000@s.whatsapp.net" },
    SMS: { enabled: false, reason: "No SMS on file" },
  } as any)
})

it("includes a channel the contact only has a ContactIdentity row on", async () => {
  // No primaryEmail at all — the identity row is the whole reason EMAIL counts.
  vi.mocked(prisma.contactIdentity.findMany).mockResolvedValue([{ channel: "EMAIL" }] as any)
  expect(await contactReplyChannels("t1", "ct1")).toEqual(["EMAIL"])
})

it("includes a channel the contact only has a primary destination on", async () => {
  // The ContactIdentity gap that made the composer and the send disagree:
  // primaryEmail on file, no identity row. It must still count.
  vi.mocked(prisma.contact.findFirst).mockResolvedValue({ ...CONTACT, primaryEmail: "c@x.co" } as any)
  expect(await contactReplyChannels("t1", "ct1")).toEqual(["EMAIL"])
})

it("counts primaryPhone as a WhatsApp destination when there is no JID", async () => {
  vi.mocked(prisma.contact.findFirst).mockResolvedValue({ ...CONTACT, primaryPhone: "27820000000" } as any)
  expect(await contactReplyChannels("t1", "ct1")).toEqual(["WHATSAPP"])
})

it("excludes a blocked contact's channels even though the address is on file", async () => {
  vi.mocked(prisma.contact.findFirst).mockResolvedValue({
    ...CONTACT, primaryEmail: "c@x.co", primaryPhone: "27820000000", blockedAt: new Date(),
  } as any)
  vi.mocked(getChannelAvailability).mockResolvedValue({
    EMAIL: { enabled: false, toValue: "c@x.co", reason: "Do not contact" },
    WHATSAPP: { enabled: false, toValue: "27820000000", reason: "Do not contact" },
    SMS: { enabled: false, reason: "Do not contact" },
  } as any)
  expect(await contactReplyChannels("t1", "ct1")).toEqual([])
})

it("excludes an opted-out channel and keeps the other one", async () => {
  vi.mocked(prisma.contact.findFirst).mockResolvedValue({
    ...CONTACT, primaryEmail: "c@x.co", primaryPhone: "27820000000",
  } as any)
  vi.mocked(getChannelAvailability).mockResolvedValue({
    EMAIL: { enabled: true, toValue: "c@x.co" },
    WHATSAPP: { enabled: false, toValue: "27820000000", reason: "Client opted out" },
    SMS: { enabled: false, reason: "No SMS on file" },
  } as any)
  expect(await contactReplyChannels("t1", "ct1")).toEqual(["EMAIL"])
})

it("keeps a channel that is merely switched off tenant-wide", async () => {
  // "WhatsApp channel is off" is not-right-now, not never. The picker still
  // offers it; the send path reports the toggle in its own words.
  vi.mocked(prisma.contact.findFirst).mockResolvedValue({
    ...CONTACT, primaryEmail: "c@x.co", primaryPhone: "27820000000",
  } as any)
  vi.mocked(getChannelAvailability).mockResolvedValue({
    EMAIL: { enabled: true, toValue: "c@x.co" },
    WHATSAPP: { enabled: false, toValue: "27820000000", reason: "WhatsApp channel is off" },
    SMS: { enabled: false, reason: "No SMS on file" },
  } as any)
  expect(await contactReplyChannels("t1", "ct1")).toEqual(["WHATSAPP", "EMAIL"])
})

it("returns nothing for a contact outside the tenant", async () => {
  vi.mocked(prisma.contact.findFirst).mockResolvedValue(null as any)
  expect(await contactReplyChannels("t1", "ct-other")).toEqual([])
  expect(getChannelAvailability).not.toHaveBeenCalled()
})

it("returns nothing when the contact is reachable on neither channel", async () => {
  vi.mocked(getChannelAvailability).mockResolvedValue({
    EMAIL: { enabled: false, reason: "No email on file" },
    WHATSAPP: { enabled: false, reason: "No WhatsApp on file" },
    SMS: { enabled: false, reason: "No SMS on file" },
  } as any)
  expect(await contactReplyChannels("t1", "ct1")).toEqual([])
})
