import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  leadCreate: vi.fn(),
  activityCreate: vi.fn(),
  clientCreate: vi.fn(),
  clientFindFirst: vi.fn(),
  auditLogCreate: vi.fn(),
  getTenantFromRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  verifyTurnstile: vi.fn(),
  logAudit: vi.fn(),
}))

const tx = {
  lead: { create: mocks.leadCreate },
  crmActivity: { create: mocks.activityCreate },
  auditLog: { create: mocks.auditLogCreate },
  client: { create: mocks.clientCreate, findFirst: mocks.clientFindFirst },
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // Invokes the callback with a fake tx. This is enough to prove the route
    // ROUTES its writes through the transaction callback (the mocked tx is
    // unreachable otherwise), but it cannot simulate rollback — mocked Prisma
    // never sees transactional behaviour. Atomicity itself is Postgres's job.
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    lead: { create: mocks.leadCreate },
    crmActivity: { create: mocks.activityCreate },
    // Exposed so the test can prove the route never touches them.
    client: { create: mocks.clientCreate, findFirst: mocks.clientFindFirst },
  },
}))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: mocks.getTenantFromRequest }))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  callerIp: () => "203.0.113.9",
}))

// The duplicate notice is deferred via deferAfterResponse. Left unmocked it
// runs unawaited against this file's partial prisma mock, so a rejection lands
// mid-way through a LATER test — swallowed, but real cross-test noise. Mocked
// to a no-op: this file is not testing the notice.
vi.mock("@/lib/http/after-response", () => ({
  deferAfterResponse: () => {},
}))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { AuditAction: actual.AuditAction, logAudit: mocks.logAudit }
})

import { POST } from "./route"
import type { NextRequest } from "next/server"

const VALID = {
  name: "Thandi Mokoena",
  phone: "0712345678",
  email: "thandi@example.test",
  coverType: "MOTOR",
  consent: true,
  turnstileToken: "tok",
}

function call(body: Record<string, unknown> = VALID) {
  return POST({
    json: async () => body,
    headers: new Headers(),
  } as unknown as NextRequest)
}

describe("website insurance enquiry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkRateLimit.mockReturnValue({ allowed: true })
    mocks.verifyTurnstile.mockResolvedValue({ ok: true })
    mocks.getTenantFromRequest.mockResolvedValue({ id: "tenant-1" })
    mocks.leadCreate.mockResolvedValue({ id: "lead-1" })
    mocks.activityCreate.mockResolvedValue({ id: "act-1" })
    mocks.auditLogCreate.mockResolvedValue({ id: "audit-1" })
  })

  it("captures a valid enquiry as a lead", async () => {
    const res = await call()

    expect(res.status).toBe(200)
    expect(mocks.leadCreate).toHaveBeenCalledOnce()
    expect(mocks.leadCreate.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1",
      firstName: "Thandi",
      lastName: "Mokoena",
      phone: "0712345678",
      source: "WEBSITE",
      status: "NEW",
    })
  })

  // The security invariant. app/api/website/apply/route.ts only links a Client
  // when BOTH email and ID number resolve to the same existing one, because an
  // anonymous caller knowing one real value must not be able to overwrite a
  // real client's PII. This form collects no ID number, so it must never touch
  // the Client table at all.
  it("never creates or looks up a Client from an anonymous submission", async () => {
    await call()

    expect(mocks.clientCreate).not.toHaveBeenCalled()
    expect(mocks.clientFindFirst).not.toHaveBeenCalled()
  })

  // POPIA: the consent is the lawful basis for holding the details.
  it("refuses to store anything without contact consent", async () => {
    const res = await call({ ...VALID, consent: false })

    expect(res.status).toBe(400)
    expect(mocks.leadCreate).not.toHaveBeenCalled()
    expect(mocks.auditLogCreate).not.toHaveBeenCalled()
  })

  it("treats a missing consent field as refusal rather than as agreement", async () => {
    const body = { ...VALID }
    delete (body as Record<string, unknown>).consent

    const res = await call(body)

    expect(res.status).toBe(400)
    expect(mocks.leadCreate).not.toHaveBeenCalled()
  })

  // A truthy-but-not-true value must not pass as consent.
  it("does not accept a non-boolean truthy value as consent", async () => {
    const res = await call({ ...VALID, consent: "yes" })

    expect(res.status).toBe(400)
    expect(mocks.leadCreate).not.toHaveBeenCalled()
  })

  // The consent evidence must commit with the enquiry, not after it. logAudit()
  // swallows failures, so using it here would allow a Lead to persist with no
  // record that consent was ever given.
  it("writes the consent evidence inside the same transaction as the lead", async () => {
    await call()

    expect(mocks.auditLogCreate).toHaveBeenCalledOnce()
    expect(mocks.auditLogCreate.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1",
      action: "INSURANCE_ENQUIRY_CAPTURED",
      entity: "Lead",
      entityId: "lead-1",
      ipAddress: "203.0.113.9",
      newValue: expect.objectContaining({ contactConsent: true, coverType: "MOTOR" }),
    })
    // Not via the swallow-on-failure helper.
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  // Proves the RESPONSE contract only: a failed consent write must not be
  // reported as success. It does NOT prove the Lead is rolled back — the
  // $transaction mock below just invokes the callback, so no mocked Prisma can
  // demonstrate rollback. That guarantee comes from Postgres and is only
  // observable against a real database.
  it("does not report success when the consent evidence cannot be written", async () => {
    mocks.auditLogCreate.mockRejectedValue(new Error("db down"))

    const res = await call()
    const body = (await res.json()) as { success?: boolean }

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
  })

  it("caps oversized input rather than writing an unbounded row", async () => {
    expect((await call({ ...VALID, name: "x".repeat(121) })).status).toBe(400)
    expect((await call({ ...VALID, phone: "9".repeat(33) })).status).toBe(400)
    expect((await call({ ...VALID, email: `${"e".repeat(250)}@x.test` })).status).toBe(400)
    expect(mocks.leadCreate).not.toHaveBeenCalled()
  })

  it("resolves a differently-cased cover type instead of silently downgrading it", async () => {
    await call({ ...VALID, coverType: "home" })

    expect(mocks.leadCreate.mock.calls[0][0].data.tags).toContain("cover:home")
  })

  it("rejects a failed Turnstile challenge before writing anything", async () => {
    mocks.verifyTurnstile.mockResolvedValue({ ok: false })

    const res = await call()

    expect(res.status).toBe(400)
    expect(mocks.leadCreate).not.toHaveBeenCalled()
  })

  it("rate-limits by caller IP", async () => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 })

    const res = await call()

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("60")
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled()
    expect(mocks.leadCreate).not.toHaveBeenCalled()
  })

  it("requires a name and a phone number", async () => {
    expect((await call({ ...VALID, name: "" })).status).toBe(400)
    expect((await call({ ...VALID, phone: "" })).status).toBe(400)
    expect(mocks.leadCreate).not.toHaveBeenCalled()
  })

  // An unrecognised coverType must not reach the DB verbatim.
  it("normalises an unknown cover type instead of storing it", async () => {
    await call({ ...VALID, coverType: "<script>alert(1)</script>" })

    const tags = mocks.leadCreate.mock.calls[0][0].data.tags as string[]
    expect(tags).toContain("cover:other")
    expect(tags.join(" ")).not.toContain("script")
  })

  it("tags the lead so staff can find insurance enquiries", async () => {
    await call()

    expect(mocks.leadCreate.mock.calls[0][0].data.tags).toContain("insurance-enquiry")
  })
})
