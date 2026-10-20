/**
 * Real transaction proof for the staff-reminder Message/projection/audit path.
 * Run only against a throwaway, fully migrated PostgreSQL database:
 *
 *   RUN_STAFF_TASK_REMINDER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/staff-task-reminder.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant, withoutTenantScope } from "@/lib/tenant-scope"
import { sendStaffTaskReminder } from "./staff-task-reminder"

const RUN = process.env.RUN_STAFF_TASK_REMINDER_IT === "1"
const suite = RUN ? describe : describe.skip

suite("staff task reminder authoritative delivery", () => {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_staff_reminder_${token}`
  // A second tenant with WhatsApp switched OFF (the CommsSettings default).
  const offTenantId = `tenant_staff_reminder_off_${token}`
  const taskId = `task_staff_reminder_${token}`
  const leadId = `lead_staff_reminder_${token}`
  const dueAt = new Date("2026-07-22T09:00:00.000Z")
  const priorWaEnabled = process.env.WA_ENABLED
  const priorWaDryRun = process.env.WA_DRY_RUN

  beforeAll(async () => {
    process.env.WA_ENABLED = "true"
    process.env.WA_DRY_RUN = "true"
    await withoutTenantScope(() => prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `staff-reminder-${token}`,
        name: "Synthetic staff reminder tenant",
      },
    }))
    // The WhatsApp send gate (lib/whatsapp/kill-switch.ts) reads the tenant's
    // CommsSettings; without a row with whatsappEnabled=true the reminder is
    // refused, which is the intended behaviour for a tenant that has WhatsApp off.
    await withoutTenantScope(() => prisma.commsSettings.create({
      data: { tenantId, whatsappEnabled: true },
    }))
    await withoutTenantScope(() => prisma.tenant.create({
      data: {
        id: offTenantId,
        slug: `staff-reminder-off-${token}`,
        name: "Synthetic staff reminder tenant, WhatsApp off",
      },
    }))
    await withoutTenantScope(() => prisma.commsSettings.create({
      data: { tenantId: offTenantId, whatsappEnabled: false },
    }))
  })

  afterAll(() => {
    if (priorWaEnabled === undefined) delete process.env.WA_ENABLED
    else process.env.WA_ENABLED = priorWaEnabled
    if (priorWaDryRun === undefined) delete process.env.WA_DRY_RUN
    else process.env.WA_DRY_RUN = priorWaDryRun
  })

  it("stores one simulated Message, one linked projection, and one truthful audit on replay", async () => {
    const args = {
      tenantId,
      taskId,
      leadId,
      dueAt,
      recipientUserId: `user_staff_reminder_${token}`,
      recipientName: "Synthetic Staff",
      recipientEmail: `staff-${token}@example.test`,
      channel: "WHATSAPP" as const,
      toValue: "0821234567",
      text: "Synthetic task reminder; no external traffic",
    }

    const first = await runWithTenant(tenantId, () => sendStaffTaskReminder(args))
    const replay = await runWithTenant(tenantId, () => sendStaffTaskReminder(args))

    expect(first).toMatchObject({ outcome: "simulated", recorded: true })
    expect(replay).toMatchObject({
      outcome: "simulated",
      recorded: true,
      messageId: first.messageId,
    })
    expect(first.messageId).toBeTruthy()

    const messages = await withoutTenantScope(() => prisma.message.findMany({
      where: {
        tenantId,
        idempotencyKey: `lead-task-reminder:${taskId}:${dueAt.toISOString()}:WHATSAPP`,
      },
      select: {
        id: true,
        status: true,
        dispatchState: true,
        providerMessageId: true,
        dispatchProviderMessageId: true,
        dispatchProviderAcceptedAt: true,
        simulationReceiptId: true,
      },
    }))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: first.messageId,
      status: "SIMULATED",
      dispatchState: "SIMULATED",
      providerMessageId: null,
      dispatchProviderMessageId: null,
      dispatchProviderAcceptedAt: null,
    })
    expect(messages[0].simulationReceiptId).toMatch(/^dry-run-/)

    const notifications = await withoutTenantScope(() => prisma.notificationLog.findMany({
      where: { tenantId, event: "lead_task_reminder" },
      select: { status: true, messageId: true, channel: true },
    }))
    expect(notifications).toEqual([{
      status: "simulated",
      messageId: first.messageId,
      channel: "whatsapp",
    }])

    const audits = await withoutTenantScope(() => prisma.auditLog.findMany({
      where: {
        tenantId,
        entity: "AgentTask",
        entityId: taskId,
        action: "LEAD_TASK_REMINDER_SIMULATED",
      },
      select: { newValue: true },
    }))
    expect(audits).toHaveLength(1)
    expect(audits[0].newValue).toEqual(expect.objectContaining({
      messageId: first.messageId,
      outcome: "simulated",
      status: "simulated",
      leadId,
    }))

    const staffContacts = await withoutTenantScope(() => prisma.contact.findMany({
      where: { tenantId, status: "STAFF" },
      select: { id: true, primaryWaJid: true, identities: { select: { channel: true, value: true } } },
    }))
    expect(staffContacts).toHaveLength(1)
    expect(staffContacts[0]).toMatchObject({
      primaryWaJid: "27821234567@s.whatsapp.net",
      identities: [{ channel: "WHATSAPP", value: "27821234567@s.whatsapp.net" }],
    })
  })

  it("rejects a shared endpoint owned by a different staff user", async () => {
    const sharedDestination = "0827654321"
    const firstTaskId = `task_staff_owner_a_${token}`
    const secondTaskId = `task_staff_owner_b_${token}`
    const first = await runWithTenant(tenantId, () => sendStaffTaskReminder({
      tenantId,
      taskId: firstTaskId,
      leadId,
      dueAt,
      recipientUserId: `user_staff_owner_a_${token}`,
      recipientName: "Synthetic Staff A",
      recipientEmail: `staff-a-${token}@example.test`,
      channel: "WHATSAPP",
      toValue: sharedDestination,
      text: "Synthetic staff A reminder; no external traffic",
    }))
    const second = await runWithTenant(tenantId, () => sendStaffTaskReminder({
      tenantId,
      taskId: secondTaskId,
      leadId,
      dueAt,
      recipientUserId: `user_staff_owner_b_${token}`,
      recipientName: "Synthetic Staff B",
      recipientEmail: `staff-b-${token}@example.test`,
      channel: "WHATSAPP",
      toValue: sharedDestination,
      text: "Synthetic staff B reminder; no external traffic",
    }))

    expect(first).toMatchObject({ outcome: "simulated", recorded: true })
    expect(second).toMatchObject({
      outcome: "failed",
      recorded: true,
      messageId: null,
      error: expect.stringMatching(/different staff user/i),
    })

    const identity = await withoutTenantScope(() => prisma.contactIdentity.findFirstOrThrow({
      where: {
        tenantId,
        channel: "WHATSAPP",
        value: "27827654321@s.whatsapp.net",
      },
      select: {
        contact: {
          select: { firstSeenContext: true },
        },
      },
    }))
    expect(identity.contact.firstSeenContext).toBe(`staff_task_reminder:user_staff_owner_a_${token}`)
    expect(await withoutTenantScope(() => prisma.message.count({
      where: {
        tenantId,
        idempotencyKey: `lead-task-reminder:${secondTaskId}:${dueAt.toISOString()}:WHATSAPP`,
      },
    }))).toBe(0)
  })

  it("a tenant with WhatsApp switched off gets a refused reminder, not a crash, and no WhatsApp message", async () => {
    const args = {
      tenantId: offTenantId,
      taskId: `task_staff_reminder_off_${token}`,
      leadId,
      dueAt,
      recipientUserId: `user_staff_reminder_off_${token}`,
      recipientName: "Synthetic Staff Off",
      recipientEmail: `staff-off-${token}@example.test`,
      channel: "WHATSAPP" as const,
      toValue: "0829998888",
      text: "Synthetic task reminder; no external traffic",
    }

    const result = await runWithTenant(offTenantId, () => sendStaffTaskReminder(args))

    expect(result).toMatchObject({ outcome: "failed", recorded: true })
    expect(result.error).toMatch(/whatsapp\s+disabled/i)
    const messages = await withoutTenantScope(() => prisma.message.findMany({
      where: { tenantId: offTenantId },
      select: { status: true, simulationReceiptId: true, providerMessageId: true },
    }))
    for (const m of messages) {
      expect(m.status).not.toBe("SIMULATED")
      expect(m.simulationReceiptId).toBeNull()
      expect(m.providerMessageId).toBeNull()
    }
  })
})
