import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Dealers never see telematics (docs/asset-finance/SLICE5.md part B), four
// ways: the dealer host 404s /api/asset-finance/*, a DEALER session off it is
// refused, the staff gate refuses the DEALER role, and the dealer projection
// whitelists nothing from telematics.
const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  revealPosition: vi.fn(),
  findFirst: vi.fn(),
}))
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/telematics/position-view", () => ({ revealPosition: h.revealPosition }))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceDeal: { findFirst: h.findFirst, findMany: vi.fn() } } }))

import proxy from "@/proxy"
import { POST as positionRoute } from "@/app/api/asset-finance/loans/[loanId]/telematics/position/route"
import { DEALER_DEAL_SELECT, loadDealerDealView } from "@/lib/dealer/deal-view"
import { canDo } from "@/lib/auth-guards"

const DEALER_HOST = "dealers.lender.example"
const STAFF_HOST = "app.lender.example"
const DEALER = { user: { id: "du-1", email: "sales@dealer.example", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_ADMIN", totpEnrolmentRequired: false } }
const PATH = "/api/asset-finance/loans/loan-1/telematics/position"
const S = "SENTINEL-TELEMATICS"

function visit(host: string) {
  const req = new NextRequest(`https://${host}${PATH}`, {
    method: "POST", headers: { host, origin: `https://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ context: "RECOVERY" }),
  }) as NextRequest & { auth: unknown }
  req.auth = DEALER
  return (proxy as unknown as (req: NextRequest) => Response | Promise<Response>)(req)
}

beforeEach(() => {
  vi.stubEnv("DEALER_APP_HOST", DEALER_HOST)
  vi.stubEnv("STAFF_APP_HOST", STAFF_HOST)
  vi.stubEnv("TENANT_HOST_MAP", `${STAFF_HOST}=lender,${DEALER_HOST}=lender`)
  h.revealPosition.mockReset()
  h.session = DEALER
})
afterEach(() => vi.unstubAllEnvs())

describe("a dealer never reaches a position", () => {
  it("is 404 on the dealer host and refused off it", async () => {
    expect((await visit(DEALER_HOST)).status).toBe(404)
    expect((await visit(STAFF_HOST)).status).toBe(403)
  })

  it("is refused by the staff gate (requireApiRole) before any position is read", async () => {
    const res = await positionRoute(new NextRequest(`https://${STAFF_HOST}${PATH}`, { method: "POST", body: JSON.stringify({ context: "RECOVERY" }) }),
      { params: Promise.resolve({ loanId: "loan-1" }) })
    expect(res.status).toBe(403)
    expect(h.revealPosition).not.toHaveBeenCalled()
  })

  it("holds neither telematics permission", () => {
    expect(canDo("DEALER", "view_asset_position")).toBe(false)
    expect(canDo("DEALER", "work_telematics_alerts")).toBe(false)
  })

  it("never finds telematics in the dealer's deal projection", async () => {
    expect(JSON.stringify(DEALER_DEAL_SELECT)).not.toMatch(/telematic|trackerDevice|latitude|longitude|position/i)
    h.findFirst.mockResolvedValue({
      id: "deal-1", createdAt: new Date("2026-10-01T08:00:00Z"), status: "BOOKED", dealerSubmittedAt: new Date("2026-10-01T09:00:00Z"), contractType: "OPERATING_LEASE",
      baseInstalmentCents: 1_000_000, clientId: null,
      application: { reference: "AF-0001", appliedAmount: 150_000_000 },
      entity: { legalName: "TEST Plant Hire (Pty) Ltd", relationships: [] }, client: null,
      asset: {
        make: "TEST", model: "TLB-1", year: 2025, serialNumber: "TESTSER1",
        trackerDevices: [{ externalDeviceId: S, lastPollError: S }], telematicsAlerts: [{ kind: S }], telematicsPositionAccesses: [{ positionId: S }],
      },
      loan: { id: "loan-1", reference: "LN-1", startDate: new Date("2026-10-02T08:00:00Z"), status: "DEFAULTED", telematicsAlerts: [{ kind: S }], telematicsHeldReadings: [{ value: S }] },
      signers: [], checklist: [], dealerConsentAttestations: [], dealerDocumentRequests: [], documents: [], dealerCommissionLines: [],
      latitude: S, longitude: S, position: { latitude: S, longitude: S },
    })
    const view = await loadDealerDealView({ tenantId: "tenant-1", dealerId: "dealer-1", dealerUserId: "du-1", email: "sales@dealer.example", dealerRole: "DEALER_SALES" }, "deal-1")
    expect(view).not.toBeNull()
    expect(JSON.stringify(view)).not.toContain(S)
  })
})
