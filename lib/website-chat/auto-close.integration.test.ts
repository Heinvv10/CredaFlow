/**
 * Real-Postgres proof of the idle website-chat close rule.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/auto-close.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient, type ConvStatus } from "@prisma/client"
import { runWithTenant } from "@/lib/tenant-scope"
import { closeIdleChats, closeIfStillIdle } from "./auto-close"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("closeIdleChats", () => {
  const db = new PrismaClient()
  const mine = `tenant_web_close_${token}`
  const other = `tenant_web_close2_${token}`
  const now = new Date("2026-09-30T10:00:00Z")
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const HOUR = 60 * 60 * 1000
  const ids: Record<string, string> = {}

  async function thread(tenantId: string, key: string, a: { channel?: "CHATBOT" | "WHATSAPP"; status?: ConvStatus; lastActivityAt: Date | null; closedAt?: Date }) {
    const contact = await db.contact.create({ data: { tenantId, status: "LEAD", firstSeenChannel: a.channel ?? "CHATBOT", firstName: key } })
    const c = await db.conversation.create({
      data: { tenantId, contactId: contact.id, channel: a.channel ?? "CHATBOT", status: a.status ?? "OPEN", lastActivityAt: a.lastActivityAt, closedAt: a.closedAt ?? null },
    })
    // As if nobody has touched the thread since its last message (Prisma stamps updatedAt = now).
    await db.$executeRaw`UPDATE "Conversation" SET "updatedAt" = ${a.lastActivityAt ?? now} WHERE id = ${c.id}`
    ids[key] = c.id
  }

  beforeAll(async () => {
    for (const id of [mine, other]) await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website chat close IT", domain: null } })
    await thread(mine, "idleOpen", { lastActivityAt: ago(25 * HOUR) })
    await thread(mine, "idleAwaitingCustomer", { status: "PENDING_CUSTOMER", lastActivityAt: ago(48 * HOUR) })
    await thread(mine, "idleHandedOff", { status: "PENDING_INTERNAL", lastActivityAt: ago(48 * HOUR) })
    await thread(mine, "recent", { lastActivityAt: ago(23.5 * HOUR) })
    await thread(mine, "justUnder", { lastActivityAt: ago(24 * HOUR - 1000) })
    await thread(mine, "exactly24h", { lastActivityAt: ago(24 * HOUR) })
    await thread(mine, "noActivity", { lastActivityAt: null })
    await thread(mine, "idleWhatsApp", { channel: "WHATSAPP", lastActivityAt: ago(48 * HOUR) })
    await thread(mine, "alreadyClosed", { status: "CLOSED", lastActivityAt: ago(48 * HOUR), closedAt: ago(30 * HOUR) })
    await thread(other, "otherTenantIdle", { lastActivityAt: ago(48 * HOUR) })
    // Handed off two days ago; a staffer called back just now and moved it to PENDING_CUSTOMER
    // (status, assignment and notes bump updatedAt, never lastActivityAt).
    await thread(mine, "staffWorking", { status: "PENDING_INTERNAL", lastActivityAt: ago(48 * HOUR) })
    await db.conversation.update({ where: { id: ids.staffWorking }, data: { status: "PENDING_CUSTOMER" } })
  })

  afterAll(async () => {
    for (const id of [mine, other]) {
      await db.auditLog.deleteMany({ where: { tenantId: id } })
      await db.conversation.deleteMany({ where: { tenantId: id } })
      await db.contact.deleteMany({ where: { tenantId: id } })
      await db.tenant.delete({ where: { id } })
    }
    await db.$disconnect()
  })

  const state = async (key: string) => db.conversation.findUniqueOrThrow({ where: { id: ids[key] }, select: { status: true, closedAt: true } })

  it("closes this tenant's chats nobody has touched for 24h unless handed off, and audits each close once", async () => {
    expect(await runWithTenant(mine, () => closeIdleChats(mine, now))).toEqual({ closed: 2 })

    for (const key of ["idleOpen", "idleAwaitingCustomer"]) expect(await state(key)).toEqual({ status: "CLOSED", closedAt: now })
    for (const key of ["idleHandedOff", "recent", "justUnder", "exactly24h", "noActivity", "idleWhatsApp", "staffWorking"]) expect((await state(key)).closedAt).toBeNull()
    expect(await state("alreadyClosed")).toEqual({ status: "CLOSED", closedAt: ago(30 * HOUR) })
    expect((await state("otherTenantIdle")).closedAt).toBeNull()

    const audits = await db.auditLog.findMany({ where: { tenantId: mine, action: "WEBSITE_CHAT_AUTO_CLOSED" }, orderBy: { entityId: "asc" } })
    expect(audits.map((a) => a.entityId).sort()).toEqual([ids.idleOpen, ids.idleAwaitingCustomer].sort())
    expect(audits.every((a) => a.entity === "Conversation" && a.userId === null)).toBe(true)
    expect(audits.map((a) => a.oldValue)).toEqual(expect.arrayContaining([{ status: "OPEN" }, { status: "PENDING_CUSTOMER" }]))
    expect(audits[0].newValue).toEqual({ status: "CLOSED", rule: "website_chat_idle_24h" })
  })

  it("a second run closes nothing and writes no more audit rows", async () => {
    expect(await runWithTenant(mine, () => closeIdleChats(mine, now))).toEqual({ closed: 0 })
    expect(await db.auditLog.count({ where: { tenantId: mine, action: "WEBSITE_CHAT_AUTO_CLOSED" } })).toBe(2)
  })

  it("a chat staff reopen is not closed again by the next run", async () => {
    // The same write setConversationStatus makes (lib/inbox/thread-actions.ts).
    await db.conversation.updateMany({ where: { id: ids.idleOpen, tenantId: mine }, data: { status: "OPEN", closedAt: null } })
    // The fixture clock, not the wall clock: the reopen stamps updatedAt with the real time,
    // which is after the fixture cutoff, while every other fixture stays as it was.
    expect(await runWithTenant(mine, () => closeIdleChats(mine, now))).toEqual({ closed: 0 })
    expect((await state("idleOpen")).closedAt).toBeNull()
  })

  it("the close re-checks the rule, so a thread picked while idle that has since moved on is left alone", async () => {
    // What a visitor message or a hand-off between the candidate read and the close looks like.
    await thread(mine, "raced", { lastActivityAt: ago(48 * HOUR) })
    await db.conversation.update({ where: { id: ids.raced }, data: { lastActivityAt: now } })
    expect(await runWithTenant(mine, () => closeIfStillIdle(mine, { id: ids.raced, status: "OPEN" }, now))).toBe(false)
    expect(await runWithTenant(mine, () => closeIfStillIdle(mine, { id: ids.idleHandedOff, status: "OPEN" }, now))).toBe(false)
    // Read as OPEN, then moved to PENDING_CUSTOMER (still idle): the audit's oldValue would be wrong, so no close.
    await thread(mine, "statusMoved", { status: "PENDING_CUSTOMER", lastActivityAt: ago(48 * HOUR) })
    expect(await runWithTenant(mine, () => closeIfStillIdle(mine, { id: ids.statusMoved, status: "OPEN" }, now))).toBe(false)
    expect((await state("statusMoved")).closedAt).toBeNull()
    // Another tenant's run cannot close this tenant's idle thread, even outside a tenant frame.
    await thread(mine, "crossTenant", { lastActivityAt: ago(48 * HOUR) })
    expect(await closeIfStillIdle(other, { id: ids.crossTenant, status: "OPEN" }, now)).toBe(false)
    for (const key of ["raced", "idleHandedOff", "crossTenant"]) expect((await state(key)).closedAt).toBeNull()
    expect(await db.auditLog.count({ where: { entityId: { in: [ids.raced, ids.idleHandedOff, ids.crossTenant] } } })).toBe(0)
  })

  it("if the audit row cannot be written the close rolls back with it", async () => {
    await thread(mine, "auditFails", { lastActivityAt: ago(48 * HOUR) })
    // Throwaway-DB-only trigger that rejects this one thread's audit row.
    const fn = `wc_audit_fail_${token}`
    await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."entityId" = '${ids.auditFails}' THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$`)
    await db.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
    try {
      await expect(runWithTenant(mine, () => closeIfStillIdle(mine, { id: ids.auditFails, status: "OPEN" }, now))).rejects.toThrow(/audit refused/)
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "AuditLog"`)
      await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`)
    }
    expect(await state("auditFails")).toEqual({ status: "OPEN", closedAt: null })
  })

  it("if the close fails at commit, after its audit row was written, no audit row survives", async () => {
    await thread(mine, "commitFails", { lastActivityAt: ago(48 * HOUR) })
    // Throwaway-DB-only deferred trigger: the close's UPDATE is rejected at COMMIT.
    const fn = `wc_commit_fail_${token}`
    await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${ids.commitFails}' THEN RAISE EXCEPTION 'commit refused'; END IF; RETURN NEW; END $$`)
    await db.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER ${fn} AFTER UPDATE ON "Conversation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
    try {
      // allSettled: Prisma 5.22's interactive $transaction RESOLVES when COMMIT is rejected
      // (the batch form throws). The committed outcome is what this test asserts.
      await Promise.allSettled([runWithTenant(mine, () => closeIfStillIdle(mine, { id: ids.commitFails, status: "OPEN" }, now))])
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "Conversation"`)
      await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`)
    }
    expect(await state("commitFails")).toEqual({ status: "OPEN", closedAt: null })
    expect(await db.auditLog.count({ where: { entityId: ids.commitFails } })).toBe(0)
  })
})
