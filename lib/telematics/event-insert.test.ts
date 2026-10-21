import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { EVENT_INTRINSIC, insertEvent } from "./event-insert"
import { TelematicsEventNotYet, TelematicsEventRejected } from "./event-shape"
import type { NormalisedTelematicsEvent } from "./types"

// The event insert's refusal is classified by its SQLSTATE (P2010 meta.code), never its message: the
// event's own refusals are permanent, the database's "not yet" is a deferral, anything else is rethrown.
const event: NormalisedTelematicsEvent = { providerEventId: "e1", externalDeviceId: "D", occurredAt: new Date("2026-09-01T10:00:00Z"), kind: "HEARTBEAT" }
const device = { id: "d1", tenantId: "t1", provider: "acme" }
const refusing = (code: string) => ({
  $queryRaw: async () => { throw new Prisma.PrismaClientKnownRequestError("Raw query failed", { code: "P2010", clientVersion: "5", meta: { code, message: `ERROR: refused ${code}` } }) },
}) as never

describe("the event insert's refusals", () => {
  it.each(["23514", "22021", "22P05", "22003", "22001"])("treats %s as the event's own, a permanent rejection with the database's message", async (code) => {
    expect(EVENT_INTRINSIC.has(code)).toBe(true)
    await expect(insertEvent(refusing(code), device, event, false)).rejects.toThrow(TelematicsEventRejected)
    await expect(insertEvent(refusing(code), device, event, false)).rejects.toThrow(`database refused the event (${code}): refused ${code}`)
  })

  it("defers the database's not yet (55000)", async () => {
    await expect(insertEvent(refusing("55000"), device, event, false)).rejects.toThrow(TelematicsEventNotYet)
  })

  it.each(["40P01", "40001", "23505", "42P10"])("rethrows %s unclassified (retried or struck by the poll)", async (code) => {
    const thrown = await insertEvent(refusing(code), device, event, false).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })
})
