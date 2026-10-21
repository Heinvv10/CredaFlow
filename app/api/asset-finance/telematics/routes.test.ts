import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The staff telematics routes' own contract (docs/asset-finance/SLICE5.md part
// B): the asset-finance flag (404), the permission (403: READONLY and
// INSURANCE_OFFICER never see a position or work an alert), the lib's refusal
// status as is (422 with fields), and unknown actions 404. What the lib does is
// proven on real Postgres in lib/telematics/*.integration.test.ts.
const m = vi.hoisted(() => ({
  flag: { on: true },
  requireApiRole: vi.fn(),
  lib: {
    registerTrackerDevice: vi.fn(), removeTrackerDevice: vi.fn(), verifyTrackerMeter: vi.fn(), listAlerts: vi.fn(async () => []), acknowledgeAlert: vi.fn(), resolveAlert: vi.fn(),
    listHeldReadings: vi.fn(async () => []), acceptHeldReading: vi.fn(), rejectHeldReading: vi.fn(), revealPosition: vi.fn(),
  },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) } } }))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth-guards")>()), requireApiRole: () => m.requireApiRole() }))
vi.mock("@/lib/telematics/devices", () => ({ registerTrackerDevice: m.lib.registerTrackerDevice, removeTrackerDevice: m.lib.removeTrackerDevice, verifyTrackerMeter: m.lib.verifyTrackerMeter }))
vi.mock("@/lib/telematics/alerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telematics/alerts")>()), listAlerts: m.lib.listAlerts, acknowledgeAlert: m.lib.acknowledgeAlert, resolveAlert: m.lib.resolveAlert,
}))
vi.mock("@/lib/telematics/held-readings", () => ({ listHeldReadings: m.lib.listHeldReadings, acceptHeldReading: m.lib.acceptHeldReading, rejectHeldReading: m.lib.rejectHeldReading }))
vi.mock("@/lib/telematics/position-view", () => ({ revealPosition: m.lib.revealPosition }))

import { POST as register } from "@/app/api/asset-finance/assets/[id]/tracker-devices/route"
import { POST as remove } from "@/app/api/asset-finance/tracker-devices/[deviceId]/remove/route"
import { POST as verifyMeter } from "@/app/api/asset-finance/tracker-devices/[deviceId]/verify-meter/route"
import { GET as alerts } from "./alerts/route"
import { POST as alertAction } from "./alerts/[alertId]/[action]/route"
import { GET as held } from "./held-readings/route"
import { POST as heldAction } from "./held-readings/[id]/[action]/route"
import { POST as position } from "@/app/api/asset-finance/loans/[loanId]/telematics/position/route"

const signIn = (role: string) => m.requireApiRole.mockResolvedValue({ user: { id: "u1", email: "u1@lender.test", role, tenantId: "tenant-1" } })
const req = (path: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const calls = {
  register: () => register(req("/x", { provider: "simulated" }), { params: Promise.resolve({ id: "asset-1" }) }),
  remove: () => remove(req("/x", {}), { params: Promise.resolve({ deviceId: "dev-1" }) }),
  verifyMeter: () => verifyMeter(req("/x", { note: "Dashboard and device agree" }), { params: Promise.resolve({ deviceId: "dev-1" }) }),
  alerts: () => alerts(req("/api/asset-finance/telematics/alerts")),
  acknowledge: () => alertAction(req("/x", {}), { params: Promise.resolve({ alertId: "al-1", action: "acknowledge" }) }),
  held: () => held(req("/x")),
  accept: () => heldAction(req("/x", {}), { params: Promise.resolve({ id: "h-1", action: "accept" }) }),
  position: () => position(req("/x", { context: "RECOVERY" }), { params: Promise.resolve({ loanId: "loan-1" }) }),
}

beforeEach(() => {
  m.flag.on = true
  for (const fn of Object.values(m.lib)) fn.mockClear()
})

describe("staff telematics routes", () => {
  it("404 every route while the tenant's asset-finance flag is off", async () => {
    signIn("SUPER_ADMIN")
    m.flag.on = false
    for (const call of Object.values(calls)) expect((await call()).status).toBe(404)
  })

  it.each(["READONLY", "INSURANCE_OFFICER"])("refuse %s a position, the alert queue and every write (403), reaching no lib code", async (role) => {
    signIn(role)
    for (const call of Object.values(calls)) expect((await call()).status).toBe(403)
    for (const fn of Object.values(m.lib)) expect(fn).not.toHaveBeenCalled()
  })

  it("let a collections officer reveal a position and work the alert queue, but not register a device", async () => {
    signIn("COLLECTIONS_OFFICER")
    m.lib.revealPosition.mockResolvedValue({ kind: "ok", none: true })
    m.lib.acknowledgeAlert.mockResolvedValue({ kind: "ok" })
    expect(await (await calls.position()).json()).toEqual({ ok: true, none: true })
    expect(m.lib.revealPosition).toHaveBeenCalledWith(expect.objectContaining({ role: "COLLECTIONS_OFFICER", tenantId: "tenant-1" }), "loan-1", { context: "RECOVERY" }, expect.anything())
    expect((await calls.alerts()).status).toBe(200)
    expect((await calls.acknowledge()).status).toBe(200)
    expect((await calls.register()).status).toBe(403)
    expect((await calls.verifyMeter()).status).toBe(403)
  })

  it("answer a lib refusal with its status and fields, a registration with 201, and an unknown action or filter with 404/400", async () => {
    signIn("CREDIT_OFFICER")
    m.lib.registerTrackerDevice.mockResolvedValueOnce({ kind: "refused", status: 422, error: "The tracker device is not valid", fields: { externalDeviceId: "SIM-<SCENARIO>-<n>" } })
    const refused = await calls.register()
    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ error: "The tracker device is not valid", fields: { externalDeviceId: "SIM-<SCENARIO>-<n>" } })
    m.lib.registerTrackerDevice.mockResolvedValueOnce({ kind: "ok", id: "dev-9" })
    const created = await calls.register()
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ ok: true, id: "dev-9" })
    m.lib.verifyTrackerMeter.mockResolvedValueOnce({ kind: "refused", status: 409, error: "Only a live device whose meter is not yet verified can be verified" })
    expect((await calls.verifyMeter()).status).toBe(409)
    expect(m.lib.verifyTrackerMeter).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", tenantId: "tenant-1" }), "dev-1", { note: "Dashboard and device agree" })
    m.lib.acceptHeldReading.mockResolvedValueOnce({ kind: "refused", status: 422, error: "A lower reading cannot be accepted" })
    expect((await calls.accept()).status).toBe(422)
    expect((await heldAction(req("/x", {}), { params: Promise.resolve({ id: "h-1", action: "approve" }) })).status).toBe(404)
    expect((await alertAction(req("/x", {}), { params: Promise.resolve({ alertId: "a", action: "delete" }) })).status).toBe(404)
    expect((await alerts(req("/api/asset-finance/telematics/alerts?queue=SALES"))).status).toBe(400)
  })
})
