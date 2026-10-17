// Optional local acceptance bootstrap. Never targets a remote database.
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient, type PayoutChecklistItemKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { generateTotpSecret } from "@/lib/totp"
import { createBookingFixture, cleanupBookingFixture, bookingRoutes, dealDocument, type BookingFixture, type SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const enabled = process.env.RUN_ASSET_FINANCE_COMMERCIAL_BROWSER_IT === "1"
const keep = process.env.COMMERCIAL_BROWSER_SEED === "1"
const db = enabled ? new PrismaClient() : null
const suite = enabled ? describe : describe.skip
let fx: BookingFixture
const EVIDENCE = { SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE", SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT", INSURANCE_NOTES_LENDER: "INSURANCE_NOTING", TRACKER_CONFIRMED: "TRACKER_CERTIFICATE", DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE", NATIS_TITLEHOLDER: "NATIS_DOCUMENT" } as const
suite("synthetic commercial browser acceptance setup", () => {
  beforeAll(async () => {
    fx = await createBookingFixture(db!, randomUUID().replaceAll("-", "").slice(0, 16), (user) => { session.current = user && { user } })
  }, 120000)
  afterAll(async () => { if (db) { if (!keep) await cleanupBookingFixture(db, fx); await db.$disconnect() } })
  it("prepares a contracted instalment sale whose in-community surety has no spouse consent", async () => {
    const deal = await db!.assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, include: { asset: true } })
    const routes = bookingRoutes(fx.host)
    session.current = { user: { id: fx.officer, tenantId: fx.tenantId, role: "CREDIT_OFFICER", email: "officer@synthetic.invalid" } }
    for (const item of await db!.payoutChecklistItem.findMany({ where: { dealId: fx.dealId, required: true } })) {
      const docType = EVIDENCE[item.item as keyof typeof EVIDENCE]
      const evidenceDocumentId = docType ? await dealDocument(db!, fx, fx.dealId, docType) : null
      expect((await routes.confirm(fx.dealId, item.item as PayoutChecklistItemKind, { evidenceDocumentId, attestedSerial: deal.asset.serialNumber, note: null })).status).toBe(200)
    }
    const signer = await db!.dealSigner.findFirstOrThrow({ where: { dealId: fx.dealId, document: "SURETYSHIP" } })
    await db!.suretyConsent.update({ where: { signerId: signer.id }, data: { maritalRegime: "IN_COMMUNITY" } })
    session.current = { user: { id: fx.adminA, tenantId: fx.tenantId, role: "LOAN_ADMIN", email: "admin@synthetic.invalid" } }
    const refused = await routes.createPayout(fx.dealId)
    expect(refused.status).toBe(409)
    expect((await refused.json()).open.join(" ")).toContain("spouse consent")
    if (keep) {
      const password = "SyntheticLegalAcceptance2026!"
      const totpSecret = generateTotpSecret()
      const user = await db!.user.update({ where: { id: fx.adminA }, data: { password: await bcrypt.hash(password, 10), totpEnabled: true, totpSecret } })
      const client = await db!.client.update({ where: { id: signer.clientId }, data: { portalPassword: await bcrypt.hash(password, 10) } })
      const tenant = await db!.tenant.findUniqueOrThrow({ where: { id: fx.tenantId } })
      writeFileSync("/tmp/cf-commercial-browser.json", JSON.stringify({ dealId: fx.dealId, signerId: signer.id, clientId: signer.clientId, tenantSlug: tenant.slug, email: user.email, clientEmail: client.email, password, totpSecret }))
    }
  })
})
