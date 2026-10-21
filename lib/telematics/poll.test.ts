import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  devices: [] as Array<Record<string, unknown>>,
  findDevices: vi.fn(async (args: { where?: { id?: { in?: string[] } } }) => m.devices.filter((d) => args.where?.id?.in?.includes(d.id as string) ?? true)),
  underAgreement: vi.fn(async (..._args: unknown[]) => m.devices.map((d) => ({ id: d.id }))),
  updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  ingestEvent: vi.fn(async (_tx: unknown, _device: unknown, _event: { providerEventId: string }, _ctx: { simulated: boolean }) => ({ stored: true })),
  logAudit: vi.fn(async (_entry: unknown) => undefined),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: vi.fn(async () => ({ telematicsPositionRetentionDays: 90 })), findMany: vi.fn(async () => [{ tenantId: "t1" }]) },
    trackerDevice: { findMany: m.findDevices, updateMany: m.updateMany },
    $transaction: m.transaction,
    $queryRaw: m.underAgreement,
  },
}))
vi.mock("@/lib/audit", async (original) => ({ ...(await original<typeof import("@/lib/audit")>()), logAudit: m.logAudit }))
vi.mock("./ingest", () => ({ ingestEvent: m.ingestEvent }))

import { Prisma } from "@prisma/client"
import { TelematicsEventNotYet, TelematicsEventRejected } from "./event-shape"
import { pollTenant, runTelematicsPoll } from "./poll"
import { registerTelematicsProvider } from "./registry"
import type { TelematicsProvider } from "./types"

const device = (id: string, externalDeviceId: string, provider = "simulated") =>
  ({ id, tenantId: "t1", assetId: `a-${id}`, provider, externalDeviceId, installedOn: new Date("2026-09-01T00:00:00.000Z"), pollCursor: null, meterVerifiedAt: null,
    failingEventId: null as string | null, failingEventCount: 0 })
const NOW = new Date("2026-09-03T18:00:00.000Z")
const updates = () => m.updateMany.mock.calls.map(([args]) => args as { where: { id?: string }; data: Record<string, unknown> })

describe("the telematics poll", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    for (const fn of [m.updateMany, m.transaction, m.ingestEvent, m.logAudit, m.findDevices, m.underAgreement]) fn.mockClear()
    m.devices = [device("d1", "SIM-STEADY-1")]
  })
  afterEach(() => vi.unstubAllEnvs())

  it("refuses the simulated provider on a deployed build without the allow-list: nothing stored, the device marked, audited", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ ok: false, failed: 1, stored: 0 })
    expect(m.transaction).not.toHaveBeenCalled()
    expect(m.ingestEvent).not.toHaveBeenCalled()
    expect(updates()).toEqual([expect.objectContaining({ data: { lastPollError: expect.stringMatching(/^NOT_CONFIGURED: Simulated simulated-telematics results are not permitted/) } })])
    expect(m.logAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", action: "TELEMATICS_POLL_FAILED" }))
    expect(await runTelematicsPoll(NOW)).toMatchObject({ ok: false, failed: 1 })
  })

  it("runs it when SIMULATED_INTEGRATIONS names simulated-telematics, storing every event as simulated and moving the cursor", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-telematics")
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ ok: true, failed: 0, stored: 9, devices: 1 })
    expect(m.ingestEvent.mock.calls.every(([, , , ctx]) => ctx.simulated)).toBe(true)
    expect(updates().at(-1)).toMatchObject({ where: { id: "d1" }, data: { lastPollError: null, pollCursor: "2026-09-03T16:00:00.000Z" } })
  })

  it("drops a device id the tenant does not have, and keeps a device's cursor when one of its events failed", async () => {
    const stray: TelematicsProvider = {
      id: "test-stray", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({
        simulated: false, cursors: { "DEV-1": "2026-09-03T00:00:00.000Z" },
        events: [
          { providerEventId: "x1", externalDeviceId: "OTHER-TENANTS-DEVICE", occurredAt: NOW, kind: "HEARTBEAT" },
          { providerEventId: "x2", externalDeviceId: "DEV-1", occurredAt: NOW, kind: "HEARTBEAT" },
          { providerEventId: "x3", externalDeviceId: "DEV-1", occurredAt: NOW, kind: "METER" },
        ],
      }),
    }
    registerTelematicsProvider(stray)
    m.devices = [device("d2", "DEV-1", "test-stray")]
    m.ingestEvent.mockImplementationOnce(async () => { throw new Error("boom") })
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ unknownDevices: 1, failed: 1, stored: 0, rejected: 0 })
    expect(m.ingestEvent).toHaveBeenCalledTimes(1) // x3 is malformed (no meter) and never reached: the device failed first
    expect(updates().at(-1)).toMatchObject({ where: { id: "d2" }, data: { lastPollError: expect.stringMatching(/retried/) } })
    expect(updates().at(-1)!.data).not.toHaveProperty("pollCursor")
  })

  it("polls only the devices the database finds under an agreement (a covering loan, or an approved or contracted deal awaiting payout)", async () => {
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-telematics")
    m.devices = [device("d1", "SIM-STEADY-1")]
    m.underAgreement.mockResolvedValueOnce([])
    expect(await pollTenant("t1", NOW)).toMatchObject({ devices: 0 })
    expect(m.findDevices.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1", status: "ACTIVE", id: { in: [] } } })
    const sql = (m.underAgreement.mock.calls[0][0] as unknown as string[]).join("?")
    // Tenure as of the poll's own clock, not the database's.
    expect(sql).toContain(`public."telematicsLoanAt"(d."tenantId", d."assetId", (?::timestamptz AT TIME ZONE 'UTC')) IS NOT NULL`)
    expect(m.underAgreement.mock.calls[0].slice(1).flatMap((v) => (typeof v === "object" && v !== null && "values" in v ? (v as { values: unknown[] }).values : [v])))
      .toEqual(["t1", NOW.toISOString(), "APPROVED", "CONTRACTED"])
  })

  it("skips and audits only a refusal of the event itself (and a malformed event); any other failure keeps the cursor; a future event waits", async () => {
    const events = [
      { providerEventId: "bad\u0000id", externalDeviceId: "DEV-2", occurredAt: NOW, kind: "HEARTBEAT" as const },
      { providerEventId: "r1", externalDeviceId: "DEV-2", occurredAt: NOW, kind: "HEARTBEAT" as const },
      { providerEventId: "ok", externalDeviceId: "DEV-2", occurredAt: NOW, kind: "HEARTBEAT" as const },
      { providerEventId: "soon", externalDeviceId: "DEV-3", occurredAt: new Date(NOW.getTime() + 60_000), kind: "HEARTBEAT" as const },
      { providerEventId: "after", externalDeviceId: "DEV-3", occurredAt: new Date(NOW.getTime() + 61_000), kind: "HEARTBEAT" as const },
      { providerEventId: "raced", externalDeviceId: "DEV-4", occurredAt: NOW, kind: "HEARTBEAT" as const },
    ]
    registerTelematicsProvider({
      id: "test-rules", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({ simulated: false, cursors: { "DEV-2": "c2", "DEV-3": "c3", "DEV-4": "c4" }, events }),
    })
    m.devices = [device("d3", "DEV-2", "test-rules"), device("d4", "DEV-3", "test-rules"), device("d5", "DEV-4", "test-rules")]
    m.ingestEvent.mockImplementationOnce(async () => { throw new TelematicsEventRejected("database refused the event (23514)") })
    m.ingestEvent.mockImplementationOnce(async () => ({ stored: true }))
    // A refusal later in the transaction, whatever its code or its text says, is a failure worth retrying.
    m.ingestEvent.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("A resolved telematics alert is final (23514)", { code: "P2010", clientVersion: "5", meta: { code: "23514" } })
    })
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ ok: false, rejected: 2, stored: 1, deferred: 1, failed: 1 })
    expect(m.ingestEvent.mock.calls.map(([, , event]) => event.providerEventId)).toEqual(["r1", "ok", "raced"])
    const rejected = m.logAudit.mock.calls.map(([entry]) => entry as { action: string; entityId: string; newValue: Record<string, unknown> })
    expect(rejected).toEqual([
      expect.objectContaining({ action: "TELEMATICS_EVENT_REJECTED", entityId: "d3", newValue: expect.objectContaining({ providerEventId: "bad?id", reason: "provider event id" }) }),
      expect.objectContaining({ action: "TELEMATICS_EVENT_REJECTED", entityId: "d3", newValue: expect.objectContaining({ providerEventId: "r1", reason: "database refused the event (23514)" }) }),
    ])
    expect(updates().find((u) => u.where.id === "d3")).toMatchObject({ data: { lastPollError: null, pollCursor: "c2", failingEventId: null, failingEventCount: 0 } })
    const waiting = updates().find((u) => u.where.id === "d4")!
    expect(waiting.data).toMatchObject({ lastPollError: null })
    expect(waiting.data).not.toHaveProperty("pollCursor")
    const raced = updates().find((u) => u.where.id === "d5")!
    expect(raced.data).toMatchObject({ lastPollError: expect.stringMatching(/retried/), failingEventId: "raced", failingEventCount: 1 })
    expect(raced.data).not.toHaveProperty("pollCursor")
  })

  it("skips an event a database refusal failed three polls in a row, audited with that reason, and moves on", async () => {
    registerTelematicsProvider({
      id: "test-stuck", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({ simulated: false, cursors: { "DEV-9": "c9" }, events: [
        { providerEventId: "stuck", externalDeviceId: "DEV-9", occurredAt: NOW, kind: "HEARTBEAT" as const },
        { providerEventId: "next", externalDeviceId: "DEV-9", occurredAt: NOW, kind: "HEARTBEAT" as const },
      ] }),
    })
    // A refusal no rule names (Prisma reports a guard's RAISE through a query without a code).
    const failure = async () => { throw new Prisma.PrismaClientUnknownRequestError("A guard refused it", { clientVersion: "5" }) }
    // Second failure on the same event: still retried.
    m.devices = [{ ...device("d9", "DEV-9", "test-stuck"), failingEventId: "stuck", failingEventCount: 1 }]
    m.ingestEvent.mockImplementationOnce(failure)
    expect(await pollTenant("t1", NOW)).toMatchObject({ failed: 1, rejected: 0 })
    expect(updates().at(-1)).toMatchObject({ data: { failingEventId: "stuck", failingEventCount: 2 } })
    // Third: skipped, audited, the next event stored, the cursor moves on and the count clears.
    m.devices = [{ ...device("d9", "DEV-9", "test-stuck"), failingEventId: "stuck", failingEventCount: 2 }]
    m.ingestEvent.mockImplementationOnce(failure)
    expect(await pollTenant("t1", NOW)).toMatchObject({ failed: 0, rejected: 1, stored: 1, ok: true })
    expect(m.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "TELEMATICS_EVENT_REJECTED", entityId: "d9", newValue: expect.objectContaining({ providerEventId: "stuck", reason: "failed 3 polls in a row (PrismaClientUnknownRequestError)" }),
    }))
    expect(updates().at(-1)).toMatchObject({ data: { pollCursor: "c9", failingEventId: null, failingEventCount: 0 } })
    // A different event failing starts the count again.
    m.devices = [{ ...device("d9", "DEV-9", "test-stuck"), failingEventId: "other", failingEventCount: 2 }]
    m.ingestEvent.mockImplementationOnce(failure)
    expect(await pollTenant("t1", NOW)).toMatchObject({ failed: 1, rejected: 0 })
    expect(updates().at(-1)).toMatchObject({ data: { failingEventId: "stuck", failingEventCount: 1 } })
  })

  it.each([
    ["a lost connection", () => new Prisma.PrismaClientKnownRequestError("can't reach the database", { code: "P1001", clientVersion: "5" })],
    ["a closed connection", () => new Prisma.PrismaClientInitializationError("server closed the connection", "5", "P1017")],
    ["a cancelled statement", () => new Prisma.PrismaClientKnownRequestError("canceling statement", { code: "P2010", clientVersion: "5", meta: { code: "57014" } })],
    ["a deadlock", () => new Prisma.PrismaClientKnownRequestError("deadlock detected", { code: "P2010", clientVersion: "5", meta: { code: "40P01" } })],
    ["a serialisation failure", () => new Prisma.PrismaClientKnownRequestError("could not serialize", { code: "P2010", clientVersion: "5", meta: { code: "40001" } })],
    ["a lock timeout", () => new Prisma.PrismaClientKnownRequestError("lock timeout", { code: "P2010", clientVersion: "5", meta: { code: "55P03" } })],
    ["a write conflict", () => new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "5" })],
    ["a pool timeout", () => new Prisma.PrismaClientKnownRequestError("pool timeout", { code: "P2024", clientVersion: "5" })],
  ])("retries %s for as long as it lasts: no strike, the cursor kept", async (_name, make) => {
    registerTelematicsProvider({
      id: "test-transient", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({ simulated: false, cursors: { "DEV-5": "c5" }, events: [{ providerEventId: "flaky", externalDeviceId: "DEV-5", occurredAt: NOW, kind: "HEARTBEAT" as const }] }),
    })
    // Two strikes already on this event: a passing fault adds none and never skips it, however often it repeats.
    m.devices = [{ ...device("d5", "DEV-5", "test-transient"), failingEventId: "flaky", failingEventCount: 2 }]
    m.ingestEvent.mockImplementationOnce(async () => { throw make() })
    expect(await pollTenant("t1", NOW)).toMatchObject({ failed: 1, rejected: 0 })
    const update = updates().at(-1)!
    expect(update.data).toMatchObject({ lastPollError: expect.stringMatching(/retried/) })
    expect(update.data).not.toHaveProperty("pollCursor")
    expect(update.data).not.toHaveProperty("failingEventCount")
  })

  it("counts a strike for anything not on the passing-fault list: a unique key, a raw integrity refusal, an unknown error", async () => {
    registerTelematicsProvider({
      id: "test-refused", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({ simulated: false, cursors: {}, events: [{ providerEventId: "r", externalDeviceId: "DEV-6", occurredAt: NOW, kind: "HEARTBEAT" as const }] }),
    })
    for (const error of [
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "5" }),
      new Prisma.PrismaClientKnownRequestError("check", { code: "P2010", clientVersion: "5", meta: { code: "23514" } }),
      new TypeError("Cannot read properties of undefined (reading 'value')"),
    ]) {
      m.devices = [device("d6", "DEV-6", "test-refused")]
      m.ingestEvent.mockImplementationOnce(async () => { throw error })
      expect(await pollTenant("t1", NOW)).toMatchObject({ failed: 1 })
      expect(updates().at(-1)).toMatchObject({ data: { failingEventId: "r", failingEventCount: 1 } })
    }
  })

  it("never skips a deadlock repeated poll after poll; skips a deterministic unknown error after three", async () => {
    registerTelematicsProvider({
      id: "test-both", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({ simulated: false, cursors: { "DEV-3": "c3" }, events: [{ providerEventId: "x", externalDeviceId: "DEV-3", occurredAt: NOW, kind: "HEARTBEAT" as const }] }),
    })
    const deadlock = () => new Prisma.PrismaClientKnownRequestError("deadlock detected", { code: "P2010", clientVersion: "5", meta: { code: "40P01" } })
    for (let poll = 0; poll < 5; poll++) {
      m.devices = [device("d3", "DEV-3", "test-both")]
      m.ingestEvent.mockImplementationOnce(async () => { throw deadlock() })
      expect(await pollTenant("t1", NOW)).toMatchObject({ failed: 1, rejected: 0 })
    }
    let stored = { failingEventId: null as string | null, failingEventCount: 0 }
    const outcomes = []
    for (let poll = 0; poll < 3; poll++) {
      m.devices = [{ ...device("d3", "DEV-3", "test-both"), ...stored }]
      m.ingestEvent.mockImplementationOnce(async () => { throw new TypeError("Cannot read properties of undefined") })
      outcomes.push(await pollTenant("t1", NOW))
      const data = updates().at(-1)!.data as { failingEventId?: string | null; failingEventCount?: number }
      stored = { failingEventId: data.failingEventId ?? null, failingEventCount: data.failingEventCount ?? 0 }
    }
    expect(outcomes.map((o) => [o.failed, o.rejected])).toEqual([[1, 0], [1, 0], [0, 1]])
    expect(m.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ providerEventId: "x", reason: "failed 3 polls in a row (TypeError)" }) }))
  })

  it("defers an event the database's clock has not reached (its \"not yet\"), keeping the cursor", async () => {
    registerTelematicsProvider({
      id: "test-not-yet", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({ simulated: false, cursors: { "DEV-4": "c4" }, events: [{ providerEventId: "soon", externalDeviceId: "DEV-4", occurredAt: NOW, kind: "HEARTBEAT" as const }] }),
    })
    m.devices = [device("d4", "DEV-4", "test-not-yet")]
    m.ingestEvent.mockImplementationOnce(async () => { throw new TelematicsEventNotYet() })
    expect(await pollTenant("t1", NOW)).toMatchObject({ deferred: 1, failed: 0, rejected: 0, ok: true })
    expect(updates().at(-1)!.data).not.toHaveProperty("pollCursor")
  })

  it("takes the simulated flag from the registered provider, never from its answer", async () => {
    registerTelematicsProvider({
      id: "test-claims-sim", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({ simulated: true, cursors: {}, events: [{ providerEventId: "m1", externalDeviceId: "DEV-7", occurredAt: NOW, kind: "HEARTBEAT" as const }] }),
    })
    m.devices = [device("d7", "DEV-7", "test-claims-sim")]
    await pollTenant("t1", NOW)
    expect(m.ingestEvent.mock.calls[0][3]).toMatchObject({ simulated: false })
  })
})
