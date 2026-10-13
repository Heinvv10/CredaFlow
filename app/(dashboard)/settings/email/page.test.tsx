/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

// The page reads with the SESSION's tenant (lib/session-tenant.ts, real here)
// — not the request host's (getResolvedTenantId) or the deployment default.
// All three differ below, so reading with either of the others fails.
const { requireMinRole, getSession, emailConfigFindUnique } = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  getSession: vi.fn(),
  emailConfigFindUnique: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireMinRole, redirectStaleSession: vi.fn() }))
vi.mock("@/lib/auth-session", () => ({ getSession }))
vi.mock("@/lib/tenant", () => ({
  getResolvedTenantId: vi.fn(async () => "tenant-host"),
  getDefaultTenantId: vi.fn(async () => "tenant-default"),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { emailConfig: { findUnique: emailConfigFindUnique } } }))
vi.mock("@/components/email/EmailConfigForm", () => ({ EmailConfigForm: () => null }))

import EmailSettingsPage from "./page"

function textOf(node: any): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  return textOf(node.props?.children)
}

beforeEach(() => {
  vi.clearAllMocks()
  requireMinRole.mockResolvedValue(undefined)
  getSession.mockResolvedValue({ user: { id: "u1", role: "ADMIN", tenantId: "tenant-session" } })
  emailConfigFindUnique.mockResolvedValue(null)
})

describe("/settings/email tenant", () => {
  it("reads the session tenant's mail configuration, not the host's or the default's", async () => {
    await EmailSettingsPage()
    expect(emailConfigFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-session" } }))
  })
})

describe("/settings/email guard", () => {
  it("requires ADMIN before rendering anything", async () => {
    await EmailSettingsPage()
    expect(requireMinRole).toHaveBeenCalledWith("ADMIN")
  })

  it("does not render when the guard throws", async () => {
    requireMinRole.mockRejectedValue(new Error("redirect"))
    await expect(EmailSettingsPage()).rejects.toThrow()
    expect(emailConfigFindUnique).not.toHaveBeenCalled()
  })
})

describe("/settings/email poll status", () => {
  it("says 'never' when no poll has run — not 'OK'", async () => {
    emailConfigFindUnique.mockResolvedValue({ lastPollAt: null, lastPollOk: null, lastPollError: null })
    const text = textOf(await EmailSettingsPage())
    expect(text).toContain("Last poll: never")
    expect(text).not.toContain("— OK")
  })

  it("renders OK with a SAST time on a successful poll", async () => {
    emailConfigFindUnique.mockResolvedValue({
      lastPollAt: new Date("2026-08-27T06:00:00Z"),
      lastPollOk: true,
      lastPollError: null,
    })
    const text = textOf(await EmailSettingsPage())
    expect(text).toContain("Last poll:")
    expect(text).toContain("OK")
    // 06:00 UTC is 08:00 SAST.
    expect(text).toMatch(/08:00/)
  })

  it("renders FAILED with the stored error on a failed poll", async () => {
    emailConfigFindUnique.mockResolvedValue({
      lastPollAt: new Date("2026-08-27T06:00:00Z"),
      lastPollOk: false,
      lastPollError: "wrong version number",
    })
    const text = textOf(await EmailSettingsPage())
    expect(text).toContain("FAILED: wrong version number")
    expect(text).not.toContain("— OK")
  })

  it("never renders a secret column", async () => {
    // The page selects only the poll fields; assert the select is narrow.
    await EmailSettingsPage()
    const select = emailConfigFindUnique.mock.calls[0][0].select
    expect(Object.keys(select).sort()).toEqual(["lastPollAt", "lastPollError", "lastPollOk"])
  })
})
