/**
 * Real-Postgres proof that the abandoned-chat release keeps its 10 minutes when the
 * database session is not in UTC. The stamps are UTC timestamps without a zone and a
 * raw JS Date reaches Postgres as timestamptz, so a bare comparison shifts by the
 * session's offset (two hours in Johannesburg).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/staff-auto-release-tz.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// Every connection of the app's client opens in Johannesburg time.
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@prisma/client")
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://unset")
  url.searchParams.set("options", "-c TimeZone=Africa/Johannesburg")
  return { prisma: new PrismaClient({ datasources: { db: { url: url.toString() } } }) }
})

import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { joinChat, releaseIdleChats } from "./staff"
import { recordVisitorMessageToStaff, startChat } from "./store"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("abandoned-chat release in a non-UTC database session", () => {
  const db = new PrismaClient()
  const tenantId = `tenant_web_release_tz_${token}`
  const staff = `user_release_tz_${token}`
  const t0 = new Date("2026-09-29T10:00:00Z")
  const at = (min: number) => new Date(t0.getTime() + min * 60_000)

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `web-release-tz-${token}`, name: "Website chat release tz IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    await db.user.create({ data: { id: staff, tenantId, email: `${staff}@test.invalid`, password: "x", name: "Thandi Mokoena" } })
  })

  afterAll(async () => {
    const where = { tenantId }
    await purgeAuditRowsForTest(db, where)
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where })
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.tenantConfig.deleteMany({ where: { tenantId: tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("the session really is in Johannesburg time", async () => {
    expect(await prisma.$queryRaw`SELECT current_setting('TimeZone') AS tz`).toEqual([{ tz: "Africa/Johannesburg" }])
  })

  it("a visitor left waiting is released at 10 minutes, not at 1", async () => {
    const id = (await startChat({ brand: "Acme Lending", tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550008", email: `${randomUUID()}@test.invalid` }, now: t0 })).conversationId
    expect(await joinChat({ tenantId, conversationId: id, staffUserId: staff, now: at(1) })).toEqual({ ok: true })
    expect(await recordVisitorMessageToStaff({ tenantId, conversationId: id, text: "Are you there?", now: at(2) })).toEqual({ accepted: true })
    // The stamp itself is the UTC instant (stampThread converts).
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).lastInboundAt).toEqual(at(2))

    expect(await releaseIdleChats(tenantId, at(3))).toBe(0)
    expect(await releaseIdleChats(tenantId, at(11))).toBe(0)
    expect(await releaseIdleChats(tenantId, at(12))).toBe(1)
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).assigneeId).toBeNull()
  })
})
