import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { integrationTestResultMessage } from "@/lib/integrations/simulation-presentation"

/**
 * Exercises the REAL route. An earlier version of this file asserted against a
 * test-local copy of the AVS projection, which meant the route could drop
 * `simulated` and every test would still pass — coverage that could not fail
 * for the reason it claimed to protect against. Caught in review.
 *
 * The AVS branch does not return the adapter's object; it rebuilds the response
 * field by field. That hand-rebuild is the hazard: the adapter labels a dry-run
 * pass with `simulated: true`, and a reconstruct that forgets the field hands an
 * UNLABELLED success to `integrationTestResultMessage()`, which then renders the
 * green "Connection successful" this change exists to prevent.
 */

const verifyAccountMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: () => Promise.resolve({ user: { id: "admin-1", email: "admin@example.test" } }),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/config/identity", () => ({ getLenderBrandName: async () => "Acme Lending" }))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: () => Promise.resolve({ collectionProvider: "netcash", avsProvider: "netcash", netcashRiskReportsKey: "k", netcashDebitOrderKey: "k" }) } },
}))
vi.mock("@/lib/integrations/collections/registry", () => ({
  getAvsProvider: () => ({ id: "netcash", verifyAccount: (...a: unknown[]) => verifyAccountMock(...a) }),
}))
// The other providers are imported at module scope but not exercised here.
vi.mock("@/lib/integrations/bulksms", () => ({ sendSms: vi.fn() }))
vi.mock("@/lib/integrations/netcash", () => ({ disburseFunds: vi.fn() }))
vi.mock("@/lib/integrations/transunion", () => ({ getCreditReport: vi.fn() }))
vi.mock("@/lib/integrations/smileidentity", () => ({ verifyId: vi.fn() }))

import { POST } from "./route"

const CHECKS = {
  accountActive: true,
  acceptsDebits: true,
  idNumberMatch: true,
  lastNameMatch: true,
  openThreeMonths: true,
}

function postCollections() {
  return POST(
    new NextRequest("http://localhost/api/settings/integrations/test", {
      method: "POST",
      body: JSON.stringify({ provider: "collections" }),
    }),
  )
}

describe("POST /api/settings/integrations/test — AVS simulation marker", () => {
  beforeEach(() => vi.resetAllMocks())

  it("forwards `simulated` from the adapter, so staff see it was not a real call", async () => {
    verifyAccountMock.mockResolvedValue({ passed: true, simulated: true, checks: CHECKS, raw: "dry-run" })

    const body = await (await postCollections()).json()

    expect(body.simulated).toBe(true)
    // The whole point of the marker: what the operator actually reads.
    expect(integrationTestResultMessage(body)).toBe(
      "Simulation successful — the provider was not contacted",
    )
  })

  it("omits `simulated` for a real provider call, which still reads as a genuine success", async () => {
    verifyAccountMock.mockResolvedValue({ passed: true, checks: CHECKS, raw: { soap: "envelope" } })

    const body = await (await postCollections()).json()

    expect("simulated" in body).toBe(false)
    expect(integrationTestResultMessage(body)).toBe("Connection successful")
  })

  it("still reports the provider and pass state", async () => {
    verifyAccountMock.mockResolvedValue({ passed: true, simulated: true, checks: CHECKS, raw: "dry-run" })

    const body = await (await postCollections()).json()

    expect(body).toMatchObject({ ok: true, provider: "netcash", passed: true, checks: CHECKS })
  })
})
