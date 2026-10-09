/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: vi.fn() } } }))

import { isCommsAgentAllowed, requireCommsAgent } from "./authz"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

beforeEach(() => vi.clearAllMocks())

describe("isCommsAgentAllowed", () => {
  it("allows a flagged non-admin agent", () => {
    expect(isCommsAgentAllowed("COLLECTIONS_AGENT", true)).toBe(true)
  })
  it("allows an admin without the flag", () => {
    expect(isCommsAgentAllowed("ADMIN", false)).toBe(true)
    expect(isCommsAgentAllowed("SUPER_ADMIN", false)).toBe(true)
  })
  it("denies an unflagged non-admin", () => {
    expect(isCommsAgentAllowed("READONLY", false)).toBe(false)
  })
  it("denies a CLIENT even if flagged", () => {
    expect(isCommsAgentAllowed("CLIENT", true)).toBe(false)
  })
})

describe("requireCommsAgent", () => {
  it("401 when there is no session", async () => {
    vi.mocked(auth).mockResolvedValue(null as any)
    const g = await requireCommsAgent()
    expect(g.error?.status).toBe(401)
  })
  it("403 for a staff user who is not a comms agent", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "READONLY", email: "a@b.c", name: "A" } } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ isCommsAgent: false } as any)
    const g = await requireCommsAgent()
    expect(g.error?.status).toBe(403)
  })
  it("passes a flagged agent and returns the session user", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "COLLECTIONS_AGENT", email: "a@b.c", name: "A" } } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ isCommsAgent: true } as any)
    const g = await requireCommsAgent()
    expect(g.error).toBeUndefined()
    expect(g.user?.id).toBe("u1")
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { isCommsAgent: true } })
  })
  it("passes an admin without a DB flag lookup being decisive", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u2", role: "ADMIN", email: "x@y.z", name: "X" } } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ isCommsAgent: false } as any)
    const g = await requireCommsAgent()
    expect(g.user?.id).toBe("u2")
  })
})
