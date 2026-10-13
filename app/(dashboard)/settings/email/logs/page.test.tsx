/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

// The page reads with the SESSION's tenant (lib/session-tenant.ts, real here)
// — not the request host's (getResolvedTenantId) or the deployment default.
// All three differ below, so reading with either of the others fails.
const { requireMinRole, getSession, emailLogFindMany } = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  getSession: vi.fn(),
  emailLogFindMany: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireMinRole, redirectStaleSession: vi.fn() }))
vi.mock("@/lib/auth-session", () => ({ getSession }))
vi.mock("@/lib/tenant", () => ({
  getResolvedTenantId: vi.fn(async () => "tenant-host"),
  getDefaultTenantId: vi.fn(async () => "tenant-default"),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { emailLog: { findMany: emailLogFindMany } } }))

import EmailLogsPage from "./page"

function textOf(node: any): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  return textOf(node.props?.children)
}

function log(status: string, id: string) {
  return {
    id, status, toAddress: "c@example.com", toName: null, subject: "s",
    category: "general", createdAt: new Date("2026-08-27T06:00:00Z"), sentAt: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireMinRole.mockResolvedValue(undefined)
  getSession.mockResolvedValue({ user: { id: "u1", role: "ADMIN", tenantId: "tenant-session" } })
  emailLogFindMany.mockResolvedValue([])
})

describe("/settings/email/logs", () => {
  it("reads the session tenant's log, not the host's or the default's", async () => {
    await EmailLogsPage()
    expect(emailLogFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-session" } }))
  })

  it("requires ADMIN", async () => {
    await EmailLogsPage()
    expect(requireMinRole).toHaveBeenCalledWith("ADMIN")
  })

  it("counts BLOCKED rows and labels them", async () => {
    emailLogFindMany.mockResolvedValue([
      log("SENT", "1"), log("BLOCKED", "2"), log("BLOCKED", "3"), log("FAILED", "4"),
    ])
    const text = textOf(await EmailLogsPage())
    expect(text).toContain("BLOCKED")

    // The stat tile renders <p>{count}</p><p>Blocked</p>, so the text walker
    // yields "2Blocked". Asserting the count next to its label is what a
    // label-only assertion cannot do: a tile stuck at 0 would still show
    // "Blocked".
    expect(text).toContain("2Blocked")
  })
})
