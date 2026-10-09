/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach, describe } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findUniqueMock = vi.fn()
const upsertMock = vi.fn()
const submitMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: string) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    messageTemplate: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      upsert: (...a: unknown[]) => upsertMock(...a),
    },
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => {
  // Real AuditAction constants — a mocked-out map would let a typo'd action
  // name pass, which is exactly what registering them is meant to prevent.
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { logAudit: vi.fn(), AuditAction: actual.AuditAction }
})
vi.mock("@/lib/whatsapp/template-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/template-submit")>()
  return { wabaFieldsChanged: actual.wabaFieldsChanged, submitTemplateForApproval: (...a: unknown[]) => submitMock(...a) }
})

import { POST } from "./route"
import { logAudit } from "@/lib/audit"

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl1", tenantId: "t1", event: "loan_approved", channel: "EMAIL",
    key: null, subject: "s", body: "b", active: true,
    wabaTemplateName: null, language: "en", headerContent: null,
    bodyTemplate: null, footer: null, buttons: null,
    providerStatus: null, providerTemplateId: null,
    ...overrides,
  }
}

function post(body: unknown) {
  return POST(new NextRequest("http://x/api/settings/notifications", {
    method: "POST", body: JSON.stringify(body),
  }))
}

const VALID = { event: "loan_approved", channel: "EMAIL", body: "Hello {{firstName}}", subject: "Hi" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "LOAN_ADMIN" } })
  findUniqueMock.mockResolvedValue(null)
  upsertMock.mockImplementation(async () => row())
})

describe("system templates are not writable here", () => {
  // Dispatch resolves templates by `key`; this route never writes one, so it can
  // only ever OVERWRITE a seeded default row, never author a usable template.
  it("refuses a key-bearing row with 409 and writes nothing", async () => {
    findUniqueMock.mockResolvedValue(row({ key: "loan_approved_email" }))
    const res = await post(VALID)
    expect(res.status).toBe(409)
    const { error } = await res.json()
    expect(error).toMatch(/loan_approved_email/)
    // Templates are seeded per tenant (or created by one); no migration writes them.
    expect(error).toMatch(/system template, sent by its key/)
    expect(error).not.toMatch(/migration/)
    expect(upsertMock).not.toHaveBeenCalled()
    // The refusal is itself auditable — one of these rows is the s.129 notice,
    // and "someone tried" is what an auditor asks about.
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "NOTIFICATION_TEMPLATE_UPDATE_REFUSED",
      entityId: "tpl1",
    }))
  })

  // `if (before?.key)` would let a blank key through on truthiness; the sibling
  // WABA route treats "" as a real stored state, so the shape can exist.
  it("refuses a row whose key is blank, not just non-empty", async () => {
    findUniqueMock.mockResolvedValue(row({ key: "" }))
    const res = await post(VALID)
    expect(res.status).toBe(409)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  // The one that matters legally: section129_email carries NCA-mandated text
  // that CLAUDE.md requires legal sign-off to change, and its consumer resolves
  // it by key with only an active/statutoryOverride guard.
  it("refuses the Section 129 statutory template", async () => {
    findUniqueMock.mockResolvedValue(row({ event: "section129_sent", key: "section129_email" }))
    const res = await post({ ...VALID, event: "section129_sent" })
    expect(res.status).toBe(409)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("still allows a keyless row through", async () => {
    findUniqueMock.mockResolvedValue(row({ key: null }))
    const res = await post(VALID)
    expect(res.status).toBe(200)
    expect(upsertMock).toHaveBeenCalled()
  })
})

describe("audit", () => {
  it("records the write with the template id and both bodies", async () => {
    findUniqueMock.mockResolvedValue(row({ body: "OLD" }))
    upsertMock.mockResolvedValue(row({ body: "Hello {{firstName}}" }))
    await post(VALID)
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", userId: "u1", userEmail: "a@b.c",
      entity: "MessageTemplate", entityId: "tpl1",
      oldValue: expect.objectContaining({ body: "OLD" }),
      newValue: expect.objectContaining({ body: "Hello {{firstName}}" }),
    }))
  })

  it("audits a first-time create with a null before-image", async () => {
    findUniqueMock.mockResolvedValue(null)
    await post(VALID)
    expect(vi.mocked(logAudit).mock.calls[0][0].oldValue).toBeNull()
  })
})

describe("existing contract is unchanged", () => {
  it("rejects a lowercase channel, as the Channel enum requires", async () => {
    const res = await post({ ...VALID, channel: "email" })
    expect(res.status).toBe(400)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("requires event, channel and body", async () => {
    expect((await post({ channel: "EMAIL", body: "b" })).status).toBe(400)
    expect((await post({ event: "e", body: "b" })).status).toBe(400)
    expect((await post({ event: "e", channel: "EMAIL" })).status).toBe(400)
  })

  it("does not fire the WABA submit for an sms/email save", async () => {
    upsertMock.mockResolvedValue(row({ wabaTemplateName: null }))
    await post(VALID)
    expect(submitMock).not.toHaveBeenCalled()
  })
})
