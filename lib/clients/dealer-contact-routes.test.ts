import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Every application route that sends the consumer a document, a link or a
// status email at the contact on file refuses (409, nothing sent) while that
// contact is one a dealer typed and staff have not verified: it may be the
// dealer's own (lib/clients/dealer-contact.ts). The PASQ and selfie
// send-link routes have their own cases beside them.
const m = vi.hoisted(() => ({ findUnique: vi.fn(), sendEmail: vi.fn(), sendSms: vi.fn(), sendWhatsApp: vi.fn(), sendMessage: vi.fn() }))
// The key-facts redirect reads the application by its own query; this route is exercised as a PASQ application.
vi.mock("@/lib/non-nca-documents/refusal", () => ({ keyFactsRefusal: async () => null }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ user: { id: "officer-1", email: "officer@lender.test" } })) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
  getTenantFromRequest: vi.fn(async () => ({ id: "tenant-1" })),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findUnique: m.findUnique } } }))
vi.mock("@/lib/email/service", () => ({ sendEmail: m.sendEmail }))
vi.mock("@/lib/integrations/bulksms", () => ({ sendSms: m.sendSms, sendWhatsApp: m.sendWhatsApp }))
vi.mock("@/lib/messaging/send", () => ({ sendMessage: m.sendMessage, SendBlockedError: class extends Error {} }))

import { POST as agreementEmail } from "@/app/api/applications/[id]/agreement/email/route"
import { POST as agreementLink } from "@/app/api/applications/[id]/agreement/send-link/route"
import { POST as signingPacket } from "@/app/api/applications/[id]/signing-packet/email/route"
import { POST as applicationNotice } from "@/app/api/notifications/application/route"

const UNVERIFIED = { createdByDealerId: "dealer-1", dealerContactVerifiedAt: null }
const application = {
  id: "app-1", clientId: "client-1", reference: "APP-1", status: "APPROVED", appliedAmount: 100_000, approvedAmount: 100_000,
  client: { firstName: "TEST", lastName: "Borrower", email: "borrower@client.invalid", phone: "+27820000000", whatsapp: "+27820000000", portalPassword: null, ...UNVERIFIED },
  product: { name: "TEST" },
}
const req = (body: unknown, headers: Record<string, string> = {}) => new NextRequest("http://lender.test/api/x", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
})
const ctx = { params: Promise.resolve({ id: "app-1" }) }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INTERNAL_API_SECRET = "TEST-secret"
  m.findUnique.mockResolvedValue(application)
})

describe.each([
  ["agreement email", () => agreementEmail(req({}), ctx)],
  ["agreement link", () => agreementLink(req({ channel: "EMAIL" }), ctx)],
  ["signing packet email", () => signingPacket(req({}), ctx)],
  ["application status email", () => applicationNotice(req({ applicationId: "app-1", event: "approved" }, { authorization: "Bearer TEST-secret" }))],
])("%s", (_name, call) => {
  it("refuses 409 and sends nothing to an unverified dealer-typed contact", async () => {
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/dealer captured this person's contact details/i)
    for (const send of [m.sendEmail, m.sendSms, m.sendWhatsApp, m.sendMessage]) expect(send).not.toHaveBeenCalled()
  })
})
