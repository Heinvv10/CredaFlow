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
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      upsert: (...args: unknown[]) => upsertMock(...args),
    },
  },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))
vi.mock("@/lib/whatsapp/template-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/template-submit")>()
  return {
    // wabaFieldsChanged is the REAL implementation — the change guard is part of
    // what these tests verify, not something they get to fake.
    wabaFieldsChanged: actual.wabaFieldsChanged,
    submitTemplateForApproval: (...args: unknown[]) => submitMock(...args),
  }
})

import { PUT } from "./route"
import { logAudit } from "@/lib/audit"

/** A stored row as Prisma would return it after the upsert. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl1",
    tenantId: "t1",
    event: "loan_approved",
    channel: "WHATSAPP",
    body: "Hi {{firstName}}, your loan is approved.",
    active: true,
    wabaTemplateName: "loan_approved",
    language: "en",
    category: "TRANSACTIONAL",
    key: "loan_approved_whatsapp",
    headerType: null,
    headerContent: null,
    bodyTemplate: "Hi {{firstName}}, your loan is approved.",
    footer: null,
    buttons: null,
    providerStatus: null,
    providerTemplateId: null,
    createdAt: new Date("2026-07-25T08:00:00Z"),
    updatedAt: new Date("2026-07-25T08:00:00Z"),
    ...overrides,
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    event: "loan_approved",
    wabaTemplateName: "loan_approved",
    language: "en",
    category: "TRANSACTIONAL",
    bodyTemplate: "Hi {{firstName}}, your loan is approved.",
    ...overrides,
  }
}

function put(body: unknown) {
  const init: ConstructorParameters<typeof NextRequest>[1] = { method: "PUT" }
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body)
  return PUT(new NextRequest("http://x/api/settings/notifications/waba", init))
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
  findUniqueMock.mockResolvedValue(null)
  upsertMock.mockImplementation(async () => row())
  submitMock.mockResolvedValue({ submitted: true, providerStatus: "PENDING" })
})

describe("authorisation", () => {
  it("is ADMIN-guarded and writes nothing when the guard rejects", async () => {
    const { NextResponse } = await import("next/server")
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    const res = await put(payload())
    expect(res.status).toBe(403)
    expect(upsertMock).not.toHaveBeenCalled()
    expect(submitMock).not.toHaveBeenCalled()
  })

  // The sibling sms/email route sits at the LOAN_ADMIN floor. Authoring a
  // template that goes to Meta for approval is an ADMIN act; assert the
  // argument so a silent downgrade fails here rather than in review.
  it("requires ADMIN, not the LOAN_ADMIN floor the sibling template route uses", async () => {
    await put(payload())
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
  })
})

describe("input validation", () => {
  it("rejects a non-JSON body with 400", async () => {
    const res = await put("not-json")
    expect(res.status).toBe(400)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("requires an event key", async () => {
    const res = await put(payload({ event: "  " }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/event/i)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects a template name Meta would refuse", async () => {
    const res = await put(payload({ wabaTemplateName: "Loan Approved" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/lowercase/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects a malformed language code", async () => {
    const res = await put(payload({ language: "en-GB" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/locale/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  // A blank language used to default to "en" here while the editor blocked the
  // save — registering a template in a language nobody picked.
  it("requires a language rather than defaulting a blank one", async () => {
    const res = await put(payload({ language: "" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/required/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  // A nameless row can never register, and the submit gate skips it silently.
  it("requires a Meta template name", async () => {
    const res = await put(payload({ wabaTemplateName: "" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/required/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("requires a category, because a null one refuses every send", async () => {
    const res = await put(payload({ category: undefined }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/category/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("refuses MARKETING, which needs a consent purpose this editor cannot set", async () => {
    const res = await put(payload({ category: "MARKETING" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/category/)
    expect(upsertMock).not.toHaveBeenCalled()
  })
})

describe("never stores a template that cannot register", () => {
  it("rejects a literal positional placeholder with the builder's own message", async () => {
    const res = await put(payload({ bodyTemplate: "Hi {{1}}, your loan is approved." }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/literal positional placeholder/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects malformed placeholder braces", async () => {
    const res = await put(payload({ bodyTemplate: "Hi {{{firstName}}}" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/malformed placeholder braces/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects an empty body", async () => {
    const res = await put(payload({ bodyTemplate: "   " }))
    expect(res.status).toBe(400)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects a footer containing a variable", async () => {
    const res = await put(payload({ footer: "Ref {{loanRef}}" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/footer/i)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects a header with more than one variable", async () => {
    const res = await put(payload({ headerContent: "{{a}} and {{b}}" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/one variable/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects a http:// button url", async () => {
    const res = await put(payload({ buttons: [{ type: "URL", text: "Pay", url: "http://x.co.za" }] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/https/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects a button url whose variable is not at the end", async () => {
    const res = await put(payload({
      buttons: [{ type: "URL", text: "Pay", url: "https://x.co.za/{{ref}}/pay" }],
    }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/end of the url/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects an over-long button label", async () => {
    const res = await put(payload({
      buttons: [{ type: "QUICK_REPLY", text: "x".repeat(26) }],
    }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/26 characters/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("rejects more than one phone-number button", async () => {
    const res = await put(payload({
      buttons: [
        { type: "PHONE_NUMBER", text: "Call", phoneNumber: "27110000000" },
        { type: "PHONE_NUMBER", text: "Call 2", phoneNumber: "27110000001" },
      ],
    }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/phone-number buttons/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("accepts the full documented buttons contract", async () => {
    const buttons = [
      { type: "QUICK_REPLY", text: "Yes" },
      { type: "QUICK_REPLY", text: "No" },
      { type: "URL", text: "Pay now", url: "https://acme-lending.example/pay/{{ref}}" },
      { type: "PHONE_NUMBER", text: "Call us", phoneNumber: "27110000000" },
    ]
    const res = await put(payload({ buttons }))
    expect(res.status).toBe(200)
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ buttons }) }),
    )
  })
})

describe("persistence", () => {
  it("writes every WABA column, tenant-scoped on the WHATSAPP channel", async () => {
    await put(payload({
      headerContent: "Loan {{loanRef}}",
      footer: "Acme Lending",
      language: "af",
      active: false,
    }))
    const arg = upsertMock.mock.calls[0][0]
    expect(arg.where).toEqual({
      tenantId_event_channel: { tenantId: "t1", event: "loan_approved", channel: "WHATSAPP" },
    })
    expect(arg.create).toMatchObject({
      tenantId: "t1",
      event: "loan_approved",
      channel: "WHATSAPP",
      wabaTemplateName: "loan_approved",
      language: "af",
      headerType: "TEXT",
      headerContent: "Loan {{loanRef}}",
      bodyTemplate: "Hi {{firstName}}, your loan is approved.",
      footer: "Acme Lending",
      active: false,
    })
    expect(arg.update).toMatchObject({
      wabaTemplateName: "loan_approved",
      language: "af",
      headerContent: "Loan {{loanRef}}",
      footer: "Acme Lending",
      active: false,
    })
    // The update branch must never move the row to another tenant or event.
    expect(arg.update.tenantId).toBeUndefined()
    expect(arg.update.event).toBeUndefined()
    expect(arg.update.channel).toBeUndefined()
  })

  // The dispatcher resolves templates by `key`, not by (event, channel).
  // A null-keyed row is invisible to it AND its missing-template guard aborts
  // the whole event, so the matching email and SMS sends die with it.
  it("derives the dispatcher key so a new template is reachable at send time", async () => {
    await put(payload({ event: "loan_disbursed" }))
    const arg = upsertMock.mock.calls[0][0]
    expect(arg.create.key).toBe("loan_disbursed_whatsapp")
  })

  it("fills a null key on an existing row", async () => {
    findUniqueMock.mockResolvedValue(row({ key: null }))
    await put(payload({ event: "loan_disbursed" }))
    expect(upsertMock.mock.calls[0][0].update.key).toBe("loan_disbursed_whatsapp")
  })

  // A blank key is as unreachable as a null one and cannot be deliberate, so it
  // is repaired too — `??` would have preserved it.
  it("fills a blank key on an existing row", async () => {
    findUniqueMock.mockResolvedValue(row({ key: "" }))
    await put(payload({ event: "loan_disbursed" }))
    expect(upsertMock.mock.calls[0][0].update.key).toBe("loan_disbursed_whatsapp")
  })

  // A seeded key does NOT always follow `<event>_whatsapp`: the collections
  // reminder row is event `payment_reminder_sent` keyed `payment_reminder_whatsapp`,
  // and lib/collections/reminders.ts resolves it by that literal — a miss aborts
  // the whole reminder cron, SMS leg included. Re-deriving it on save would stop
  // every arrears reminder silently.
  it("NEVER re-derives an existing key whose seeded value differs from the event", async () => {
    findUniqueMock.mockResolvedValue(
      row({ event: "payment_reminder_sent", key: "payment_reminder_whatsapp" }),
    )
    await put(payload({ event: "payment_reminder_sent" }))
    expect(upsertMock.mock.calls[0][0].update.key).toBe("payment_reminder_whatsapp")
  })

  it("stores the category that selects the consent lane", async () => {
    await put(payload({ category: "SERVICE" }))
    const arg = upsertMock.mock.calls[0][0]
    expect(arg.create.category).toBe("SERVICE")
    expect(arg.update.category).toBe("SERVICE")
  })

  it("returns 409 rather than a 500 when the derived key is already taken", async () => {
    const { Prisma } = await import("@prisma/client")
    upsertMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" }),
    )
    const res = await put(payload())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/loan_approved_whatsapp/)
  })

  it("keeps the legacy body column in step with bodyTemplate", async () => {
    await put(payload({ bodyTemplate: "New copy {{firstName}}" }))
    const arg = upsertMock.mock.calls[0][0]
    expect(arg.create.body).toBe("New copy {{firstName}}")
    expect(arg.update.body).toBe("New copy {{firstName}}")
  })

  it("clears headerType when the header is removed", async () => {
    await put(payload({ headerContent: "" }))
    const arg = upsertMock.mock.calls[0][0]
    expect(arg.update.headerContent).toBeNull()
    expect(arg.update.headerType).toBeNull()
  })

  it("reads the prior row scoped to the tenant for the change guard", async () => {
    await put(payload())
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { tenantId_event_channel: { tenantId: "t1", event: "loan_approved", channel: "WHATSAPP" } },
    })
  })

  it("audits the write with the template id", async () => {
    await put(payload())
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      userEmail: "a@b.c",
      entity: "MessageTemplate",
      entityId: "tpl1",
    }))
  })

  // `key` decides whether the dispatcher can reach the template at all, so a
  // change to it must be recoverable from the audit row.
  it("records the key on both sides of the audit", async () => {
    findUniqueMock.mockResolvedValue(row({ key: null }))
    await put(payload({ event: "loan_disbursed" }))
    const audit = vi.mocked(logAudit).mock.calls[0][0]
    expect(audit.oldValue).toMatchObject({ key: null })
    expect(audit.newValue).toMatchObject({ key: "loan_disbursed_whatsapp" })
  })

  it("audits before submitting to Meta, so a Graph hang cannot lose the evidence", async () => {
    const order: string[] = []
    vi.mocked(logAudit).mockImplementation(async () => { order.push("audit") })
    submitMock.mockImplementation(async () => { order.push("submit"); return { submitted: true } })
    await put(payload())
    expect(order).toEqual(["audit", "submit"])
  })
})

describe("auto-submit", () => {
  it("submits when a Meta-review-relevant field changed", async () => {
    findUniqueMock.mockResolvedValue(row({ bodyTemplate: "Old copy" }))
    const res = await put(payload())
    expect(submitMock).toHaveBeenCalledWith("t1", "tpl1")
    expect((await res.json()).submit).toMatchObject({ attempted: true, ok: true })
  })

  it("does not resubmit an already-registered template when nothing review-relevant changed", async () => {
    const registered = row({ providerTemplateId: "meta-1", providerStatus: "APPROVED" })
    findUniqueMock.mockResolvedValue(registered)
    upsertMock.mockResolvedValue({ ...registered, active: false })
    const res = await put(payload({ active: false }))
    expect(submitMock).not.toHaveBeenCalled()
    expect((await res.json()).submit).toMatchObject({ attempted: false, reason: "unchanged" })
  })

  // The regression that made the whole feature undeliverable: the first submit
  // always fails today (WABA_ENC_KEY is unset), and a change-only gate makes
  // every later save a no-op — the template could never be registered at all.
  it("retries a template that has never registered, even when nothing changed", async () => {
    const unregistered = row({ providerTemplateId: null })
    findUniqueMock.mockResolvedValue(unregistered)
    upsertMock.mockResolvedValue(unregistered)
    const res = await put(payload())
    expect(submitMock).toHaveBeenCalledWith("t1", "tpl1")
    expect((await res.json()).submit).toMatchObject({ attempted: true, ok: true, reason: "submitted" })
  })

  // createWabaTemplate falls back to `id: ""` when Meta omits one. Treating a
  // blank id as "never registered" would re-CREATE an APPROVED template on
  // every save and collect a "name already exists" rejection each time.
  it("does not resubmit an approved template whose stored provider id is blank", async () => {
    const approvedBlankId = row({ providerTemplateId: "", providerStatus: "APPROVED" })
    findUniqueMock.mockResolvedValue(approvedBlankId)
    upsertMock.mockResolvedValue(approvedBlankId)
    const res = await put(payload())
    expect(submitMock).not.toHaveBeenCalled()
    expect((await res.json()).submit).toMatchObject({ attempted: false, reason: "unchanged" })
  })

  it("distinguishes a benign no-op from a failure so the UI cannot report both as success", async () => {
    const registered = row({ providerTemplateId: "meta-1" })
    findUniqueMock.mockResolvedValue(registered)
    upsertMock.mockResolvedValue(registered)
    const unchanged = await put(payload())
    expect((await unchanged.json()).submit.reason).toBe("unchanged")

    vi.clearAllMocks()
    findUniqueMock.mockResolvedValue(row({ providerTemplateId: null }))
    upsertMock.mockResolvedValue(row({ providerTemplateId: null }))
    submitMock.mockRejectedValue(new Error("WABA_ENC_KEY is not set"))
    const failed = await put(payload())
    expect((await failed.json()).submit.reason).toBe("rejected")
  })

  it("returns the post-submit row so the operator sees PENDING and the provider id", async () => {
    upsertMock.mockResolvedValue(row())
    findUniqueMock
      .mockResolvedValueOnce(null) // the change-guard read
      .mockResolvedValueOnce(row({ providerStatus: "PENDING", providerTemplateId: "meta-1" }))
    const res = await put(payload())
    const json = await res.json()
    expect(json.template.providerStatus).toBe("PENDING")
    expect(json.template.providerTemplateId).toBe("meta-1")
  })

  it("saves successfully even when Meta rejects the submission, and says why", async () => {
    submitMock.mockRejectedValue(new Error("WhatsApp Cloud template create 400: name already exists"))
    const res = await put(payload())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.template.id).toBe("tpl1")
    expect(json.submit).toMatchObject({ attempted: true, ok: false })
    expect(json.submit.error).toMatch(/name already exists/)
    expect(logAudit).toHaveBeenCalled()
  })
})
