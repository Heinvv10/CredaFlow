import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { messageTemplate: { updateMany: vi.fn() } },
}))

import { prisma } from "@/lib/prisma"
import { parseWabaTemplateStatuses, applyWabaTemplateStatuses } from "./template-status"

function payload(changes: unknown[]) {
  return { entry: [{ changes }] }
}

beforeEach(() => vi.clearAllMocks())

describe("parseWabaTemplateStatuses", () => {
  it("reads name + event from a message_template_status_update change", () => {
    expect(
      parseWabaTemplateStatuses(
        payload([
          {
            field: "message_template_status_update",
            value: { message_template_name: "loan_approved", event: "APPROVED", message_template_language: "en" },
          },
        ]),
      ),
    ).toEqual([{ name: "loan_approved", status: "APPROVED", language: "en" }])
  })

  // The whole reason this handler exists: the poll re-checks PENDING rows
  // only, so these two transitions can NEVER land through it. A paused
  // template would keep reading APPROVED locally and fail at Meta with no
  // local signal.
  it("carries the PAUSED and DISABLED transitions the poll cannot see", () => {
    const parsed = parseWabaTemplateStatuses(
      payload([
        { field: "message_template_status_update", value: { message_template_name: "a", event: "PAUSED" } },
        { field: "message_template_status_update", value: { message_template_name: "b", event: "DISABLED" } },
      ]),
    )
    expect(parsed).toEqual([
      { name: "a", status: "PAUSED", language: null },
      { name: "b", status: "DISABLED", language: null },
    ])
  })

  it("ignores changes for other fields", () => {
    expect(
      parseWabaTemplateStatuses(
        payload([
          { field: "messages", value: { messages: [{ id: "wamid.x" }] } },
          { field: "message_template_quality_update", value: { message_template_name: "a", event: "APPROVED" } },
        ]),
      ),
    ).toEqual([])
  })

  it("returns [] for junk rather than throwing", () => {
    expect(parseWabaTemplateStatuses(null)).toEqual([])
    expect(parseWabaTemplateStatuses({ entry: "nope" })).toEqual([])
    expect(parseWabaTemplateStatuses(payload([{ field: "message_template_status_update", value: {} }]))).toEqual([])
  })
})

describe("applyWabaTemplateStatuses", () => {
  it("writes providerStatus scoped to the tenant and template name", async () => {
    vi.mocked(prisma.messageTemplate.updateMany).mockResolvedValue({ count: 1 } as never)

    const n = await applyWabaTemplateStatuses("tn1", [{ name: "loan_approved", status: "APPROVED", language: "en" }])

    expect(n).toBe(1)
    expect(prisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", wabaTemplateName: "loan_approved", language: "en" },
      data: { providerStatus: "APPROVED" },
    })
  })

  it("applies a PAUSED downgrade to an already-APPROVED template", async () => {
    vi.mocked(prisma.messageTemplate.updateMany).mockResolvedValue({ count: 1 } as never)
    await applyWabaTemplateStatuses("tn1", [{ name: "loan_overdue", status: "PAUSED", language: null }])
    expect(prisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", wabaTemplateName: "loan_overdue" },
      data: { providerStatus: "PAUSED" },
    })
  })

  // Meta's `event` vocabulary is wider than the four obvious values —
  // REINSTATED, IN_APPEAL, PENDING_DELETION, FLAGGED, ARCHIVED all occur.
  // Writing one verbatim is a PERMANENT stuck state: whatsapp-cloud.ts gates
  // on === "APPROVED" so the template is unsendable, and poll-wa-templates
  // only re-checks rows whose providerStatus is "PENDING", so nothing can
  // ever reconcile it. Unknown values must therefore leave the row where the
  // poll can still see it.
  it("resets an UNRECOGNISED event to PENDING so the poll can reconcile", async () => {
    vi.mocked(prisma.messageTemplate.updateMany).mockResolvedValue({ count: 1 } as never)
    await applyWabaTemplateStatuses("tn1", [{ name: "a", status: "PENDING_DELETION", language: null }])
    expect(prisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", wabaTemplateName: "a" },
      data: { providerStatus: "PENDING" },
    })
  })

  it("maps REINSTATED to APPROVED rather than stranding the template", async () => {
    vi.mocked(prisma.messageTemplate.updateMany).mockResolvedValue({ count: 1 } as never)
    await applyWabaTemplateStatuses("tn1", [{ name: "a", status: "REINSTATED", language: null }])
    expect(prisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", wabaTemplateName: "a" },
      data: { providerStatus: "APPROVED" },
    })
  })

  // Meta keys a template by name + LANGUAGE: en can be APPROVED while af is
  // REJECTED. wabaTemplateName is not unique here, so an unscoped write puts
  // the English verdict on the Afrikaans row.
  it("scopes the write to the language when Meta supplies one", async () => {
    vi.mocked(prisma.messageTemplate.updateMany).mockResolvedValue({ count: 1 } as never)
    await applyWabaTemplateStatuses("tn1", [{ name: "a", status: "REJECTED", language: "af" }])
    expect(prisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", wabaTemplateName: "a", language: "af" },
      data: { providerStatus: "REJECTED" },
    })
  })

  it("omits the language filter when Meta supplies none", async () => {
    vi.mocked(prisma.messageTemplate.updateMany).mockResolvedValue({ count: 1 } as never)
    await applyWabaTemplateStatuses("tn1", [{ name: "a", status: "APPROVED", language: null }])
    expect(prisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", wabaTemplateName: "a" },
      data: { providerStatus: "APPROVED" },
    })
  })

  it("does not write for a template this tenant does not have", async () => {
    vi.mocked(prisma.messageTemplate.updateMany).mockResolvedValue({ count: 0 } as never)
    const n = await applyWabaTemplateStatuses("tn1", [{ name: "unknown", status: "APPROVED", language: null }])
    expect(n).toBe(0)
  })
})
