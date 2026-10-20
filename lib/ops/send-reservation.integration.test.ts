/**
 * Real-Postgres proof of the per-message reservation (lib/ops/send-reservation.ts):
 * of overlapping runs only one may send a given message on a given SAST day, and a
 * reservation is released against the day it was taken, never the day it is
 * released.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/ops/send-reservation.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { releaseReservation, reserveOnce } from "@/lib/ops/send-reservation"
import { prisma } from "@/lib/prisma"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const T = "t_reservation_it"

suite.sequential("send reservations (real Postgres)", () => {
  beforeAll(async () => {
    await db.sendReservation.deleteMany({ where: { tenantId: T } })
  })
  afterAll(async () => {
    await db.sendReservation.deleteMany({ where: { tenantId: T } })
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("of racing reservations for one message on one day, exactly one wins", async () => {
    const at = new Date("2026-11-06T05:00:00Z")
    const wins = await Promise.all([1, 2, 3, 4].map(() => reserveOnce(T, "send:loan_x:reminder_7d:whatsapp", at)))
    expect(wins.filter(Boolean)).toHaveLength(1)
    expect(await reserveOnce(T, "send:loan_x:reminder_7d:whatsapp", new Date("2026-11-06T18:00:00Z"))).toBe(false)
  })

  it("is per message and per SAST day, and a released reservation can be taken again", async () => {
    const at = new Date("2026-11-07T05:00:00Z")
    expect(await reserveOnce(T, "send:loan_y:reminder_7d:sms", at)).toBe(true)
    expect(await reserveOnce(T, "send:loan_y:reminder_7d:whatsapp", at), "another channel").toBe(true)
    expect(await reserveOnce(T, "send:loan_y:reminder_7d:sms", new Date("2026-11-08T05:00:00Z")), "the next day").toBe(true)
    await releaseReservation("send:loan_y:reminder_7d:sms", at)
    expect(await reserveOnce(T, "send:loan_y:reminder_7d:sms", at)).toBe(true)
  })

  it("a release after midnight deletes the day it was taken, not the next day's reservation", async () => {
    const takenBeforeMidnight = new Date("2026-11-09T21:59:00Z") // 23:59 SAST on the 9th
    const takenAfterMidnight = new Date("2026-11-09T22:01:00Z") // 00:01 SAST on the 10th
    expect(await reserveOnce(T, "send:loan_z:reminder_1d:sms", takenBeforeMidnight)).toBe(true)
    expect(await reserveOnce(T, "send:loan_z:reminder_1d:sms", takenAfterMidnight)).toBe(true)

    // The first run finishes after midnight and gives back ITS reservation.
    await releaseReservation("send:loan_z:reminder_1d:sms", takenBeforeMidnight)

    const days = (await db.sendReservation.findMany({ where: { key: "send:loan_z:reminder_1d:sms" } })).map((r) => r.runDay)
    expect(days).toEqual(["2026-11-10"])
  })

  it("records the tenant it was taken for", async () => {
    await reserveOnce(T, "send:loan_w:reminder_0d:sms", new Date("2026-11-11T05:00:00Z"))
    expect((await db.sendReservation.findFirstOrThrow({ where: { key: "send:loan_w:reminder_0d:sms" } })).tenantId).toBe(T)
  })
})
