/**
 * Real-Postgres proof for the duplicate-notice throttle.
 *
 * The unit tests use fakes, which can prove ORDERING (claim before send) but
 * cannot prove the thing that actually stops a double notification: the unique
 * constraint on (tenantId, channelKey, windowStart). A fake cannot execute an
 * index. Two concurrent applications from the same person is not a contrived
 * case — it is a double-tapped submit button.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/crm/lead-duplicate-notify.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { notifyPriorLeadDuplicates, type NotifyDeps } from "@/lib/crm/lead-duplicate-notify"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_dupnotice_${token}`
const agentId = `user_dupnotice_${token}`
const priorLeadId = `lead_prior_${token}`
const newLeadId = `lead_new_${token}`
const PHONE = "0820000576"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("duplicate notice throttle (real database)", () => {
  const db = new PrismaClient()

  const deps = (sent: string[]): NotifyDeps => ({
    leads: db.lead as unknown as NotifyDeps["leads"],
    throttle: db.notificationThrottle as unknown as NotifyDeps["throttle"],
    notify: async (a) => {
      sent.push(a.userId)
      return db.notification.create({
        data: {
          tenantId: a.tenantId,
          userId: a.userId,
          type: "LEAD_DUPLICATE",
          title: a.title,
          body: a.body,
          entityType: "Lead",
          entityId: a.entityId,
        },
      })
    },
    email: async () => undefined,
    now: () => Date.parse("2026-08-15T09:41:00.000Z"),
  })

  beforeAll(async () => {
    await db.tenant.create({
      data: { id: tenantId, slug: `dupnotice-${token}`, name: "Duplicate Notice IT" },
    })
    await db.user.create({
      data: {
        id: agentId,
        tenantId,
        email: `agent-${token}@test.invalid`,
        name: "Agent Owner",
        password: "x",
        role: "CREDIT_OFFICER",
      },
    })
    await db.lead.createMany({
      data: [
        {
          id: priorLeadId,
          tenantId,
          firstName: "Nhlanhla",
          lastName: "Mocktest",
          phone: PHONE,
          source: "WEBSITE",
          status: "CONTACTED",
          assignedToId: agentId,
        },
        {
          id: newLeadId,
          tenantId,
          // Same person, phone written the other way and the name carrying the
          // stray whitespace real rows carry.
          firstName: "Nhlanhla ",
          lastName: " Mocktest",
          phone: `+27${PHONE.slice(1)}`,
          source: "WEBSITE",
          status: "NEW",
        },
      ],
    })
  })

  afterAll(async () => {
    await db.notification.deleteMany({ where: { tenantId } })
    await db.notificationThrottle.deleteMany({ where: { tenantId } })
    await db.lead.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("notifies the agent once for a genuine returning applicant", async () => {
    const sent: string[] = []
    const out = await notifyPriorLeadDuplicates(
      { id: newLeadId, firstName: "Nhlanhla", lastName: "Mocktest", phone: `+27${PHONE.slice(1)}` },
      tenantId,
      deps(sent),
    )

    expect(out.matched).toBe(1)
    expect(out.notified).toBe(1)
    expect(sent).toEqual([agentId])

    const rows = await db.notification.findMany({ where: { tenantId } })
    expect(rows).toHaveLength(1)
    expect(rows[0].entityType).toBe("Lead")
    // Deep-links at the PRIOR lead — the one the agent is working.
    expect(rows[0].entityId).toBe(priorLeadId)
  })

  it("does NOT notify again inside the same window", async () => {
    const sent: string[] = []
    const out = await notifyPriorLeadDuplicates(
      { id: newLeadId, firstName: "Nhlanhla", lastName: "Mocktest", phone: `+27${PHONE.slice(1)}` },
      tenantId,
      deps(sent),
    )

    expect(out.skippedByThrottle).toBe(1)
    expect(out.notified).toBe(0)
    expect(sent).toEqual([])
    expect(await db.notification.count({ where: { tenantId } })).toBe(1)
  })

  it("serialises CONCURRENT claims — a double-tapped submit sends one notice", async () => {
    // THE assertion this file exists for. Clear the window first so both racers
    // start from nothing; a fake cannot demonstrate this because the exclusion
    // is performed by the unique index, not by application code.
    await db.notificationThrottle.deleteMany({ where: { tenantId } })
    await db.notification.deleteMany({ where: { tenantId } })

    const sent: string[] = []
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        notifyPriorLeadDuplicates(
          { id: newLeadId, firstName: "Nhlanhla", lastName: "Mocktest", phone: `+27${PHONE.slice(1)}` },
          tenantId,
          deps(sent),
        ),
      ),
    )

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof notifyPriorLeadDuplicates>>
    >[]
    expect(fulfilled).toHaveLength(5)

    const notified = fulfilled.reduce((sum, r) => sum + r.value.notified, 0)
    const skipped = fulfilled.reduce((sum, r) => sum + r.value.skippedByThrottle, 0)

    expect(notified).toBe(1)
    expect(skipped).toBe(4)
    expect(sent).toHaveLength(1)
    expect(await db.notification.count({ where: { tenantId } })).toBe(1)
  })

  it("does not send a SECOND bell when only the email failed", async () => {
    // Regression: the email failure used to release the throttle claim. The
    // bell row was already written and cannot be un-written, so the next
    // genuine submission re-claimed the freed window and wrote a duplicate
    // alert — one SMTP blip defeating the one-notice-per-window guarantee.
    await db.notificationThrottle.deleteMany({ where: { tenantId } })
    await db.notification.deleteMany({ where: { tenantId } })

    const sent: string[] = []
    const failingEmail: NotifyDeps = {
      ...deps(sent),
      email: async () => { throw new Error("smtp down") },
    }
    const subject = { id: newLeadId, firstName: "Nhlanhla", lastName: "Mocktest", phone: `+27${PHONE.slice(1)}` }

    const first = await notifyPriorLeadDuplicates(subject, tenantId, failingEmail)
    expect(first.notified).toBe(1)
    expect(await db.notification.count({ where: { tenantId } })).toBe(1)

    // A later genuine submission in the same window must find the claim intact.
    const second = await notifyPriorLeadDuplicates(subject, tenantId, deps(sent))
    expect(second.skippedByThrottle).toBe(1)
    expect(second.notified).toBe(0)
    expect(await db.notification.count({ where: { tenantId } })).toBe(1)
  })

  it("does not match a different person on the same phone", async () => {
    // A shared phone forbids a phone-only key.
    const sent: string[] = []
    const out = await notifyPriorLeadDuplicates(
      { id: `${newLeadId}_other`, firstName: "Marie", lastName: "Mocktest", phone: `+27${PHONE.slice(1)}` },
      tenantId,
      deps(sent),
    )
    expect(out.matched).toBe(0)
    expect(sent).toEqual([])
  })
})
