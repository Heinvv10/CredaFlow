import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ props: vi.fn(), since: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) } }))
vi.mock("@/lib/kyc/portal-document-state", () => ({
  PORTAL_KYC_SNAPSHOT_OPTIONS: {},
  readPortalKycDocumentState: vi.fn(async () => ({ id: "c1", popiaConsentGiven: true, documents: [], kycChecklist: { complete: true } })),
}))
vi.mock("@/lib/portal/statement-needed", () => ({ recentStatementSince: h.since }))
vi.mock("./PortalDocumentsClient", () => ({ PortalDocumentsClient: (p: unknown) => { h.props(p); return null } }))

import PortalDocumentsPage from "./page"

describe("portal documents page", () => {
  it("passes when a recent statement is needed for the client's undecided application", async () => {
    h.since.mockResolvedValue(new Date("2026-07-18T08:00:00.000Z"))
    renderToStaticMarkup(await PortalDocumentsPage())
    expect(h.since).toHaveBeenCalledWith(expect.anything(), "t1", "c1")
    expect(h.props).toHaveBeenLastCalledWith(expect.objectContaining({ recentStatementSince: "2026-07-18T08:00:00.000Z" }))
  })

  it("passes null when nothing is needed", async () => {
    h.since.mockResolvedValue(null)
    renderToStaticMarkup(await PortalDocumentsPage())
    expect(h.props).toHaveBeenLastCalledWith(expect.objectContaining({ recentStatementSince: null }))
  })
})
